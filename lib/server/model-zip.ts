import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const MAX_ZIP_COMMENT_BYTES = 65_535;
const ZIP64_UINT16 = 0xffff;
const ZIP64_UINT32 = 0xffffffff;

export class ZipSafetyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ZipSafetyError";
  }
}

export interface ZipExtractionLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxExtractedBytes: number;
  maxCentralDirectoryBytes?: number;
  maxEntryNameBytes?: number;
}

export interface ZipEntryMetadata {
  path: string;
  directory: boolean;
  compressedSize: number;
  uncompressedSize: number;
}

export interface ExtractZipOptions extends ZipExtractionLimits {
  select?: (entry: ZipEntryMetadata) => string | null;
}

interface ZipEntry extends ZipEntryMetadata {
  flags: number;
  compressionMethod: number;
  crc32: number;
  localHeaderOffset: number;
  rawName: Buffer;
  symlink: boolean;
  unsafeUnixType: boolean;
}

interface SelectedEntry {
  entry: ZipEntry;
  relativePath: string;
  parts: string[];
  key: string;
}

interface CentralDirectory {
  entries: ZipEntry[];
  offset: number;
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function updateCrc32(crc: number, chunk: Buffer): number {
  let value = crc;
  for (const byte of chunk) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return value >>> 0;
}

class EntryVerifier extends Transform {
  readonly expectedBytes: number;
  readonly expectedCrc32: number;
  bytes = 0;
  crc = 0xffffffff;

  constructor(expectedBytes: number, expectedCrc32: number) {
    super();
    this.expectedBytes = expectedBytes;
    this.expectedCrc32 = expectedCrc32 >>> 0;
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.expectedBytes) {
      callback(new ZipSafetyError("zip entry expanded beyond its declared size"));
      return;
    }
    this.crc = updateCrc32(this.crc, chunk);
    this.push(chunk);
    callback();
  }

  verify(): void {
    if (this.bytes !== this.expectedBytes) {
      throw new ZipSafetyError("zip entry size did not match the central directory");
    }
    const actual = (this.crc ^ 0xffffffff) >>> 0;
    if (actual !== this.expectedCrc32) {
      throw new ZipSafetyError("zip entry failed its CRC-32 integrity check");
    }
  }
}

function decodeEntryName(rawName: Buffer, utf8: boolean): string {
  if (!utf8 && rawName.some((byte) => byte >= 0x80)) {
    throw new ZipSafetyError("non-UTF-8 zip entry names must be ASCII");
  }
  try {
    return new TextDecoder(utf8 ? "utf-8" : "ascii", { fatal: true }).decode(rawName);
  } catch (error) {
    throw new ZipSafetyError("zip entry name is not valid text", { cause: error });
  }
}

function safeRelativeParts(entryPath: string): string[] {
  if (!entryPath || entryPath.includes("\0") || entryPath.includes("\\")) {
    throw new ZipSafetyError(`unsafe zip entry: ${JSON.stringify(entryPath)}`);
  }
  if (entryPath.startsWith("/") || isAbsolute(entryPath)) {
    throw new ZipSafetyError(`unsafe zip entry: ${JSON.stringify(entryPath)}`);
  }
  const withoutTrailingSlash = entryPath.endsWith("/") ? entryPath.slice(0, -1) : entryPath;
  const parts = withoutTrailingSlash.split("/");
  if (
    !withoutTrailingSlash ||
    parts.some((part) => !part || part === "." || part === ".." || part.includes(":"))
  ) {
    throw new ZipSafetyError(`unsafe zip entry: ${JSON.stringify(entryPath)}`);
  }
  return parts;
}

function canonicalPathKey(parts: string[]): string {
  return parts.join("/").normalize("NFC").toLocaleLowerCase("en-US");
}

async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) {
    throw new ZipSafetyError("zip archive ended unexpectedly");
  }
  return buffer;
}

