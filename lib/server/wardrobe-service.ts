import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  DEFAULT_PROJECT_ROOT,
  findFilesBySuffix,
  isPathWithin,
  readJsonFile,
  writeJsonAtomic,
} from "@/lib/server/model-files";
import { extractZipArchive } from "@/lib/server/model-zip";

const CATALOG_VERSION = 1;
const ORIGINAL_PRESET_ID = "original";
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 20_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

interface ModelConfig {
  name?: unknown;
  model3?: unknown;
}

interface Model3File {
  FileReferences?: {
    Moc?: unknown;
    Textures?: unknown;
  };
}

interface PngInfo {
  width: number;
  height: number;
}

interface TextureDefinition extends PngInfo {
  reference: string;
  absolutePath: string;
}

interface ActiveModel {
  name: string;
  model3Path: string;
  modelDirectory: string;
  model3Hash: string;
  mocHash: string;
  textures: TextureDefinition[];
  protected: boolean;
}

export interface WardrobePreset {
  id: string;
  name: string;
  prompt: string | null;
  provider: string;
  createdAt: string;
  textureFiles: string[];
}

interface WardrobeCatalog {
  version: number;
  modelName: string;
  model3Hash: string;
  mocHash: string;
  textureReferences: string[];
  textureDimensions: PngInfo[];
  activePresetId: string;
  revision: number;
  presets: WardrobePreset[];
}

export interface WardrobeStatus {
  available: boolean;
  protected: boolean;
  reason: string | null;
  modelName: string | null;
  activePresetId: string | null;
  revision: number;
  presets: Array<Pick<WardrobePreset, "id" | "name" | "prompt" | "provider" | "createdAt">>;
}

export class WardrobeError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WardrobeError";
    this.status = status;
    this.code = code;
  }
}

let wardrobeMutation = Promise.resolve();

function serializeMutation<T>(task: () => Promise<T>): Promise<T> {
  const run = wardrobeMutation.then(task, task);
  wardrobeMutation = run.then(() => undefined, () => undefined);
  return run;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function safeReference(baseDirectory: string, input: unknown, label: string): string {
  if (typeof input !== "string" || !input || input.includes("\0") || input.includes("\\")) {
    throw new WardrobeError(422, "invalid_model", `${label} reference is invalid.`);
  }
  if (isAbsolute(input) || input.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new WardrobeError(422, "invalid_model", `${label} reference escapes the model directory.`);
  }
  const absolute = resolve(baseDirectory, input);
  if (!isPathWithin(baseDirectory, absolute)) {
    throw new WardrobeError(422, "invalid_model", `${label} reference escapes the model directory.`);
  }
  return absolute;
}

function readPngInfo(buffer: Buffer, label: string): PngInfo {
  if (
    buffer.length < 33
    || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    || buffer.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new WardrobeError(422, "invalid_texture", `${label} is not a valid PNG texture.`);
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height || width > 16_384 || height > 16_384) {
    throw new WardrobeError(422, "invalid_texture", `${label} has unsupported dimensions.`);
  }
  return { width, height };
}

function safeModelName(config: ModelConfig, model3Path: string): string {
  const raw = typeof config.name === "string" && config.name.trim()
    ? config.name.trim()
    : basename(model3Path, ".model3.json");
  return raw.replace(/[^a-zA-Z0-9._-]+/gu, "_").slice(0, 100) || "model";
}

function isProtectedModel(name: string): boolean {
  return /^hiyori(?:_|$)/iu.test(name);
}

async function loadActiveModel(): Promise<ActiveModel> {
  const configPath = join(DEFAULT_PROJECT_ROOT, "model.config.json");
  if (!existsSync(configPath)) {
    throw new WardrobeError(404, "model_unavailable", "Import a Live2D model before using the wardrobe.");
  }
  const config = await readJsonFile<ModelConfig>(configPath).catch((error) => {
    throw new WardrobeError(422, "invalid_model_config", "model.config.json is invalid.", { cause: error });
  });
  if (typeof config.model3 !== "string" || !config.model3.endsWith(".model3.json")) {
    throw new WardrobeError(422, "invalid_model_config", "model.config.json does not contain a model3 path.");
  }
  const model3Path = resolve(DEFAULT_PROJECT_ROOT, config.model3);
  const modelsRoot = resolve(DEFAULT_PROJECT_ROOT, "models");
  if (!isPathWithin(modelsRoot, model3Path)) {
    throw new WardrobeError(422, "invalid_model_config", "The active model must be located under models/.");
  }
  const model3Buffer = await readFile(model3Path).catch((error) => {
    throw new WardrobeError(404, "model_unavailable", "The active model3 file is unavailable.", { cause: error });
  });
  let model3: Model3File;
  try {
    model3 = JSON.parse(model3Buffer.toString("utf8")) as Model3File;
  } catch (error) {
    throw new WardrobeError(422, "invalid_model", "The active model3 file is invalid JSON.", { cause: error });
  }
  const modelDirectory = dirname(model3Path);
  const mocPath = safeReference(modelDirectory, model3.FileReferences?.Moc, "Moc");
  const textureRefs = model3.FileReferences?.Textures;
  if (!Array.isArray(textureRefs) || !textureRefs.length || textureRefs.length > 64) {
    throw new WardrobeError(422, "invalid_model", "The model must reference between 1 and 64 textures.");
  }
  const textures: TextureDefinition[] = [];
  for (const [index, reference] of textureRefs.entries()) {
    const absolutePath = safeReference(modelDirectory, reference, `Texture ${index + 1}`);
    const buffer = await readFile(absolutePath).catch((error) => {
      throw new WardrobeError(404, "texture_unavailable", `Texture ${index + 1} is unavailable.`, { cause: error });
    });
    textures.push({
      reference: String(reference),
      absolutePath,
      ...readPngInfo(buffer, `Texture ${index + 1}`),
    });
  }
  const mocBuffer = await readFile(mocPath).catch((error) => {
    throw new WardrobeError(404, "model_unavailable", "The active moc3 file is unavailable.", { cause: error });
  });
  const name = safeModelName(config, model3Path);
  return {
    name,
    model3Path,
    modelDirectory,
    model3Hash: sha256(model3Buffer),
    mocHash: sha256(mocBuffer),
    textures,
    protected: isProtectedModel(name),
  };
}

function wardrobeRoot(model: ActiveModel): string {
  return join(DEFAULT_PROJECT_ROOT, "local-assets", "wardrobe", model.name);
}

function catalogPath(model: ActiveModel): string {
  return join(wardrobeRoot(model), "wardrobe.json");
}

function presetTextureNames(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `texture_${String(index).padStart(2, "0")}.png`);
}

