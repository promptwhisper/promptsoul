import archiver from "archiver";
import { createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  getActiveModelArchiveSource,
  installAndSelectGeneratedWardrobe,
  relativeModelPath,
  WardrobeError,
  type WardrobeStatus,
} from "@/lib/server/wardrobe-service";

const MAX_MODEL_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_MODEL_FILES = 20_000;
const DEFAULT_GENERATION_TIMEOUT_MS = 12 * 60 * 1000;
const POLL_INTERVAL_MS = 1_200;

interface PromptSkinProject {
  id?: unknown;
}

interface PromptSkinJob {
  id?: unknown;
  status?: unknown;
  progress?: unknown;
  message?: unknown;
  error?: unknown;
}

interface PromptSkinProvider {
  name?: unknown;
  available?: unknown;
  description?: unknown;
}

export interface PromptSkinAvailability {
  connected: boolean;
  provider: "mock" | "openai";
  available: boolean;
  description: string;
}

function configuredProvider(): "mock" | "openai" {
  const value = (process.env.PROMPTSKIN_PROVIDER || "openai").trim().toLowerCase();
  if (value !== "mock" && value !== "openai") {
    throw new WardrobeError(500, "invalid_promptskin_config", "PROMPTSKIN_PROVIDER must be mock or openai.");
  }
  return value;
}

function isLoopback(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return value === "localhost" || value === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(value);
}

function promptSkinBaseUrl(): URL {
  const raw = (process.env.PROMPTSKIN_API_BASE || "http://127.0.0.1:8000").trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new WardrobeError(500, "invalid_promptskin_config", "PROMPTSKIN_API_BASE is not a valid URL.", { cause: error });
  }
  if (
    url.username
    || url.password
    || url.search
    || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname)))
  ) {
    throw new WardrobeError(500, "invalid_promptskin_config", "PromptSkin must use HTTPS or a loopback HTTP URL without credentials.");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url;
}

function apiUrl(path: string): URL {
  const base = promptSkinBaseUrl();
  const prefix = base.pathname.endsWith("/api") ? base.pathname : `${base.pathname}/api`;
  base.pathname = `${prefix}${path}`.replace(/\/{2,}/gu, "/");
  return base;
}

function generationTimeoutMs(): number {
  const configured = Number(process.env.PROMPTSKIN_GENERATION_TIMEOUT_MS || DEFAULT_GENERATION_TIMEOUT_MS);
  if (!Number.isInteger(configured) || configured < 30_000 || configured > 60 * 60 * 1000) {
    throw new WardrobeError(
      500,
      "invalid_promptskin_config",
      "PROMPTSKIN_GENERATION_TIMEOUT_MS must be between 30000 and 3600000.",
    );
  }
  return configured;
}

async function responseMessage(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return `HTTP ${response.status}`;
  try {
    const value = JSON.parse(text) as { detail?: unknown; message?: unknown };
    if (typeof value.detail === "string") return value.detail;
    if (typeof value.message === "string") return value.message;
  } catch {
    // PromptSkin may return a short plain-text proxy error.
  }
  return text.slice(0, 400);
}

async function fetchPromptSkin(
  path: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<Response> {
  try {
    const response = await fetch(apiUrl(path), {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new WardrobeError(
        response.status >= 500 ? 502 : 409,
        "promptskin_request_failed",
        `PromptSkin rejected the request: ${await responseMessage(response)}`,
      );
    }
    return response;
  } catch (error) {
    if (error instanceof WardrobeError) throw error;
    throw new WardrobeError(
      503,
      "promptskin_unavailable",
      "PromptSkin is unavailable. Start its backend and check PROMPTSKIN_API_BASE.",
      { cause: error },
    );
  }
}

async function collectModelFiles(directory: string): Promise<Array<{ path: string; name: string; size: number }>> {
  const root = resolve(directory);
  const files: Array<{ path: string; name: string; size: number }> = [];
  let totalBytes = 0;

  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = join(current, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new WardrobeError(422, "unsafe_model_source", "Symbolic links are not allowed in a PromptSkin upload.");
      }
      if (metadata.isDirectory()) {
        await visit(path);
      } else if (metadata.isFile()) {
        files.push({ path, name: relativeModelPath(root, path), size: metadata.size });
        totalBytes += metadata.size;
        if (files.length > MAX_MODEL_FILES || totalBytes > MAX_MODEL_ARCHIVE_BYTES) {
          throw new WardrobeError(413, "model_too_large", "The active model is too large to send to PromptSkin.");
        }
      } else {
        throw new WardrobeError(422, "unsafe_model_source", "Special files are not allowed in a PromptSkin upload.");
      }
    }
  }

  await visit(root);
  return files;
}

async function createModelArchive(directory: string, destination: string): Promise<void> {
  const files = await collectModelFiles(directory);
  await mkdir(resolve(destination, ".."), { recursive: true });
  await new Promise<void>((resolvePromise, reject) => {
    const output = createWriteStream(destination, { flags: "wx", mode: 0o600 });
    const archive = archiver("zip", { zlib: { level: 6 } });
    output.on("close", resolvePromise);
    output.on("error", reject);
    archive.on("warning", reject);
    archive.on("error", reject);
    archive.pipe(output);
    for (const file of files) archive.file(file.path, { name: file.name });
    archive.finalize().catch(reject);
  });
}

