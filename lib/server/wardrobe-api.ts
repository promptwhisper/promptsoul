import { LocalMutationError } from "@/lib/server/provider-request";
import { WardrobeError } from "@/lib/server/wardrobe-service";

const PRESET_ID_PATTERN = /^(?:original|outfit_[0-9a-f]{12})$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.every((key) => allowed.includes(key)) && keys.length >= 1;
}

export function parseGenerateWardrobeRequest(value: unknown): { prompt: string } {
  if (!isRecord(value) || !hasExactKeys(value, ["prompt"]) || Object.keys(value).length !== 1) {
    throw new WardrobeError(400, "invalid_request", "Request must contain only prompt.");
  }
  if (typeof value.prompt !== "string") {
    throw new WardrobeError(400, "invalid_prompt", "Prompt must be a string.");
  }
  const prompt = value.prompt.replace(/\s+/gu, " ").trim();
  if (prompt.length < 3 || prompt.length > 1_200) {
    throw new WardrobeError(400, "invalid_prompt", "Prompt must contain between 3 and 1200 characters.");
  }
  return { prompt };
}

export function parseSelectWardrobeRequest(value: unknown): {
  presetId: string;
  revision?: number;
} {
  if (!isRecord(value) || !hasExactKeys(value, ["presetId", "revision"]) || !("presetId" in value)) {
    throw new WardrobeError(400, "invalid_request", "Request must contain presetId and an optional revision.");
  }
  if (typeof value.presetId !== "string" || !PRESET_ID_PATTERN.test(value.presetId)) {
    throw new WardrobeError(400, "invalid_preset_id", "Preset ID is invalid.");
  }
  if (
    value.revision !== undefined
    && (!Number.isInteger(value.revision) || Number(value.revision) < 1 || Number(value.revision) > Number.MAX_SAFE_INTEGER)
  ) {
    throw new WardrobeError(400, "invalid_revision", "Revision must be a positive integer.");
  }
  return {
    presetId: value.presetId,
    revision: value.revision === undefined ? undefined : Number(value.revision),
  };
}

export function wardrobeErrorResponse(error: unknown): Response {
  if (error instanceof WardrobeError || error instanceof LocalMutationError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  console.error("PromptSoul wardrobe request failed.", error);
  return Response.json(
    { error: { code: "wardrobe_internal_error", message: "The wardrobe request failed." } },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}
