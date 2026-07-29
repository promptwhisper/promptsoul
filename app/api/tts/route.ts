import { createHash, randomUUID } from "node:crypto";

import { synthesizeAivisText } from "../../../lib/server/aivis-service";
import { AivisTtsError, type AivisSynthesisOptions, type AivisVoiceSelector } from "../../../lib/server/aivis-types";
import {
  assertLocalSameOriginMutation,
  LocalMutationError,
  readJsonMutation,
} from "../../../lib/server/provider-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ValidatedTtsRequest {
  readonly text: string;
  readonly voice?: AivisVoiceSelector;
  readonly options?: AivisSynthesisOptions;
}

const VOICE_FIELDS = new Set(["speakerUuid", "speakerName", "styleName", "styleId"]);
const OPTION_FIELDS = new Set([
  "speedScale",
  "intonationScale",
  "tempoDynamicsScale",
  "volumeScale",
]);

function invalid(message: string): never {
  throw new AivisTtsError("TTS_INVALID_REQUEST", message);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") invalid(`'${field}' must be a string.`);
  const normalized = value.trim().normalize("NFKC");
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    invalid(`'${field}' is invalid.`);
  }
  return normalized;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(`'${field}' must be a finite number.`);
  return value;
}

function validateVoice(value: unknown): AivisVoiceSelector | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("'voice' must be an object.");
  const voice = value as Record<string, unknown>;
  if (Object.keys(voice).some((key) => !VOICE_FIELDS.has(key))) invalid("'voice' contains unsupported fields.");
  return {
    speakerUuid: optionalString(voice.speakerUuid, "voice.speakerUuid"),
    speakerName: optionalString(voice.speakerName, "voice.speakerName"),
    styleName: optionalString(voice.styleName, "voice.styleName"),
    styleId: optionalNumber(voice.styleId, "voice.styleId"),
  };
}

function validateOptions(value: unknown): AivisSynthesisOptions | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("'options' must be an object.");
  const options = value as Record<string, unknown>;
  if (Object.keys(options).some((key) => !OPTION_FIELDS.has(key))) invalid("'options' contains unsupported fields.");
  return {
    speedScale: optionalNumber(options.speedScale, "options.speedScale"),
    intonationScale: optionalNumber(options.intonationScale, "options.intonationScale"),
    tempoDynamicsScale: optionalNumber(options.tempoDynamicsScale, "options.tempoDynamicsScale"),
    volumeScale: optionalNumber(options.volumeScale, "options.volumeScale"),
  };
}

function validateTtsRequest(value: unknown): ValidatedTtsRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Request JSON must be an object.");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !["text", "voice", "options"].includes(key))) {
    invalid("Request contains unsupported fields.");
  }
  if (typeof object.text !== "string" || !object.text.trim()) invalid("'text' must be a non-empty string.");
  return {
    text: object.text,
    voice: validateVoice(object.voice),
    options: validateOptions(object.options),
  };
}

function jsonError(error: unknown, requestId: string): Response {
  if (error instanceof AivisTtsError || error instanceof LocalMutationError) {
    const availableVoices = error instanceof AivisTtsError
      ? error.details?.availableVoices
      : undefined;
    return Response.json({
      requestId,
      error: {
        code: error.code,
        message: error.message,
        ...(availableVoices ? { availableVoices } : {}),
      },
    }, {
      status: error.status,
      headers: {
        "Cache-Control": "no-store",
        "X-TTS-Request-Id": requestId,
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  return Response.json({
    requestId,
    error: { code: "TTS_INTERNAL_ERROR", message: "TTS synthesis failed." },
  }, {
    status: 500,
    headers: {
      "Cache-Control": "no-store",
      "X-TTS-Request-Id": requestId,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();
  const startedAt = performance.now();
  let textLength = 0;
  let textHash = "none";
  try {
    assertLocalSameOriginMutation(request);
    const payload = validateTtsRequest(await readJsonMutation(request));
    textLength = [...payload.text.trim()].length;
    textHash = createHash("sha256").update(payload.text.trim(), "utf8").digest("hex").slice(0, 16);
    const result = await synthesizeAivisText(payload.text, {
      voice: payload.voice,
      options: payload.options,
    });
    const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
    console.info("PromptSoul TTS", {
      requestId,
      textLength,
      textHash,
      elapsedMs,
      styleId: result.voice.styleId,
      cache: result.cache,
    });
    const audio = new ArrayBuffer(result.audio.byteLength);
    new Uint8Array(audio).set(result.audio);
    return new Response(audio, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "audio/wav",
        "X-Content-Type-Options": "nosniff",
        "X-TTS-Cache": result.cache,
        "X-TTS-Request-Id": requestId,
        "X-TTS-Style-Id": String(result.voice.styleId),
        "X-TTS-Synthesis-Ms": String(result.synthesisMs),
      },
    });
  } catch (error) {
    const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
    const code = error instanceof AivisTtsError || error instanceof LocalMutationError
      ? error.code
      : "TTS_INTERNAL_ERROR";
    console.warn("PromptSoul TTS failed", { requestId, textLength, textHash, elapsedMs, errorCode: code });
    return jsonError(error, requestId);
  }
}