async function uploadModelArchive(archivePath: string): Promise<string> {
  const archive = await open(archivePath, "r");
  let buffer: Buffer;
  try {
    const metadata = await archive.stat();
    if (metadata.size > MAX_MODEL_ARCHIVE_BYTES) {
      throw new WardrobeError(413, "model_too_large", "The compressed model is too large to send to PromptSkin.");
    }
    buffer = await archive.readFile();
  } finally {
    await archive.close();
  }
  const form = new FormData();
  form.append(
    "model_zip",
    new Blob([Uint8Array.from(buffer)], { type: "application/zip" }),
    "promptsoul-model.zip",
  );
  const response = await fetchPromptSkin("/projects/import", {
    method: "POST",
    body: form,
  }, 120_000);
  const project = await response.json() as PromptSkinProject;
  if (typeof project.id !== "string" || !/^[a-f0-9]{32}$/u.test(project.id)) {
    throw new WardrobeError(502, "invalid_promptskin_response", "PromptSkin returned an invalid project ID.");
  }
  return project.id;
}

async function createGeneration(projectId: string, prompt: string, provider: "mock" | "openai"): Promise<string> {
  const response = await fetchPromptSkin(`/projects/${encodeURIComponent(projectId)}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description: prompt, provider }),
  });
  const job = await response.json() as PromptSkinJob;
  if (typeof job.id !== "string" || !/^[a-f0-9]{32}$/u.test(job.id)) {
    throw new WardrobeError(502, "invalid_promptskin_response", "PromptSkin returned an invalid generation job ID.");
  }
  return job.id;
}

async function waitForGeneration(jobId: string): Promise<void> {
  const deadline = Date.now() + generationTimeoutMs();
  while (Date.now() < deadline) {
    const response = await fetchPromptSkin(`/jobs/${encodeURIComponent(jobId)}`, {}, 30_000);
    const job = await response.json() as PromptSkinJob;
    if (job.status === "completed") return;
    if (job.status === "failed") {
      const detail = typeof job.error === "string" ? job.error : "Image generation failed.";
      throw new WardrobeError(502, "promptskin_generation_failed", `PromptSkin generation failed: ${detail}`);
    }
    if (job.status !== "queued" && job.status !== "running") {
      throw new WardrobeError(502, "invalid_promptskin_response", "PromptSkin returned an unknown job status.");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_INTERVAL_MS));
  }
  throw new WardrobeError(504, "promptskin_timeout", "PromptSkin generation timed out before producing an outfit.");
}

async function downloadGeneration(jobId: string, destination: string): Promise<void> {
  const response = await fetchPromptSkin(`/jobs/${encodeURIComponent(jobId)}/download`, {}, 120_000);
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_MODEL_ARCHIVE_BYTES) {
    throw new WardrobeError(502, "promptskin_archive_too_large", "PromptSkin returned an oversized archive.");
  }
  if (!response.body) {
    throw new WardrobeError(502, "invalid_promptskin_response", "PromptSkin returned an empty archive response.");
  }
  const output = await open(destination, "wx", 0o600);
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_MODEL_ARCHIVE_BYTES) {
        await reader.cancel();
        throw new WardrobeError(502, "promptskin_archive_too_large", "PromptSkin returned an oversized archive.");
      }
      await output.write(value);
    }
  } finally {
    reader.releaseLock();
    await output.close();
  }
  if (!total) {
    await rm(destination, { force: true });
    throw new WardrobeError(502, "invalid_promptskin_response", "PromptSkin returned an empty archive.");
  }
}

export async function getPromptSkinAvailability(): Promise<PromptSkinAvailability> {
  const provider = configuredProvider();
  try {
    await fetchPromptSkin("/health", {}, 2_000);
    const response = await fetchPromptSkin("/providers", {}, 2_000);
    const providers = await response.json() as PromptSkinProvider[];
    const selected = Array.isArray(providers)
      ? providers.find((candidate) => candidate.name === provider)
      : undefined;
    const available = selected?.available === true;
    return {
      connected: true,
      provider,
      available,
      description: typeof selected?.description === "string"
        ? selected.description
        : available ? `${provider} is available.` : `${provider} is not available.`,
    };
  } catch (error) {
    return {
      connected: false,
      provider,
      available: false,
      description: error instanceof Error ? error.message : "PromptSkin is unavailable.",
    };
  }
}

export async function generateWardrobeWithPromptSkin(prompt: string): Promise<WardrobeStatus> {
  const provider = configuredProvider();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "promptsoul-wardrobe-"));
  const uploadArchive = join(temporaryRoot, "source.zip");
  const generatedArchive = join(temporaryRoot, "generated.zip");
  try {
    const { directory } = await getActiveModelArchiveSource();
    await createModelArchive(directory, uploadArchive);
    const projectId = await uploadModelArchive(uploadArchive);
    const jobId = await createGeneration(projectId, prompt, provider);
    await waitForGeneration(jobId);
    await downloadGeneration(jobId, generatedArchive);
    return await installAndSelectGeneratedWardrobe(generatedArchive, prompt, provider);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
