import {
  validateApiBase,
  validateApiKey,
  validateModel,
} from "./provider-store";

export const DSH_REALTIME_BACKEND = "dsh-realtime";
export const DEFAULT_DSH_API_BASE = "https://api.deepseek.com";
export const DEFAULT_DSH_MODEL = "deepseek-v4-flash";
const NODE_INSPECT = Symbol.for("nodejs.util.inspect.custom");

export interface DshRealtimeSettings {
  readonly enabled: boolean;
  readonly apiKey: string | null;
  readonly apiBase: string;
  readonly model: string;
}

export interface PublicDshRealtimeSettings {
  readonly backend: "provider" | typeof DSH_REALTIME_BACKEND;
  readonly configured: boolean;
  readonly model: string;
  readonly apiBase: string;
}

class DshRealtimeSettingsSnapshot implements DshRealtimeSettings {
  readonly enabled: boolean;
  readonly apiBase: string;
  readonly model: string;
  readonly #apiKey: string | null;

  constructor(enabled: boolean, apiKey: string | null, apiBase: string, model: string) {
    this.enabled = enabled;
    this.#apiKey = apiKey;
    this.apiBase = apiBase;
    this.model = model;
    Object.freeze(this);
  }

  get apiKey(): string | null {
    return this.#apiKey;
  }

  toJSON(): PublicDshRealtimeSettings {
    return toPublicDshRealtimeSettings(this);
  }

  [NODE_INSPECT](): PublicDshRealtimeSettings {
    return toPublicDshRealtimeSettings(this);
  }
}

function environmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | null {
  const value = environment[name]?.trim();
  return value || null;
}

export function getDshRealtimeSettings(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DshRealtimeSettings {
  const enabled = environmentValue(environment, "CHAT_BACKEND")?.toLocaleLowerCase()
    === DSH_REALTIME_BACKEND;
  if (!enabled) {
    return new DshRealtimeSettingsSnapshot(
      false,
      null,
      DEFAULT_DSH_API_BASE,
      DEFAULT_DSH_MODEL,
    );
  }
  const rawKey = environmentValue(environment, "DEEPSEEK_API_KEY");
  return new DshRealtimeSettingsSnapshot(
    true,
    rawKey === null ? null : validateApiKey(rawKey),
    validateApiBase(
      environmentValue(environment, "DEEPSEEK_BASE_URL") ?? DEFAULT_DSH_API_BASE,
    ),
    validateModel(environmentValue(environment, "DSH_MODEL") ?? DEFAULT_DSH_MODEL),
  );
}

export function toPublicDshRealtimeSettings(
  settings: DshRealtimeSettings,
): PublicDshRealtimeSettings {
  return Object.freeze({
    backend: settings.enabled ? DSH_REALTIME_BACKEND : "provider",
    configured: settings.enabled && settings.apiKey !== null,
    model: settings.model,
    apiBase: settings.apiBase,
  });
}