function publicStatus(model: ActiveModel, catalog: WardrobeCatalog): WardrobeStatus {
  return {
    available: !model.protected,
    protected: model.protected,
    reason: model.protected
      ? "Hiyori's character design is protected by its model terms and cannot be changed here."
      : null,
    modelName: model.name,
    activePresetId: catalog.activePresetId,
    revision: catalog.revision,
    presets: catalog.presets.map(({ id, name, prompt, provider, createdAt }) => ({
      id,
      name,
      prompt,
      provider,
      createdAt,
    })),
  };
}

function assertCatalogMatchesModel(catalog: WardrobeCatalog, model: ActiveModel): void {
  const expectedRefs = model.textures.map((texture) => texture.reference);
  const expectedDimensions = model.textures.map(({ width, height }) => ({ width, height }));
  if (
    catalog.version !== CATALOG_VERSION
    || catalog.modelName !== model.name
    || catalog.mocHash !== model.mocHash
    || JSON.stringify(catalog.textureReferences) !== JSON.stringify(expectedRefs)
    || JSON.stringify(catalog.textureDimensions) !== JSON.stringify(expectedDimensions)
  ) {
    throw new WardrobeError(
      409,
      "wardrobe_model_changed",
      "The active model changed after this wardrobe was created. Remove its local wardrobe data and initialize it again.",
    );
  }
}

async function ensureCatalog(model: ActiveModel): Promise<WardrobeCatalog> {
  const path = catalogPath(model);
  if (existsSync(path)) {
    const catalog = await readJsonFile<WardrobeCatalog>(path).catch((error) => {
      throw new WardrobeError(422, "invalid_wardrobe", "The local wardrobe catalog is invalid.", { cause: error });
    });
    assertCatalogMatchesModel(catalog, model);
    return catalog;
  }
  const root = wardrobeRoot(model);
  const originalDirectory = join(root, "presets", ORIGINAL_PRESET_ID);
  await mkdir(originalDirectory, { recursive: true });
  const textureFiles = presetTextureNames(model.textures.length);
  for (const [index, texture] of model.textures.entries()) {
    await copyFile(texture.absolutePath, join(originalDirectory, textureFiles[index]));
  }
  const catalog: WardrobeCatalog = {
    version: CATALOG_VERSION,
    modelName: model.name,
    model3Hash: model.model3Hash,
    mocHash: model.mocHash,
    textureReferences: model.textures.map((texture) => texture.reference),
    textureDimensions: model.textures.map(({ width, height }) => ({ width, height })),
    activePresetId: ORIGINAL_PRESET_ID,
    revision: 1,
    presets: [{
      id: ORIGINAL_PRESET_ID,
      name: "Original",
      prompt: null,
      provider: "template",
      createdAt: new Date().toISOString(),
      textureFiles,
    }],
  };
  await writeJsonAtomic(path, catalog);
  return catalog;
}

