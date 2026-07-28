const DEFAULT_VOICE_API_URL = "https://api.openai.com/v1/audio/speech";
export const DEFAULT_VOICE_MODEL = "gpt-4o-mini-tts";
export const DEFAULT_VOICE_SPEAKER = "alloy";
export const DEFAULT_VOICE_SPEED = 1;

const MAX_API_KEY_CHARS = 8_192;
const MAX_API_URL_CHARS = 2_048;
const MAX_MODEL_CHARS = 200;
const MAX_SPEAKER_CHARS = 200;
const NODE_INSPECT = Symbol.for("nodejs.util.inspect.custom");

export type VoiceSettingsSource = "environment" | "runtime";

export interface VoiceSettings {
  readonly enabled: boolean;
  readonly apiKey: string | null;
  readonly apiUrl: string;
  readonly model: string;
  readonly speaker: string;
  readonly speed: number;
  readonly source: VoiceSettingsSource;
}

export interface PublicVoiceSettings {
  readonly mode: "disabled" | "voice";
  readonly source: VoiceSettingsSource;
  readonly engine: "openaiCompatible";
  readonly apiUrl: string;
  readonly model: string;
  readonly speaker: string;
  readonly speed: number;
  readonly hasApiKey: boolean;
}

export class VoiceConfigurationError extends Error {
  readonly status = 400;
  readonly code = "invalid_voice_settings";

  constructor(message = "Voice settings are invalid.") {
    super(message);
    this.name = "VoiceConfigurationError";
  }
}

class VoiceSettingsSnapshot implements VoiceSettings {
  readonly enabled: boolean;
  readonly apiUrl: string;
  readonly model: string;
  readonly speaker: string;
  readonly speed: number;
  readonly source: VoiceSettingsSource;
  readonly #apiKey: string | null;

  constructor(
    enabled: boolean,
    apiKey: string | null,
    apiUrl: string,
    model: string,
    speaker: string,
    speed: number,
    source: VoiceSettingsSource,
  ) {
    this.enabled = enabled;
    this.#apiKey = apiKey;
    this.apiUrl = apiUrl;
    this.model = model;
    this.speaker = speaker;
    this.speed = speed;
    this.source = source;
    Object.freeze(this);
  }

  get apiKey(): string | null {
    return this.#apiKey;
  }

  toJSON(): PublicVoiceSettings {
    return toPublicVoiceSettings(this);
  }

  [NODE_INSPECT](): PublicVoiceSettings {
    return toPublicVoiceSettings(this);
  }
}

interface RuntimeVoiceStore {
  override: VoiceSettingsSnapshot | null;
}

const STORE_KEY: unique symbol = Symbol.for("promptsoul.voice.runtime.v1") as never;
type GlobalWithVoiceStore = typeof globalThis & {
  [STORE_KEY]?: RuntimeVoiceStore;
};

function runtimeStore(): RuntimeVoiceStore {
  const target = globalThis as GlobalWithVoiceStore;
  if (!target[STORE_KEY]) target[STORE_KEY] = { override: null };
  return target[STORE_KEY];
}

function nonemptyEnvironmentValue(name: string): string | null {
  const value = process.env[name];
  if (value === undefined) return null;
  return value.trim() || null;
}

function environmentEnabled(): boolean {
  const value = nonemptyEnvironmentValue("NPC_TTS_ENABLED");
  return value ? /^(?:1|true|yes|on)$/iu.test(value) : false;
}

function validateEnabled(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new VoiceConfigurationError("'enabled' must be a boolean.");
  }
  return value;
}

function validateApiKey(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new VoiceConfigurationError("'apiKey' must be a string.");
  }
  const apiKey = value.trim();
  if (
    !apiKey
    || apiKey.length > MAX_API_KEY_CHARS
    || /\s|[\u0000-\u001f\u007f]/u.test(apiKey)
  ) {
    throw new VoiceConfigurationError("'apiKey' contains invalid characters.");
  }
  return apiKey;
}

function validateApiUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new VoiceConfigurationError("'apiUrl' must be a string.");
  }
  const input = value.trim();
  if (!input || input.length > MAX_API_URL_CHARS || /[\u0000-\u001f\u007f]/u.test(input)) {
    throw new VoiceConfigurationError("'apiUrl' must be a valid HTTP(S) URL.");
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new VoiceConfigurationError("'apiUrl' must be a valid HTTP(S) URL.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || !url.hostname
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new VoiceConfigurationError(
      "'apiUrl' must be an HTTP(S) URL without credentials, query, or fragment.",
    );
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const loopback = hostname === "localhost"
    || hostname === "::1"
    || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
  if (url.protocol === "http:" && !loopback) {
    throw new VoiceConfigurationError(
      "'apiUrl' must use HTTPS unless it points to a loopback-only local service.",
    );
  }
  return url.toString().replace(/\/+$/u, "");
}

function validateModel(value: unknown): string {
  if (typeof value !== "string") {
    throw new VoiceConfigurationError("'model' must be a string.");
  }
  const model = value.trim();
  if (
    !model
    || model.length > MAX_MODEL_CHARS
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(model)
  ) {
    throw new VoiceConfigurationError("'model' contains invalid characters.");
  }
  return model;
}

function validateSpeaker(value: unknown): string {
  if (typeof value !== "string") {
    throw new VoiceConfigurationError("'speaker' must be a string.");
  }
  const speaker = value.trim();
  if (
    speaker.length > MAX_SPEAKER_CHARS
    || /[\u0000-\u001f\u007f]/u.test(speaker)
  ) {
    throw new VoiceConfigurationError("'speaker' contains invalid characters.");
  }
  return speaker;
}

function validateSpeed(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0.25 || value > 4) {
    throw new VoiceConfigurationError("'speed' must be a number from 0.25 to 4.");
  }
  return value;
}

function createSettings(
  enabled: unknown,
  apiKey: unknown,
  apiUrl: unknown,
  model: unknown,
  speaker: unknown,
  speed: unknown,
  source: VoiceSettingsSource,
): VoiceSettingsSnapshot {
  return new VoiceSettingsSnapshot(
    validateEnabled(enabled),
    validateApiKey(apiKey),
    validateApiUrl(apiUrl),
    validateModel(model),
    validateSpeaker(speaker),
    validateSpeed(speed),
    source,
  );
}

function environmentSettings(): VoiceSettingsSnapshot {
  return createSettings(
    environmentEnabled(),
    nonemptyEnvironmentValue("NPC_TTS_API_KEY"),
    nonemptyEnvironmentValue("NPC_TTS_API_URL") ?? DEFAULT_VOICE_API_URL,
    nonemptyEnvironmentValue("NPC_TTS_MODEL") ?? DEFAULT_VOICE_MODEL,
    nonemptyEnvironmentValue("NPC_TTS_SPEAKER") ?? DEFAULT_VOICE_SPEAKER,
    Number(nonemptyEnvironmentValue("NPC_TTS_SPEED") ?? DEFAULT_VOICE_SPEED),
    "environment",
  );
}

export function getVoiceSettings(): Readonly<VoiceSettings> {
  return runtimeStore().override ?? environmentSettings();
}

export function toPublicVoiceSettings(settings: VoiceSettings): PublicVoiceSettings {
  return Object.freeze({
    mode: settings.enabled ? "voice" : "disabled",
    source: settings.source,
    engine: "openaiCompatible",
    apiUrl: settings.apiUrl,
    model: settings.model,
    speaker: settings.speaker,
    speed: settings.speed,
    hasApiKey: Boolean(settings.apiKey),
  });
}

export function getPublicVoiceSettings(): PublicVoiceSettings {
  return toPublicVoiceSettings(getVoiceSettings());
}

export function setRuntimeVoiceSettings(input: unknown): PublicVoiceSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new VoiceConfigurationError("Request JSON must be an object.");
  }
  const object = input as Record<string, unknown>;
  const allowed = new Set(["enabled", "apiKey", "apiUrl", "model", "speaker", "speed"]);
  if (Object.keys(object).some((key) => !allowed.has(key))) {
    throw new VoiceConfigurationError("Voice settings contain unsupported fields.");
  }
  if (
    !("enabled" in object)
    || !("apiKey" in object)
    || !("apiUrl" in object)
    || !("model" in object)
    || !("speaker" in object)
    || !("speed" in object)
  ) {
    throw new VoiceConfigurationError(
      "'enabled', 'apiKey', 'apiUrl', 'model', 'speaker', and 'speed' are required.",
    );
  }
  const next = createSettings(
    object.enabled,
    object.apiKey,
    object.apiUrl,
    object.model,
    object.speaker,
    object.speed,
    "runtime",
  );
  runtimeStore().override = next;
  return toPublicVoiceSettings(next);
}

export function resetRuntimeVoiceSettings(): PublicVoiceSettings {
  runtimeStore().override = null;
  return toPublicVoiceSettings(environmentSettings());
}
