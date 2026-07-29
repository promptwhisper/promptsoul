import path from "node:path";

import { AivisAudioCache, type AivisAudioCacheConfig } from "./aivis-cache";
import {
  AivisSpeechClient,
  validateAivisStyleId,
  type AivisClientDependencies,
  type AivisSynthesizeTextRequest,
} from "./aivis-client";
import {
  AivisTtsError,
  toPublicAivisVoices,
  type AivisClientConfig,
  type AivisHealthStatus,
  type AivisSynthesisResult,
  type PublicAivisVoice,
} from "./aivis-types";

export const DEFAULT_AIVIS_BASE_URL = "http://127.0.0.1:10101";
export const DEFAULT_AIVIS_SPEAKER_UUID = "5680ac39-43c9-487a-bc3e-018c0d29cc38";
export const DEFAULT_AIVIS_SPEAKER_NAME = "コハク";
export const DEFAULT_AIVIS_STYLE_NAME = "あまあま";
export const DEFAULT_AIVIS_TEST_TEXT = "おかえりなさい。今日も会えて、すごくうれしいです。";

const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
const DEFAULT_QUERY_TIMEOUT_MS = 15_000;
const DEFAULT_SYNTHESIS_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TEXT_LENGTH = 500;
const DEFAULT_CACHE_MAX_MB = 256;
const DEFAULT_CACHE_DIRECTORY = ".cache/aivis-tts";

export interface AivisRuntimeConfig extends AivisClientConfig {
  readonly provider: "aivis";
  readonly cache: AivisAudioCacheConfig;
  readonly autostart: boolean;
}

export type AivisEnvironment = Readonly<Record<string, string | undefined>>;

export interface AivisServiceDependencies extends AivisClientDependencies {
  readonly environment?: AivisEnvironment;
  readonly cwd?: string;
}

interface SingletonService {
  readonly signature: string;
  readonly client: AivisSpeechClient;
}

let singleton: SingletonService | null = null;

function optionalEnvironmentValue(
  environment: AivisEnvironment,
  name: string,
): string | undefined {
  const value = environment[name]?.trim();
  return value || undefined;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new AivisTtsError("TTS_INVALID_REQUEST", `${name} must be a positive integer.`);
  }
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback;
  if (/^(?:1|true|yes|on)$/iu.test(value)) return true;
  if (/^(?:0|false|no|off)$/iu.test(value)) return false;
  throw new AivisTtsError("TTS_INVALID_REQUEST", `${name} must be true or false.`);
}

function parseOptionalNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new AivisTtsError("TTS_INVALID_REQUEST", `${name} must be a finite number.`);
  }
  return parsed;
}

function parseStyleId(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  return validateAivisStyleId(Number(value));
}

