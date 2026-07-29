const DEFAULT_API_BASE = "https://api.openai.com/v1";
export const DEFAULT_MODEL = "gpt-5.6-luna";

const MAX_API_KEY_CHARS = 8_192;
const MAX_API_BASE_CHARS = 2_048;
const MAX_MODEL_CHARS = 200;
const NODE_INSPECT = Symbol.for("nodejs.util.inspect.custom");

export type ProviderSource = "environment";

export interface ProviderSettings {
  readonly apiKey: string | null;
  readonly apiBase: string;
  readonly model: string;
  readonly source: ProviderSource;
}

export interface PublicProviderSettings {
  readonly mode: "demo" | "provider";
  readonly source: "demo" | ProviderSource;
  readonly model: string;
  readonly apiBase: string;
  readonly hasApiKey: boolean;
}

export class ProviderConfigurationError extends Error {
  readonly status = 400;
  readonly code = "invalid_provider_settings";

  constructor(message = "Provider settings are invalid.") {
    super(message);
    this.name = "ProviderConfigurationError";
  }
}

class ProviderSettingsSnapshot implements ProviderSettings {
  readonly apiBase: string;
  readonly model: string;
  readonly source: ProviderSource;
  readonly #apiKey: string | null;

  constructor(apiKey: string | null, apiBase: string, model: string, source: ProviderSource) {
    this.#apiKey = apiKey;
    this.apiBase = apiBase;
    this.model = model;
    this.source = source;
    Object.freeze(this);
  }

  get apiKey(): string | null {
    return this.#apiKey;
  }

  toJSON(): PublicProviderSettings {
    return toPublicSettings(this);
  }

  [NODE_INSPECT](): PublicProviderSettings {
    return toPublicSettings(this);
  }
}

function nonemptyEnvironmentValue(name: string): string | null {
  const value = process.env[name];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function validateApiKey(value: unknown): string {
  if (typeof value !== "string") {
    throw new ProviderConfigurationError("'apiKey' must be a string.");
  }
  const apiKey = value.trim();
  if (!apiKey) {
    throw new ProviderConfigurationError("'apiKey' must not be empty.");
  }
  if (apiKey.length > MAX_API_KEY_CHARS) {
    throw new ProviderConfigurationError("'apiKey' is too long.");
  }
  if (/\s|[\u0000-\u001f\u007f]/u.test(apiKey)) {
    throw new ProviderConfigurationError("'apiKey' contains invalid characters.");
  }
  return apiKey;
}

export function validateApiBase(value: unknown): string {
  if (typeof value !== "string") {
    throw new ProviderConfigurationError("'apiBase' must be a string.");
  }
  const input = value.trim();
  if (!input || input.length > MAX_API_BASE_CHARS) {
    throw new ProviderConfigurationError("'apiBase' must be a valid HTTP(S) URL.");
  }
  if (/[\u0000-\u001f\u007f]/u.test(input)) {
    throw new ProviderConfigurationError("'apiBase' contains invalid characters.");
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ProviderConfigurationError("'apiBase' must be a valid HTTP(S) URL.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ProviderConfigurationError(
      "'apiBase' must be an HTTP(S) URL without credentials, query, or fragment.",
    );
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const loopback = hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
  if (url.protocol === "http:" && !loopback) {
    throw new ProviderConfigurationError(
      "'apiBase' must use HTTPS unless it points to a loopback-only local service.",
    );
  }

  return url.toString().replace(/\/+$/u, "");
}

export function validateModel(value: unknown): string {
  if (typeof value !== "string") {
    throw new ProviderConfigurationError("'model' must be a string.");
  }
  const model = value.trim();
  if (
    !model ||
    model.length > MAX_MODEL_CHARS ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(model)
  ) {
    throw new ProviderConfigurationError("'model' contains invalid characters.");
  }
  return model;
}

function createSettings(
  apiKey: unknown,
  apiBase: unknown,
  model: unknown,
  source: ProviderSource,
): ProviderSettingsSnapshot {
  return new ProviderSettingsSnapshot(
    apiKey === null ? null : validateApiKey(apiKey),
    validateApiBase(apiBase),
    validateModel(model),
    source,
  );
}

function environmentSettings(): ProviderSettingsSnapshot {
  const apiKey = nonemptyEnvironmentValue("NPC_API_KEY") ?? nonemptyEnvironmentValue("OPENAI_API_KEY");
  return createSettings(
    apiKey,
    nonemptyEnvironmentValue("NPC_API_BASE") ?? DEFAULT_API_BASE,
    nonemptyEnvironmentValue("NPC_MODEL") ?? DEFAULT_MODEL,
    "environment",
  );
}

export function getProviderSettings(): Readonly<ProviderSettings> {
  return environmentSettings();
}

export function toPublicSettings(settings: ProviderSettings): PublicProviderSettings {
  return Object.freeze({
    mode: settings.apiKey ? "provider" : "demo",
    source: settings.apiKey ? settings.source : "demo",
    model: settings.model,
    apiBase: settings.apiBase,
    hasApiKey: Boolean(settings.apiKey),
  });
}

export function getPublicProviderSettings(): PublicProviderSettings {
  return toPublicSettings(getProviderSettings());
}
