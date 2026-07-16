import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

import {
  copyDirectoryWithoutLinks,
  DEFAULT_PROJECT_ROOT,
  expandHome,
  findFilesBySuffix,
  isPathWithin,
  writeJsonAtomic,
} from "./model-files.ts";
import { extractZipArchive } from "./model-zip.ts";

export const MODEL3_SUFFIX = ".model3.json";
export const MODEL_ZIP_LIMITS = Object.freeze({
  maxArchiveBytes: 1024 * 1024 * 1024,
  maxEntries: 10_000,
  maxExtractedBytes: 1024 * 1024 * 1024,
});

export interface SetupModelOptions {
  root?: string;
  source?: string;
}

export interface SetupModelResult {
  name: string;
  model3: string;
  sourceDirectory: string;
  targetDirectory: string;
  extractedDirectory?: string;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function portablePath(path: string): string {
  return path.split(sep).join("/");
}

function validateModelStem(stem: string): void {
  if (
    !stem ||
    stem === "." ||
    stem === ".." ||
    stem.includes("/") ||
    stem.includes("\\") ||
    stem.includes("\0") ||
    stem.includes(":")
  ) {
    throw new Error("model filename does not provide a safe model name");
  }
}

export async function setupModel(options: SetupModelOptions = {}): Promise<SetupModelResult> {
  const root = resolve(options.root ?? DEFAULT_PROJECT_ROOT);
  const localAssets = join(root, "local-assets");
  const models = join(root, "models");
  const configPath = join(root, "model.config.json");
  let source = options.source ? resolve(expandHome(options.source)) : undefined;
  let extractedDirectory: string | undefined;

  if (source && extname(source).toLocaleLowerCase("en-US") === ".zip") {
    const archiveName = basename(source, extname(source));
    validateModelStem(archiveName);
    extractedDirectory = join(localAssets, "models", archiveName);
    await rm(extractedDirectory, { recursive: true, force: true });
    await mkdir(extractedDirectory, { recursive: true });
    try {
      await extractZipArchive(source, extractedDirectory, MODEL_ZIP_LIMITS);
    } catch (error) {
      await rm(extractedDirectory, { recursive: true, force: true });
      throw new Error("could not safely extract model zip", { cause: error });
    }
    source = extractedDirectory;
  }

  const searchBase = resolve(source ?? localAssets);
  if (!(await isDirectory(searchBase))) {
    throw new Error(`${searchBase} does not exist; pass a model folder or zip`);
  }
  const candidates = (await findFilesBySuffix(searchBase, MODEL3_SUFFIX)).filter(
    (candidate) => !isPathWithin(models, candidate),
  );
  if (candidates.length === 0) {
    throw new Error(`no *${MODEL3_SUFFIX} found under ${searchBase}`);
  }
  if (candidates.length > 1) {
    throw new Error(
      `multiple models found; pass the folder of one model:\n${candidates
        .map((candidate) => `  - ${candidate}`)
        .join("\n")}`,
    );
  }

  const model3Source = candidates[0];
  const sourceDirectory = dirname(model3Source);
  const model3Filename = basename(model3Source);
  const stem = model3Filename.slice(0, -MODEL3_SUFFIX.length);
  validateModelStem(stem);
  const targetDirectory = join(models, stem);
  const staging = join(models, `.${stem}.staging-${process.pid}-${randomUUID()}`);
  await mkdir(models, { recursive: true });
  await rm(staging, { recursive: true, force: true });
  try {
    await copyDirectoryWithoutLinks(sourceDirectory, staging);
    await rm(targetDirectory, { recursive: true, force: true });
    await rename(staging, targetDirectory);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  const model3Relative = portablePath(relative(root, join(targetDirectory, model3Filename)));
  await writeJsonAtomic(configPath, { name: stem, model3: model3Relative });
  return {
    name: stem,
    model3: model3Relative,
    sourceDirectory,
    targetDirectory,
    ...(extractedDirectory ? { extractedDirectory } : {}),
  };
}
