import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  rename,
  stat,
  unlink,
  utimes,
} from "node:fs/promises";
import path from "node:path";

export const AIVIS_CACHE_FORMAT_VERSION = 1;
const STALE_TEMP_FILE_MS = 60 * 60 * 1_000;
const CACHE_FILE_PATTERN = /^[a-f0-9]{64}\.wav$/u;
const TEMP_FILE_PATTERN = /^\.[a-f0-9]{64}\.\d+\.[0-9a-f-]{36}\.tmp$/u;

export interface AivisAudioCacheConfig {
  readonly enabled: boolean;
  readonly directory: string;
  readonly maxBytes: number;
}

export interface AivisAudioCacheResult {
  readonly audio: Uint8Array;
  readonly status: "hit" | "miss" | "disabled";
}

export function isRiffWave(bytes: Uint8Array): boolean {
  if (
    bytes.byteLength < 44
    || bytes[0] !== 0x52
    || bytes[1] !== 0x49
    || bytes[2] !== 0x46
    || bytes[3] !== 0x46
    || bytes[8] !== 0x57
    || bytes[9] !== 0x41
    || bytes[10] !== 0x56
    || bytes[11] !== 0x45
  ) return false;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.byteLength) return false;

  let offset = 12;
  let hasFormat = false;
  let hasAudioData = false;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) return false;
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataStart = offset + 8;
    const chunkDataEnd = chunkDataStart + chunkSize;
    const paddedChunkEnd = chunkDataEnd + (chunkSize % 2);
    if (
      !Number.isSafeInteger(chunkDataEnd)
      || chunkDataEnd > bytes.byteLength
      || paddedChunkEnd > bytes.byteLength
    ) return false;

    const chunkId = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3],
    );
    if (chunkId === "fmt ") {
      if (chunkSize < 16) return false;
      const format = view.getUint16(chunkDataStart, true);
      const channels = view.getUint16(chunkDataStart + 2, true);
      const sampleRate = view.getUint32(chunkDataStart + 4, true);
      const byteRate = view.getUint32(chunkDataStart + 8, true);
      const blockAlign = view.getUint16(chunkDataStart + 12, true);
      const bitsPerSample = view.getUint16(chunkDataStart + 14, true);
      if (!format || !channels || !sampleRate || !byteRate || !blockAlign || !bitsPerSample) {
        return false;
      }
      hasFormat = true;
    } else if (chunkId === "data") {
      if (chunkSize < 1) return false;
      hasAudioData = true;
    }
    offset = paddedChunkEnd;
  }
  return offset === bytes.byteLength && hasFormat && hasAudioData;
}

export function createAivisCacheKey(document: unknown): string {
  return createHash("sha256").update(JSON.stringify(document)).digest("hex");
}

interface CacheEntry {
  readonly filePath: string;
  readonly size: number;
  readonly modifiedAt: number;
}

export class AivisAudioCache {
  readonly #enabled: boolean;
  readonly #directory: string;
  readonly #maxBytes: number;
  readonly #inFlight = new Map<string, Promise<Uint8Array>>();
  #prunePromise: Promise<void> | null = null;
  #pruneRequested = false;

  constructor(config: AivisAudioCacheConfig) {
    if (!path.isAbsolute(config.directory)) {
      throw new TypeError("Aivis cache directory must be absolute.");
    }
    if (!Number.isSafeInteger(config.maxBytes) || config.maxBytes < 1) {
      throw new RangeError("Aivis cache size must be a positive integer.");
    }
    this.#enabled = config.enabled;
    this.#directory = config.directory;
    this.#maxBytes = config.maxBytes;
  }