export function loadAivisTtsConfig(
  environment: AivisEnvironment = process.env,
  cwd = process.cwd(),
): AivisRuntimeConfig {
  const provider = optionalEnvironmentValue(environment, "TTS_PROVIDER")?.toLowerCase() ?? "aivis";
  if (provider !== "aivis") {
    throw new AivisTtsError(
      "TTS_INVALID_REQUEST",
      "TTS_PROVIDER must be 'aivis' for the local AivisSpeech integration.",
    );
  }
  const cacheMaximumMb = parsePositiveInteger(
    optionalEnvironmentValue(environment, "TTS_CACHE_MAX_MB"),
    DEFAULT_CACHE_MAX_MB,
    "TTS_CACHE_MAX_MB",
  );
  const cacheDirectory = optionalEnvironmentValue(environment, "TTS_CACHE_DIR")
    ?? DEFAULT_CACHE_DIRECTORY;
  const configuredSpeakerUuid = environment.AIVIS_SPEAKER_UUID;
  return Object.freeze({
    provider: "aivis",
    baseUrl: optionalEnvironmentValue(environment, "AIVIS_BASE_URL") ?? DEFAULT_AIVIS_BASE_URL,
    defaultVoice: Object.freeze({
      // An explicitly blank UUID opts into the documented speaker-name fallback.
      speakerUuid: configuredSpeakerUuid === undefined
        ? DEFAULT_AIVIS_SPEAKER_UUID
        : configuredSpeakerUuid.trim() || undefined,
      speakerName: optionalEnvironmentValue(environment, "AIVIS_SPEAKER_NAME")
        ?? DEFAULT_AIVIS_SPEAKER_NAME,
      styleName: optionalEnvironmentValue(environment, "AIVIS_STYLE_NAME")
        ?? DEFAULT_AIVIS_STYLE_NAME,
      styleId: parseStyleId(optionalEnvironmentValue(environment, "AIVIS_STYLE_ID")),
    }),
    defaultOptions: Object.freeze({
      speedScale: parseOptionalNumber(
        optionalEnvironmentValue(environment, "AIVIS_SPEED_SCALE"),
        "AIVIS_SPEED_SCALE",
      ),
      intonationScale: parseOptionalNumber(
        optionalEnvironmentValue(environment, "AIVIS_INTONATION_SCALE"),
        "AIVIS_INTONATION_SCALE",
      ),
      tempoDynamicsScale: parseOptionalNumber(
        optionalEnvironmentValue(environment, "AIVIS_TEMPO_DYNAMICS_SCALE"),
        "AIVIS_TEMPO_DYNAMICS_SCALE",
      ),
      volumeScale: parseOptionalNumber(
        optionalEnvironmentValue(environment, "AIVIS_VOLUME_SCALE"),
        "AIVIS_VOLUME_SCALE",
      ),
    }),
    maxTextLength: parsePositiveInteger(
      optionalEnvironmentValue(environment, "TTS_MAX_TEXT_LENGTH"),
      DEFAULT_MAX_TEXT_LENGTH,
      "TTS_MAX_TEXT_LENGTH",
    ),
    timeouts: Object.freeze({
      connectMs: parsePositiveInteger(
        optionalEnvironmentValue(environment, "AIVIS_CONNECT_TIMEOUT_MS"),
        DEFAULT_CONNECT_TIMEOUT_MS,
        "AIVIS_CONNECT_TIMEOUT_MS",
      ),
      queryMs: parsePositiveInteger(
        optionalEnvironmentValue(environment, "AIVIS_QUERY_TIMEOUT_MS"),
        DEFAULT_QUERY_TIMEOUT_MS,
        "AIVIS_QUERY_TIMEOUT_MS",
      ),
      synthesisMs: parsePositiveInteger(
        optionalEnvironmentValue(environment, "AIVIS_SYNTHESIS_TIMEOUT_MS"),
        DEFAULT_SYNTHESIS_TIMEOUT_MS,
        "AIVIS_SYNTHESIS_TIMEOUT_MS",
      ),
    }),
    cache: Object.freeze({
      enabled: parseBoolean(
        optionalEnvironmentValue(environment, "TTS_CACHE_ENABLED"),
        true,
        "TTS_CACHE_ENABLED",
      ),
      directory: path.resolve(cwd, cacheDirectory),
      maxBytes: cacheMaximumMb * 1024 * 1024,
    }),
    autostart: parseBoolean(
      optionalEnvironmentValue(environment, "AIVIS_AUTOSTART"),
      false,
      "AIVIS_AUTOSTART",
    ),
  });
}

export function createAivisSpeechClient(
  dependencies: AivisServiceDependencies = {},
): AivisSpeechClient {
  const config = loadAivisTtsConfig(
    dependencies.environment ?? process.env,
    dependencies.cwd ?? process.cwd(),
  );
  return new AivisSpeechClient(config, {
    fetchImpl: dependencies.fetchImpl,
    now: dependencies.now,
    speakersCacheTtlMs: dependencies.speakersCacheTtlMs,
    cache: dependencies.cache ?? new AivisAudioCache(config.cache),
  });
}

export function getAivisSpeechClient(): AivisSpeechClient {
  const config = loadAivisTtsConfig();
  const signature = JSON.stringify(config);
  if (!singleton || singleton.signature !== signature) {
    singleton = {
      signature,
      client: new AivisSpeechClient(config, {
        cache: new AivisAudioCache(config.cache),
      }),
    };
  }
  return singleton.client;
}

export function resetAivisServiceForTests(): void {
  singleton = null;
}

function clientFor(dependencies?: AivisServiceDependencies): AivisSpeechClient {
  return dependencies ? createAivisSpeechClient(dependencies) : getAivisSpeechClient();
}

export async function listAivisVoices(
  dependencies?: AivisServiceDependencies,
): Promise<readonly PublicAivisVoice[]> {
  return toPublicAivisVoices(await clientFor(dependencies).getSpeakers({ forceRefresh: true }));
}

export async function getAivisTtsStatus(
  dependencies?: AivisServiceDependencies,
): Promise<AivisHealthStatus> {
  const startedAt = Date.now();
  try {
    return await clientFor(dependencies).healthCheck();
  } catch (error) {
    const mapped = error instanceof AivisTtsError
      ? error
      : new AivisTtsError("TTS_INTERNAL_ERROR", "TTS health check failed.", { cause: error });
    return {
      provider: "aivis",
      ready: false,
      engineReachable: false,
      voiceResolved: false,
      speakerName: null,
      styleName: null,
      styleId: null,
      latencyMs: Math.max(0, Date.now() - startedAt),
      error: {
        code: mapped.code,
        message: mapped.message,
        ...(mapped.details?.availableVoices
          ? { availableVoices: mapped.details.availableVoices }
          : {}),
      },
    };
  }
}

export async function synthesizeAivisText(
  text: string,
  request: AivisSynthesizeTextRequest = {},
  dependencies?: AivisServiceDependencies,
): Promise<AivisSynthesisResult> {
  return clientFor(dependencies).synthesizeText(text, request);
}