async function readCentralDirectory(
  archivePath: string,
  limits: ZipExtractionLimits,
): Promise<CentralDirectory> {
  const handle = await open(archivePath, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new ZipSafetyError("zip source is not a regular file");
    }
    if (stats.size > limits.maxArchiveBytes) {
      throw new ZipSafetyError("zip archive exceeds the compressed size limit");
    }
    if (stats.size < END_OF_CENTRAL_DIRECTORY_BYTES) {
      throw new ZipSafetyError("file is not a valid zip archive");
    }

    const tailLength = Math.min(
      stats.size,
      END_OF_CENTRAL_DIRECTORY_BYTES + MAX_ZIP_COMMENT_BYTES,
    );
    const tailOffset = stats.size - tailLength;
    const tail = await readExactly(handle, tailLength, tailOffset);
    let endOffset = -1;
    for (let cursor = tail.length - END_OF_CENTRAL_DIRECTORY_BYTES; cursor >= 0; cursor -= 1) {
      if (tail.readUInt32LE(cursor) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
      const commentLength = tail.readUInt16LE(cursor + 20);
      if (cursor + END_OF_CENTRAL_DIRECTORY_BYTES + commentLength === tail.length) {
        endOffset = cursor;
        break;
      }
    }
    if (endOffset < 0) {
      throw new ZipSafetyError("zip end-of-central-directory record was not found");
    }

    const diskNumber = tail.readUInt16LE(endOffset + 4);
    const centralDisk = tail.readUInt16LE(endOffset + 6);
    const diskEntries = tail.readUInt16LE(endOffset + 8);
    const totalEntries = tail.readUInt16LE(endOffset + 10);
    const centralSize = tail.readUInt32LE(endOffset + 12);
    const centralOffset = tail.readUInt32LE(endOffset + 16);
    if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
      throw new ZipSafetyError("multi-disk zip archives are not supported");
    }
    if (
      totalEntries === ZIP64_UINT16 ||
      centralSize === ZIP64_UINT32 ||
      centralOffset === ZIP64_UINT32
    ) {
      throw new ZipSafetyError("ZIP64 archives are not supported");
    }
    if (totalEntries > limits.maxEntries) {
      throw new ZipSafetyError("zip archive contains too many entries");
    }
    const centralLimit = limits.maxCentralDirectoryBytes ?? 32 * 1024 * 1024;
    if (centralSize > centralLimit) {
      throw new ZipSafetyError("zip central directory is too large");
    }
    const absoluteEndOffset = tailOffset + endOffset;
    if (centralOffset + centralSize > absoluteEndOffset) {
      throw new ZipSafetyError("zip central directory points outside the archive");
    }

    const central = await readExactly(handle, centralSize, centralOffset);
    const entries: ZipEntry[] = [];
    let cursor = 0;
    const maxEntryNameBytes = limits.maxEntryNameBytes ?? 4_096;
    for (let index = 0; index < totalEntries; index += 1) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== CENTRAL_FILE_SIGNATURE) {
        throw new ZipSafetyError("zip central directory contains an invalid entry");
      }
      const versionMadeBy = central.readUInt16LE(cursor + 4);
      const flags = central.readUInt16LE(cursor + 8);
      const compressionMethod = central.readUInt16LE(cursor + 10);
      const crc32 = central.readUInt32LE(cursor + 16);
      const compressedSize = central.readUInt32LE(cursor + 20);
      const uncompressedSize = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const startDisk = central.readUInt16LE(cursor + 34);
      const externalAttributes = central.readUInt32LE(cursor + 38);
      const localHeaderOffset = central.readUInt32LE(cursor + 42);
      if (
        compressedSize === ZIP64_UINT32 ||
        uncompressedSize === ZIP64_UINT32 ||
        localHeaderOffset === ZIP64_UINT32
      ) {
        throw new ZipSafetyError("ZIP64 entries are not supported");
      }
      if (startDisk !== 0) {
        throw new ZipSafetyError("multi-disk zip entries are not supported");
      }
      if (flags & 0x0001) {
        throw new ZipSafetyError("encrypted zip entries are not supported");
      }
      if (!nameLength || nameLength > maxEntryNameBytes) {
        throw new ZipSafetyError("zip entry name is empty or too long");
      }
      const entryBytes = 46 + nameLength + extraLength + commentLength;
      if (cursor + entryBytes > central.length) {
        throw new ZipSafetyError("zip central directory entry is truncated");
      }
      const rawName = Buffer.from(central.subarray(cursor + 46, cursor + 46 + nameLength));
      const entryPath = decodeEntryName(rawName, Boolean(flags & 0x0800));
      safeRelativeParts(entryPath);

      const platform = versionMadeBy >>> 8;
      const unixMode = platform === 3 ? (externalAttributes >>> 16) & 0xffff : 0;
      const unixType = unixMode & 0o170000;
      const directory = entryPath.endsWith("/");
      const symlink = unixType === 0o120000;
      const unsafeUnixType =
        unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000 && !symlink;
      entries.push({
        path: entryPath,
        directory,
        compressedSize,
        uncompressedSize,
        flags,
        compressionMethod,
        crc32,
        localHeaderOffset,
        rawName,
        symlink,
        unsafeUnixType,
      });
      cursor += entryBytes;
    }
    if (cursor > central.length) {
      throw new ZipSafetyError("zip central directory is malformed");
    }
    return { entries, offset: centralOffset };
  } finally {
    await handle.close();
  }
}