async function validatePresetTextures(
  model: ActiveModel,
  preset: WardrobePreset,
): Promise<string[]> {
  if (preset.textureFiles.length !== model.textures.length) {
    throw new WardrobeError(422, "invalid_wardrobe", "The preset texture count does not match the model.");
  }
  const presetDirectory = resolve(wardrobeRoot(model), "presets", preset.id);
  return Promise.all(preset.textureFiles.map(async (fileName, index) => {
    if (basename(fileName) !== fileName || !fileName.endsWith(".png")) {
      throw new WardrobeError(422, "invalid_wardrobe", "The preset contains an unsafe texture filename.");
    }
    const texturePath = resolve(presetDirectory, fileName);
    if (!isPathWithin(presetDirectory, texturePath)) {
      throw new WardrobeError(422, "invalid_wardrobe", "The preset texture escapes its directory.");
    }
    const buffer = await readFile(texturePath).catch((error) => {
      throw new WardrobeError(404, "preset_unavailable", "A preset texture is missing.", { cause: error });
    });
    const dimensions = readPngInfo(buffer, `Preset texture ${index + 1}`);
    const expected = model.textures[index];
    if (dimensions.width !== expected.width || dimensions.height !== expected.height) {
      throw new WardrobeError(422, "texture_dimensions_changed", "A preset texture changed the UV canvas dimensions.");
    }
    return texturePath;
  }));
}

export async function getWardrobeStatus(): Promise<WardrobeStatus> {
  try {
    return await serializeMutation(async () => {
      const model = await loadActiveModel();
      const catalog = await ensureCatalog(model);
      return publicStatus(model, catalog);
    });
  } catch (error) {
    if (error instanceof WardrobeError && error.code === "model_unavailable") {
      return {
        available: false,
        protected: false,
        reason: error.message,
        modelName: null,
        activePresetId: null,
        revision: 0,
        presets: [],
      };
    }
    throw error;
  }
}

export async function selectWardrobePreset(
  presetId: string,
  expectedRevision?: number,
): Promise<WardrobeStatus> {
  return serializeMutation(async () => {
    const model = await loadActiveModel();
    const catalog = await ensureCatalog(model);
    if (model.protected && presetId !== ORIGINAL_PRESET_ID) {
      throw new WardrobeError(403, "protected_model", "This model's character design cannot be changed.");
    }
    if (expectedRevision !== undefined && expectedRevision !== catalog.revision) {
      throw new WardrobeError(409, "wardrobe_revision_changed", "The wardrobe changed. Refresh the preset list and try again.");
    }
    const preset = catalog.presets.find((candidate) => candidate.id === presetId);
    if (!preset) {
      throw new WardrobeError(404, "preset_not_found", "The selected wardrobe preset does not exist.");
    }
    if (catalog.activePresetId === presetId) return publicStatus(model, catalog);
    const sources = await validatePresetTextures(model, preset);
    const transactionId = randomUUID();
    const backups: Array<{ target: string; backup: string }> = [];
    const temporaries: string[] = [];
    const previousPresetId = catalog.activePresetId;
    const previousRevision = catalog.revision;
    try {
      for (const [index, texture] of model.textures.entries()) {
        const target = texture.absolutePath;
        const backup = `${target}.${transactionId}.bak`;
        const temporary = `${target}.${transactionId}.tmp`;
        temporaries.push(temporary);
        await copyFile(target, backup);
        backups.push({ target, backup });
        await copyFile(sources[index], temporary);
        await rename(temporary, target);
      }
      catalog.activePresetId = presetId;
      catalog.revision += 1;
      await writeJsonAtomic(catalogPath(model), catalog);
    } catch (error) {
      catalog.activePresetId = previousPresetId;
      catalog.revision = previousRevision;
      for (const { target, backup } of backups.reverse()) {
        if (existsSync(backup)) await rename(backup, target).catch(() => undefined);
      }
      throw new WardrobeError(500, "wardrobe_switch_failed", "The texture switch failed and was rolled back.", { cause: error });
    } finally {
      await Promise.all([
        ...backups.map(({ backup }) => rm(backup, { force: true })),
        ...temporaries.map((temporary) => rm(temporary, { force: true })),
      ]);
    }
    return publicStatus(model, catalog);
  });
}

function generatedPresetName(prompt: string): string {
  const normalized = prompt.replace(/\s+/gu, " ").trim();
  return normalized.length > 34 ? `${normalized.slice(0, 34)}…` : normalized;
}

