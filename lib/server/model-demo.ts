import { createWriteStream } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

import { DEFAULT_PROJECT_ROOT } from "./model-files.ts";
import { setupModel, type SetupModelResult } from "./model-setup.ts";
import { extractZipArchive, type ZipEntryMetadata } from "./model-zip.ts";

export const HIYORI_DOWNLOAD_URL =
  "https://cubism.live2d.com/sample-data/bin/hiyori/hiyori_en.zip";
export const FREE_MATERIAL_LICENSE =
  "https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html";
export const SAMPLE_DATA_TERMS = "https://www.live2d.com/en/learn/sample/model-terms/";
export const HIYORI_MODEL_STEM = "hiyori_pro_t11";
export const HIYORI_ARCHIVE_LIMIT = 128 * 1024 * 1024;
export const HIYORI_EXTRACTED_LIMIT = 128 * 1024 * 1024;
export const HIYORI_MEMBER_LIMIT = 2_000;

export class LicenseAcceptanceError extends Error {
  readonly exitCode = 2;

  constructor() {
    super("license acceptance is required before downloading Hiyori");
    this.name = "LicenseAcceptanceError";
  }
}

class DownloadLimitTransform extends Transform {
  readonly limit: number;
  bytes = 0;

  constructor(limit: number) {
    super();
    this.limit = limit;
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) {
      callback(new Error("download exceeded the allowed archive limit"));
      return;
    }
    this.push(chunk);
    callback();
  }
}

function paths(root: string) {
  const demoRoot = join(root, "local-assets", "prompt-soul-demo");
  const runtimeDirectory = join(demoRoot, "hiyori_pro", "runtime");
  return {
    demoRoot,
    runtimeDirectory,
    modelConfig: join(root, "model.config.json"),
    installedModel: join(root, "models", HIYORI_MODEL_STEM, `${HIYORI_MODEL_STEM}.model3.json`),
  };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function isHiyoriConfigured(rootPath = DEFAULT_PROJECT_ROOT): Promise<boolean> {
  const root = resolve(rootPath);
  const locations = paths(root);
  if (!(await isFile(locations.installedModel)) || !(await isFile(locations.modelConfig))) {
    return false;
  }
  try {
    const config = JSON.parse(await readFile(locations.modelConfig, "utf8")) as {
      name?: unknown;
      model3?: unknown;
    };
    const expected = relative(root, locations.installedModel).split(sep).join("/");
    return config.name === HIYORI_MODEL_STEM && config.model3 === expected;
  } catch {
    return false;
  }
}

export async function downloadOfficialHiyori(
  destinationPath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const destination = resolve(destinationPath);
  await mkdir(dirname(destination), { recursive: true });
  const response = await fetchImpl(HIYORI_DOWNLOAD_URL, {
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
    headers: { "User-Agent": "PromptSoul setup-demo.ts" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`official Hiyori download failed with HTTP ${response.status}`);
  }
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:" || finalUrl.hostname !== "cubism.live2d.com") {
    throw new Error("download redirected to an unexpected host");
  }
  const advertised = response.headers.get("content-length");
  if (advertised !== null) {
    const length = Number(advertised);
    if (!Number.isSafeInteger(length) || length < 0 || length > HIYORI_ARCHIVE_LIMIT) {
      throw new Error("download is larger than the allowed archive limit");
    }
  }

  const limiter = new DownloadLimitTransform(HIYORI_ARCHIVE_LIMIT);
  try {
    await pipeline(
      Readable.fromWeb(response.body as never),
      limiter,
      createWriteStream(destination, { flags: "wx", mode: 0o600 }),
    );
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
  return limiter.bytes;
}

export async function extractHiyoriRuntimeArchive(
  archivePath: string,
  destinationPath: string,
): Promise<string[]> {
  const selected = await extractZipArchive(archivePath, destinationPath, {
    maxArchiveBytes: HIYORI_ARCHIVE_LIMIT,
    maxEntries: HIYORI_MEMBER_LIMIT,
    maxExtractedBytes: HIYORI_EXTRACTED_LIMIT,
    select(entry: ZipEntryMetadata): string | null {
      const withoutSlash = entry.path.endsWith("/") ? entry.path.slice(0, -1) : entry.path;
      const parts = withoutSlash.split("/");
      if (parts[0] !== "hiyori_pro" || parts[1] !== "runtime") return null;
      const remainder = parts.slice(2);
      if (remainder.length === 0) return null;
      return `${remainder.join("/")}${entry.directory ? "/" : ""}`;
    },
  });
  if (!selected.some((entry) => entry.endsWith(".model3.json"))) {
    throw new Error("official archive did not contain hiyori_pro/runtime model data");
  }
  return selected;
}

async function installRuntime(root: string, fetchImpl: typeof fetch): Promise<void> {
  const locations = paths(root);
  await mkdir(dirname(locations.demoRoot), { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), "prompt-soul-demo-"));
  const archive = join(temporary, "hiyori_en.zip");
  const extracted = join(temporary, "runtime");
  const staging = `${locations.demoRoot}.staging`;
  try {
    await mkdir(extracted);
    await downloadOfficialHiyori(archive, fetchImpl);
    await extractHiyoriRuntimeArchive(archive, extracted);
    await rm(staging, { recursive: true, force: true });
    const stagedRuntime = join(staging, "hiyori_pro", "runtime");
    await mkdir(dirname(stagedRuntime), { recursive: true });
    await cp(extracted, stagedRuntime, { recursive: true, errorOnExist: true });
    await rm(locations.demoRoot, { recursive: true, force: true });
    await rename(staging, locations.demoRoot);
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}

export interface SetupHiyoriOptions {
  root?: string;
  acceptLicense: boolean;
  fetchImpl?: typeof fetch;
}

export interface SetupHiyoriResult {
  alreadyConfigured: boolean;
  reusedDownload: boolean;
  setup?: SetupModelResult;
}

export async function setupHiyoriDemo(options: SetupHiyoriOptions): Promise<SetupHiyoriResult> {
  if (!options.acceptLicense) throw new LicenseAcceptanceError();
  const root = resolve(options.root ?? DEFAULT_PROJECT_ROOT);
  if (await isHiyoriConfigured(root)) {
    return { alreadyConfigured: true, reusedDownload: true };
  }
  const locations = paths(root);
  const runtimeModel = join(locations.runtimeDirectory, `${HIYORI_MODEL_STEM}.model3.json`);
  const reusedDownload = await isFile(runtimeModel);
  if (!reusedDownload) {
    await installRuntime(root, options.fetchImpl ?? fetch);
  }
  const setup = await setupModel({ root, source: locations.runtimeDirectory });
  return { alreadyConfigured: false, reusedDownload, setup };
}