function selectEntries(entries: ZipEntry[], options: ExtractZipOptions): SelectedEntry[] {
  const selected: SelectedEntry[] = [];
  let extractedBytes = 0;
  const keys = new Map<string, boolean>();
  for (const entry of entries) {
    const metadata: ZipEntryMetadata = {
      path: entry.path,
      directory: entry.directory,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
    };
    const mapped = options.select ? options.select(metadata) : entry.path;
    if (mapped === null) continue;
    const parts = safeRelativeParts(mapped);
    const relativePath = parts.join("/");
    const key = canonicalPathKey(parts);
    if (keys.has(key)) {
      throw new ZipSafetyError(`duplicate zip output path: ${JSON.stringify(relativePath)}`);
    }
    if (entry.symlink) {
      throw new ZipSafetyError(`symbolic links are not allowed: ${JSON.stringify(entry.path)}`);
    }
    if (entry.unsafeUnixType) {
      throw new ZipSafetyError(`special files are not allowed: ${JSON.stringify(entry.path)}`);
    }
    if (![0, 8].includes(entry.compressionMethod)) {
      throw new ZipSafetyError(`unsupported zip compression method: ${entry.compressionMethod}`);
    }
    if (entry.directory && (entry.compressedSize !== 0 || entry.uncompressedSize !== 0)) {
      throw new ZipSafetyError("zip directory entries must not contain file data");
    }
    extractedBytes += entry.uncompressedSize;
    if (extractedBytes > options.maxExtractedBytes) {
      throw new ZipSafetyError("zip archive exceeds the extraction size limit");
    }
    keys.set(key, entry.directory);
    selected.push({ entry, relativePath, parts, key });
  }

  for (const item of selected) {
    for (let end = 1; end < item.parts.length; end += 1) {
      const ancestor = canonicalPathKey(item.parts.slice(0, end));
      if (keys.get(ancestor) === false) {
        throw new ZipSafetyError("zip output contains a file/directory path conflict");
      }
    }
  }
  return selected;
}

function isInside(base: string, candidate: string): boolean {
  const child = relative(base, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function ensureSafeDirectoryChain(base: string, parts: string[]): Promise<string> {
  let current = base;
  for (const part of parts) {
    current = join(current, part);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new ZipSafetyError("zip extraction encountered an unsafe existing path");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
    }
  }
  return current;
}

async function localDataOffset(
  archivePath: string,
  entry: ZipEntry,
  centralOffset: number,
): Promise<number> {
  const handle = await open(archivePath, "r");
  try {
    const local = await readExactly(handle, 30, entry.localHeaderOffset);
    if (local.readUInt32LE(0) !== LOCAL_FILE_SIGNATURE) {
      throw new ZipSafetyError("zip local file header is invalid");
    }
    const localFlags = local.readUInt16LE(6);
    const localMethod = local.readUInt16LE(8);
    const nameLength = local.readUInt16LE(26);
    const extraLength = local.readUInt16LE(28);
    if (localFlags & 0x0001 || localMethod !== entry.compressionMethod) {
      throw new ZipSafetyError("zip local file header disagrees with the central directory");
    }
    const localName = await readExactly(handle, nameLength, entry.localHeaderOffset + 30);
    if (!localName.equals(entry.rawName)) {
      throw new ZipSafetyError("zip local and central entry names do not match");
    }
    const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
    if (dataOffset + entry.compressedSize > centralOffset) {
      throw new ZipSafetyError("zip entry data points outside the file area");
    }
    return dataOffset;
  } finally {
    await handle.close();
  }
}

async function extractFile(
  archivePath: string,
  destination: string,
  selected: SelectedEntry,
  centralOffset: number,
): Promise<void> {
  const parent = await ensureSafeDirectoryChain(destination, selected.parts.slice(0, -1));
  const target = resolve(parent, selected.parts.at(-1)!);
  if (!isInside(destination, target)) {
    throw new ZipSafetyError("zip entry escapes the extraction directory");
  }
  const dataOffset = await localDataOffset(archivePath, selected.entry, centralOffset);
  const verifier = new EntryVerifier(selected.entry.uncompressedSize, selected.entry.crc32);
  try {
    if (selected.entry.compressedSize === 0) {
      if (selected.entry.uncompressedSize !== 0 || selected.entry.crc32 !== 0) {
        throw new ZipSafetyError("empty zip entry metadata is inconsistent");
      }
      const output = await open(target, "wx");
      await output.close();
    } else {
      const source = createReadStream(archivePath, {
        start: dataOffset,
        end: dataOffset + selected.entry.compressedSize - 1,
      });
      const output = createWriteStream(target, { flags: "wx" });
      if (selected.entry.compressionMethod === 8) {
        await pipeline(source, createInflateRaw(), verifier, output);
      } else {
        if (selected.entry.compressedSize !== selected.entry.uncompressedSize) {
          throw new ZipSafetyError("stored zip entry has inconsistent sizes");
        }
        await pipeline(source, verifier, output);
      }
    }
    verifier.verify();
  } catch (error) {
    await rm(target, { force: true });
    throw error;
  }
}

export async function extractZipArchive(
  archivePath: string,
  destinationPath: string,
  options: ExtractZipOptions,
): Promise<string[]> {
  const archive = resolve(archivePath);
  const destination = resolve(destinationPath);
  await mkdir(destination, { recursive: true });
  const physicalDestination = await realpath(destination);
  const central = await readCentralDirectory(archive, options);
  const selected = selectEntries(central.entries, options);

  for (const item of selected.filter((candidate) => candidate.entry.directory)) {
    await ensureSafeDirectoryChain(physicalDestination, item.parts);
  }
  for (const item of selected.filter((candidate) => !candidate.entry.directory)) {
    await extractFile(archive, physicalDestination, item, central.offset);
  }
  return selected.map((item) => item.relativePath);
}