export async function installGeneratedWardrobe(
  archivePath: string,
  prompt: string,
  provider: string,
): Promise<WardrobePreset> {
  return serializeMutation(async () => {
    const model = await loadActiveModel();
    if (model.protected) {
      throw new WardrobeError(403, "protected_model", "This model's character design cannot be changed.");
    }
    const catalog = await ensureCatalog(model);
    const extractionRoot = join(wardrobeRoot(model), ".tmp", randomUUID());
    await mkdir(extractionRoot, { recursive: true });
    try {
      await extractZipArchive(archivePath, extractionRoot, {
        maxArchiveBytes: MAX_ARCHIVE_BYTES,
        maxEntries: MAX_ZIP_ENTRIES,
        maxExtractedBytes: MAX_EXTRACTED_BYTES,
      });
      const model3Files = await findFilesBySuffix(extractionRoot, ".model3.json", 10);
      const matchingModel3 = model3Files.filter((candidate) => basename(candidate) === basename(model.model3Path));
      if (matchingModel3.length !== 1) {
        throw new WardrobeError(422, "generated_model_mismatch", "The generated package does not contain exactly one matching model3 file.");
      }
      const generatedModel3Path = matchingModel3[0];
      const generatedModel3Buffer = await readFile(generatedModel3Path);
      if (sha256(generatedModel3Buffer) !== model.model3Hash) {
        throw new WardrobeError(422, "generated_model_changed", "The generated package changed model3 metadata; only textures may change.");
      }
      const generatedModel3 = JSON.parse(generatedModel3Buffer.toString("utf8")) as Model3File;
      const generatedDirectory = dirname(generatedModel3Path);
      const generatedMocPath = safeReference(generatedDirectory, generatedModel3.FileReferences?.Moc, "Generated Moc");
      if (sha256(await readFile(generatedMocPath)) !== model.mocHash) {
        throw new WardrobeError(422, "generated_rig_changed", "The generated package changed the moc3 rig.");
      }
      const generatedRefs = generatedModel3.FileReferences?.Textures;
      if (!Array.isArray(generatedRefs) || JSON.stringify(generatedRefs) !== JSON.stringify(catalog.textureReferences)) {
        throw new WardrobeError(422, "generated_texture_layout_changed", "The generated package changed texture references.");
      }

      const presetId = `outfit_${createHash("sha256")
        .update(`${prompt}\0${provider}\0${Date.now()}\0${randomUUID()}`)
        .digest("hex")
        .slice(0, 12)}`;
      const presetDirectory = join(wardrobeRoot(model), "presets", presetId);
      await mkdir(presetDirectory, { recursive: true });
      const textureFiles = presetTextureNames(model.textures.length);
      try {
        for (const [index, reference] of generatedRefs.entries()) {
          const source = safeReference(generatedDirectory, reference, `Generated texture ${index + 1}`);
          const buffer = await readFile(source);
          const dimensions = readPngInfo(buffer, `Generated texture ${index + 1}`);
          const expected = model.textures[index];
          if (dimensions.width !== expected.width || dimensions.height !== expected.height) {
            throw new WardrobeError(422, "texture_dimensions_changed", "Generated textures must preserve the UV canvas dimensions.");
          }
          await copyFile(source, join(presetDirectory, textureFiles[index]));
        }
      } catch (error) {
        await rm(presetDirectory, { recursive: true, force: true });
        throw error;
      }
      const preset: WardrobePreset = {
        id: presetId,
        name: generatedPresetName(prompt),
        prompt,
        provider,
        createdAt: new Date().toISOString(),
        textureFiles,
      };
      catalog.presets.push(preset);
      await writeJsonAtomic(catalogPath(model), catalog);
      return preset;
    } finally {
      await rm(extractionRoot, { recursive: true, force: true });
    }
  });
}

export async function getActiveModelArchiveSource(): Promise<{
  model: ActiveModel;
  directory: string;
}> {
  const model = await loadActiveModel();
  if (model.protected) {
    throw new WardrobeError(403, "protected_model", "This model's character design cannot be changed.");
  }
  const sourceStats = await stat(model.modelDirectory);
  if (!sourceStats.isDirectory()) {
    throw new WardrobeError(422, "invalid_model", "The active model source is not a directory.");
  }
  return { model, directory: model.modelDirectory };
}

export async function installAndSelectGeneratedWardrobe(
  archivePath: string,
  prompt: string,
  provider: string,
): Promise<WardrobeStatus> {
  const preset = await installGeneratedWardrobe(archivePath, prompt, provider);
  return selectWardrobePreset(preset.id);
}

export function relativeModelPath(modelDirectory: string, filePath: string): string {
  return relative(modelDirectory, filePath).split("\\").join("/");
}
