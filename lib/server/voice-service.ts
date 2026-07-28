import {
  VoiceEngineAdapter,
  VoiceEngineError,
  type VoiceService,
} from "@aituber-onair/voice";

import { ALLOWED_EMOTIONS, type Emotion } from "./chat-service";
import { getVoiceSettings, type VoiceSettings } from "./voice-store";

const MAX_VOICE_TEXT_CHARS = 4_000;
const MAX_VOICE_RESPONSE_BYTES = 16 * 1024 * 1024;
const EMOTION_SET = new Set<string>(ALLOWED_EMOTIONS);

export interface VoiceResult {
  readonly audio: ArrayBuffer;
  readonly contentType: string;
}

export interface VoiceDependencies {
  readonly settings?: VoiceSettings;
  readonly createService?: (
    settings: VoiceSettings,
    onAudio: (audio: ArrayBuffer) => Promise<void>,
  ) => Pick<VoiceService, "speak">;
}

export class VoiceApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "VoiceApiError";
    this.status = status;
    this.code = code;
  }
}

function validateVoicePayload(payload: unknown): { text: string; emotion: Emotion } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new VoiceApiError(400, "invalid_request", "Request JSON must be an object.");
  }
  const object = payload as Record<string, unknown>;
  if (Object.keys(object).some((key) => key !== "text" && key !== "emotion")) {
    throw new VoiceApiError(400, "invalid_request", "Request contains unsupported fields.");
  }
  if (typeof object.text !== "string" || !object.text.trim()) {
    throw new VoiceApiError(400, "invalid_voice_text", "'text' must be a non-empty string.");
  }
  const text = object.text.trim();
  if (text.length > MAX_VOICE_TEXT_CHARS) {
    throw new VoiceApiError(413, "voice_text_too_large", "'text' is too long.");
  }
  const rawEmotion = object.emotion ?? "neutral";
  if (typeof rawEmotion !== "string" || !EMOTION_SET.has(rawEmotion.trim().toLowerCase())) {
    throw new VoiceApiError(400, "invalid_voice_emotion", "'emotion' is not supported.");
  }
  return { text, emotion: rawEmotion.trim().toLowerCase() as Emotion };
}

function createVoiceService(
  settings: VoiceSettings,
  onAudio: (audio: ArrayBuffer) => Promise<void>,
): VoiceService {
  return new VoiceEngineAdapter({
    engineType: "openaiCompatible",
    apiKey: settings.apiKey ?? undefined,
    speaker: settings.speaker,
    openAiCompatibleApiUrl: settings.apiUrl,
    openAiCompatibleModel: settings.model,
    openAiCompatibleSpeed: settings.speed,
    onPlay: onAudio,
  });
}

function detectAudioContentType(audio: ArrayBuffer): string {
  const bytes = new Uint8Array(audio, 0, Math.min(audio.byteLength, 16));
  const ascii = String.fromCharCode(...bytes);
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WAVE") return "audio/wav";
  if (ascii.startsWith("OggS")) return "audio/ogg";
  if (ascii.startsWith("fLaC")) return "audio/flac";
  if (ascii.startsWith("ID3") || (bytes[0] === 0xff && (bytes[1] ?? 0) >= 0xe0)) {
    return "audio/mpeg";
  }
  if (ascii.slice(4, 8) === "ftyp") return "audio/mp4";
  return "application/octet-stream";
}

function mapVoiceError(error: unknown): VoiceApiError {
  if (error instanceof VoiceApiError) return error;
  if (error instanceof VoiceEngineError) {
    if (error.kind === "configuration") {
      return new VoiceApiError(400, "voice_configuration_error", "Voice settings are invalid.");
    }
    if (error.statusCode === 401 || error.statusCode === 403) {
      return new VoiceApiError(
        502,
        "voice_auth_error",
        "The configured voice provider rejected the server credentials.",
      );
    }
    if (
      error.kind === "network"
      && error.cause instanceof Error
      && error.cause.name === "AbortError"
    ) {
      return new VoiceApiError(504, "voice_timeout", "The configured voice provider timed out.");
    }
  }
  return new VoiceApiError(
    502,
    "voice_provider_error",
    "The configured voice provider is unavailable.",
  );
}

export async function synthesizeVoice(
  payload: unknown,
  dependencies: VoiceDependencies = {},
): Promise<VoiceResult> {
  const { text, emotion } = validateVoicePayload(payload);
  const settings = dependencies.settings ?? getVoiceSettings();
  if (!settings.enabled) {
    throw new VoiceApiError(503, "voice_disabled", "Voice synthesis is disabled.");
  }

  let audio: ArrayBuffer | null = null;
  try {
    const onAudio = async (nextAudio: ArrayBuffer) => {
      audio = nextAudio;
    };
    const service = dependencies.createService?.(settings, onAudio)
      ?? createVoiceService(settings, onAudio);
    await service.speak({ text, emotion });
  } catch (error) {
    throw mapVoiceError(error);
  }

  const result = audio as ArrayBuffer | null;
  if (!result || result.byteLength < 1) {
    throw new VoiceApiError(
      502,
      "voice_response_invalid",
      "The voice provider returned empty audio.",
    );
  }
  if (result.byteLength > MAX_VOICE_RESPONSE_BYTES) {
    throw new VoiceApiError(
      502,
      "voice_response_too_large",
      "The voice provider response was too large.",
    );
  }
  return {
    audio: result,
    contentType: detectAudioContentType(result),
  };
}