  async getOrCreate(
    key: string,
    create: () => Promise<Uint8Array>,
  ): Promise<AivisAudioCacheResult> {
    this.#validateKey(key);

    if (this.#enabled) {
      const cached = await this.#read(key);
      if (cached) return { audio: cached, status: "hit" };
    }

    const existing = this.#inFlight.get(key);
    if (existing) {
      return {
        audio: await existing,
        status: this.#enabled ? "miss" : "disabled",
      };
    }

    const generated = (async () => {
      const audio = await create();
      if (!isRiffWave(audio)) {
        throw new TypeError("Aivis cache only accepts valid RIFF/WAVE audio.");
      }
      if (this.#enabled) await this.#writeBestEffort(key, audio);
      return audio;
    })();
    this.#inFlight.set(key, generated);
    try {
      return {
        audio: await generated,
        status: this.#enabled ? "miss" : "disabled",
      };
    } finally {
      if (this.#inFlight.get(key) === generated) this.#inFlight.delete(key);
    }
  }

  async #read(key: string): Promise<Uint8Array | null> {
    const filePath = this.#pathFor(key);
    try {
      const handle = await open(filePath, "r");
      try {
        const buffer = await handle.readFile();
        const bytes = new Uint8Array(buffer);
        if (!isRiffWave(bytes)) {
          await handle.close();
          await unlink(filePath).catch(() => undefined);
          return null;
        }
        const now = new Date();
        await utimes(filePath, now, now).catch(() => undefined);
        return bytes;
      } finally {
        await handle.close().catch(() => undefined);
      }
    } catch {
      return null;
    }
  }

  async #writeBestEffort(key: string, audio: Uint8Array): Promise<void> {
    const target = this.#pathFor(key);
    const temporary = path.join(
      this.#directory,
      `.${key}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(audio);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
      await this.#schedulePrune();
    } catch {
      await unlink(temporary).catch(() => undefined);
      // Cache I/O must never make otherwise valid speech synthesis fail.
    }
  }

  #schedulePrune(): Promise<void> {
    this.#pruneRequested = true;
    if (!this.#prunePromise) {
      this.#prunePromise = this.#drainPruneRequests();
    }
    return this.#prunePromise;
  }

  async #drainPruneRequests(): Promise<void> {
    try {
      do {
        this.#pruneRequested = false;
        await this.#prune();
      } while (this.#pruneRequested);
    } finally {
      this.#prunePromise = null;
      // A write can finish after the loop condition is checked but before the
      // promise's finally continuation runs. Carry that request into a fresh
      // drain and keep existing callers waiting for it.
      if (this.#pruneRequested) await this.#schedulePrune();
    }
  }

  async #prune(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.#directory);
    } catch {
      return;
    }

    const staleBefore = Date.now() - STALE_TEMP_FILE_MS;
    await Promise.all(names.filter((name) => TEMP_FILE_PATTERN.test(name)).map(async (name) => {
      const temporary = path.join(this.#directory, name);
      try {
        const info = await stat(temporary);
        if (info.isFile() && info.mtimeMs <= staleBefore) await unlink(temporary);
      } catch {
        // The creating process may still own or may already have removed it.
      }
    }));

    const cacheNames = names.filter((name) => CACHE_FILE_PATTERN.test(name));

    const entries = (await Promise.all(cacheNames.map(async (name): Promise<CacheEntry | null> => {
      const filePath = path.join(this.#directory, name);
      try {
        const info = await stat(filePath);
        return info.isFile()
          ? { filePath, size: info.size, modifiedAt: info.mtimeMs }
          : null;
      } catch {
        return null;
      }
    }))).filter((entry): entry is CacheEntry => entry !== null);

    let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (totalBytes <= this.#maxBytes) return;
    entries.sort((left, right) => left.modifiedAt - right.modifiedAt);
    for (const entry of entries) {
      if (totalBytes <= this.#maxBytes) break;
      try {
        await unlink(entry.filePath);
        totalBytes -= entry.size;
      } catch {
        // Another request may have removed the same cache entry.
      }
    }
  }

  #pathFor(key: string): string {
    return path.join(this.#directory, `${key}.wav`);
  }

  #validateKey(key: string): void {
    if (!/^[a-f0-9]{64}$/u.test(key)) {
      throw new TypeError("Aivis cache key must be a SHA-256 digest.");
    }
  }
}
