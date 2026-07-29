import path from "node:path";

import {
  AIVIS_CACHE_FORMAT_VERSION,
  AivisAudioCache,
  createAivisCacheKey,
  isRiffWave,
} from "./aivis-cache";
import {
  AivisTtsError,
  toPublicAivisVoices,
  type AivisAudioQuery,
  type AivisClientConfig,
  type AivisErrorCode,
  type AivisHealthStatus,
  type AivisSpeaker,
  type AivisStyle,
  type AivisSynthesisOptions,
  type AivisSynthesisResult,
  type AivisVoiceSelector,
  type ResolvedAivisVoice,
} from "./aivis-types";

const DEFAULT_SPEAKERS_CACHE_TTL_MS = 60_000;
const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_AUDIO_RESPONSE_BYTES = 64 * 1024 * 1024;
const SIGNED_INT32_MIN = -2_147_483_648;
const SIGNED_INT32_MAX = 2_147_483_647;

export interface AivisClientDependencies {
  readonly fetchImpl?: typeof fetch;
  readonly cache?: AivisAudioCache;
  readonly now?: () => number;
  readonly speakersCacheTtlMs?: number;
}

export interface AivisSynthesizeTextRequest {
  readonly voice?: AivisVoiceSelector;
  readonly options?: AivisSynthesisOptions;
}

interface SpeakersCacheEntry {
  readonly speakers: readonly AivisSpeaker[];
  readonly expiresAt: number;
}

interface LoadedSpeakers {
  readonly speakers: readonly AivisSpeaker[];
  readonly fromCache: boolean;
}

type RequestStage = "speakers" | "audio_query" | "synthesis";

function normalizeName(value: string | undefined): string | undefined {
  const normalized = value?.trim().normalize("NFKC");
  return normalized || undefined;
}

export function normalizeAivisText(text: unknown, maxLength: number): string {
  if (typeof text !== "string") {
    throw new AivisTtsError("TTS_INVALID_REQUEST", "TTS text must be a string.");
  }
  const normalized = text.trim().normalize("NFKC");
  if (!normalized) {
    throw new AivisTtsError("TTS_INVALID_REQUEST", "TTS text must not be empty.");
  }
  if ([...normalized].length > maxLength) {
    throw new AivisTtsError("TTS_INVALID_REQUEST", "TTS text exceeds the configured limit.");
  }
  return normalized;
}

export function validateAivisStyleId(value: unknown): number {
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < SIGNED_INT32_MIN
    || value > SIGNED_INT32_MAX
  ) {
    throw new AivisTtsError(
      "TTS_INVALID_REQUEST",
      "AivisSpeech Style ID must be a signed 32-bit integer.",
    );
  }
  return value;
}

function validateScale(
  name: keyof AivisSynthesisOptions,
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new AivisTtsError(
      "TTS_INVALID_REQUEST",
      `'${name}' must be a finite number from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

export function validateAivisSynthesisOptions(
  options: AivisSynthesisOptions = {},
): AivisSynthesisOptions {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new AivisTtsError("TTS_INVALID_REQUEST", "TTS options must be an object.");
  }
  const allowed = new Set<keyof AivisSynthesisOptions>([
    "speedScale",
    "intonationScale",
    "tempoDynamicsScale",
    "volumeScale",
  ]);
  if (Object.keys(options).some((key) => !allowed.has(key as keyof AivisSynthesisOptions))) {
    throw new AivisTtsError("TTS_INVALID_REQUEST", "TTS options contain unsupported fields.");
  }
  return Object.freeze({
    speedScale: validateScale("speedScale", options.speedScale, 0.5, 2),
    intonationScale: validateScale("intonationScale", options.intonationScale, 0, 2),
    tempoDynamicsScale: validateScale("tempoDynamicsScale", options.tempoDynamicsScale, 0, 2),
    volumeScale: validateScale("volumeScale", options.volumeScale, 0, 2),
  });
}

export function applyAivisSynthesisOptions(
  query: AivisAudioQuery,
  options: AivisSynthesisOptions,
): AivisAudioQuery {
  const validated = validateAivisSynthesisOptions(options);
  const output: AivisAudioQuery = { ...query };
  if (validated.speedScale !== undefined) output.speedScale = validated.speedScale;
  if (validated.intonationScale !== undefined) output.intonationScale = validated.intonationScale;
  if (validated.tempoDynamicsScale !== undefined) {
    output.tempoDynamicsScale = validated.tempoDynamicsScale;
  }
  if (validated.volumeScale !== undefined) output.volumeScale = validated.volumeScale;
  return output;
}

function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new AivisTtsError("TTS_INVALID_REQUEST", "AIVIS_BASE_URL is invalid.");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const loopback = hostname === "localhost"
    || hostname === "::1"
    || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
  if (
    url.protocol !== "http:"
    || !loopback
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new AivisTtsError(
      "TTS_INVALID_REQUEST",
      "AIVIS_BASE_URL must be an unauthenticated loopback HTTP URL.",
    );
  }
  return url.toString().replace(/\/+$/u, "");
}

function validatePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AivisTtsError("TTS_INVALID_REQUEST", `${name} must be a positive integer.`);
  }
  return value;
}

function normalizeSelector(selector: AivisVoiceSelector): AivisVoiceSelector {
  if (!selector || typeof selector !== "object" || Array.isArray(selector)) {
    throw new AivisTtsError("TTS_INVALID_REQUEST", "TTS voice selector must be an object.");
  }
  const allowed = new Set<keyof AivisVoiceSelector>([
    "speakerUuid",
    "speakerName",
    "styleName",
    "styleId",
  ]);
  if (Object.keys(selector).some((key) => !allowed.has(key as keyof AivisVoiceSelector))) {
    throw new AivisTtsError("TTS_INVALID_REQUEST", "TTS voice selector contains unsupported fields.");
  }
  for (const [name, value] of [
    ["speakerUuid", selector.speakerUuid],
    ["speakerName", selector.speakerName],
    ["styleName", selector.styleName],
  ] as const) {
    if (value !== undefined && typeof value !== "string") {
      throw new AivisTtsError("TTS_INVALID_REQUEST", `'${name}' must be a string.`);
    }
  }
  return Object.freeze({
    speakerUuid: normalizeName(selector.speakerUuid),
    speakerName: normalizeName(selector.speakerName),
    styleName: normalizeName(selector.styleName),
    styleId: selector.styleId === undefined ? undefined : validateAivisStyleId(selector.styleId),
  });
}

function mergeSelector(
  base: AivisVoiceSelector,
  override: AivisVoiceSelector | undefined,
): AivisVoiceSelector {
  if (!override) return normalizeSelector(base);
  const normalizedBase = normalizeSelector(base);
  const normalizedOverride = normalizeSelector(override);
  const overridesSpeakerIdentity = normalizedOverride.speakerUuid !== undefined
    || normalizedOverride.speakerName !== undefined;
  const overridesVoiceTarget = overridesSpeakerIdentity
    || normalizedOverride.styleName !== undefined;
  return normalizeSelector({
    speakerUuid: overridesSpeakerIdentity
      ? normalizedOverride.speakerUuid
      : normalizedBase.speakerUuid,
    speakerName: overridesSpeakerIdentity
      ? normalizedOverride.speakerName
      : normalizedBase.speakerName,
    styleName: normalizedOverride.styleName ?? normalizedBase.styleName,
    // A global Style ID belongs to one concrete speaker/style pair. When a
    // request selects a different target by name or UUID, carrying over the
    // configured default ID would either reject that valid selection or point
    // at the wrong voice. Only inherit it when no target field was overridden.
    styleId: normalizedOverride.styleId
      ?? (overridesVoiceTarget ? undefined : normalizedBase.styleId),
  });
}

function isJsonContentType(response: Response): boolean {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return contentType === "application/json" || contentType?.endsWith("+json") === true;
}

function isWaveContentType(response: Response): boolean {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return contentType === "audio/wav" || contentType === "audio/x-wav";
}

async function readBoundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maximum) {
      await response.body?.cancel().catch(() => undefined);
      throw new RangeError("Response exceeds the configured byte limit.");
    }
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new RangeError("Response exceeds the configured byte limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

function parseStyle(document: unknown): AivisStyle | null {
  if (!document || typeof document !== "object" || Array.isArray(document)) return null;
  const object = document as Record<string, unknown>;
  if (
    typeof object.id !== "number"
    || !Number.isInteger(object.id)
    || object.id < SIGNED_INT32_MIN
    || object.id > SIGNED_INT32_MAX
    || typeof object.name !== "string"
    || !normalizeName(object.name)
  ) return null;
  if (object.type !== undefined && typeof object.type !== "string") return null;
  return Object.freeze({
    id: object.id,
    name: object.name.trim(),
    ...(typeof object.type === "string" ? { type: object.type } : {}),
  });
}

function parseSpeakers(document: unknown): readonly AivisSpeaker[] | null {
  if (!Array.isArray(document)) return null;
  const speakers: AivisSpeaker[] = [];
  for (const value of document) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const object = value as Record<string, unknown>;
    if (
      typeof object.name !== "string"
      || !normalizeName(object.name)
      || typeof object.speaker_uuid !== "string"
      || !normalizeName(object.speaker_uuid)
      || !Array.isArray(object.styles)
    ) return null;
    const styles = object.styles.map(parseStyle);
    if (styles.some((style) => style === null)) return null;
    speakers.push(Object.freeze({
      name: object.name.trim(),
      speaker_uuid: object.speaker_uuid.trim(),
      styles: Object.freeze(styles as AivisStyle[]),
    }));
  }
  return Object.freeze(speakers);
}

function parseAudioQuery(document: unknown): AivisAudioQuery | null {
  if (!document || typeof document !== "object" || Array.isArray(document)) return null;
  return document as AivisAudioQuery;
}

function voiceError(
  code: "TTS_VOICE_NOT_FOUND" | "TTS_VOICE_AMBIGUOUS",
  speakers: readonly AivisSpeaker[],
): AivisTtsError {
  return new AivisTtsError(
    code,
    code === "TTS_VOICE_NOT_FOUND"
      ? "The configured AivisSpeech voice or style is not installed."
      : "The configured AivisSpeech voice matches more than one installed candidate.",
    { details: { availableVoices: toPublicAivisVoices(speakers) } },
  );
}

export class AivisSpeechClient {
  readonly #config: AivisClientConfig;
  readonly #fetch: typeof fetch;
  readonly #cache: AivisAudioCache;
  readonly #now: () => number;
  readonly #speakersCacheTtlMs: number;
  #speakersCache: SpeakersCacheEntry | null = null;

  constructor(config: AivisClientConfig, dependencies: AivisClientDependencies = {}) {
    const speakersCacheTtlMs = dependencies.speakersCacheTtlMs
      ?? DEFAULT_SPEAKERS_CACHE_TTL_MS;
    if (!Number.isSafeInteger(speakersCacheTtlMs) || speakersCacheTtlMs < 0) {
      throw new RangeError("Aivis speakers cache TTL must be a non-negative integer.");
    }
    this.#config = Object.freeze({
      baseUrl: validateBaseUrl(config.baseUrl),
      defaultVoice: normalizeSelector(config.defaultVoice),
      defaultOptions: validateAivisSynthesisOptions(config.defaultOptions),
      maxTextLength: validatePositiveInteger(config.maxTextLength, "TTS_MAX_TEXT_LENGTH"),
      timeouts: Object.freeze({
        connectMs: validatePositiveInteger(config.timeouts.connectMs, "AIVIS_CONNECT_TIMEOUT_MS"),
        queryMs: validatePositiveInteger(config.timeouts.queryMs, "AIVIS_QUERY_TIMEOUT_MS"),
        synthesisMs: validatePositiveInteger(
          config.timeouts.synthesisMs,
          "AIVIS_SYNTHESIS_TIMEOUT_MS",
        ),
      }),
    });
    this.#fetch = dependencies.fetchImpl ?? fetch;
    this.#cache = dependencies.cache ?? new AivisAudioCache({
      enabled: false,
      directory: path.resolve(process.cwd(), ".cache/aivis-tts"),
      maxBytes: 1,
    });
    this.#now = dependencies.now ?? Date.now;
    this.#speakersCacheTtlMs = speakersCacheTtlMs;
  }

  async getSpeakers(options: { readonly forceRefresh?: boolean } = {}): Promise<readonly AivisSpeaker[]> {
    return (await this.#loadSpeakers(Boolean(options.forceRefresh))).speakers;
  }

  clearSpeakersCache(): void {
    this.#speakersCache = null;
  }

  async resolveVoice(selector?: AivisVoiceSelector): Promise<ResolvedAivisVoice> {
    const requested = mergeSelector(this.#config.defaultVoice, selector);
    const initial = await this.#loadSpeakers(false);
    try {
      return this.#resolveVoiceFrom(initial.speakers, requested);
    } catch (error) {
      if (
        error instanceof AivisTtsError
        && (error.code === "TTS_VOICE_NOT_FOUND" || error.code === "TTS_VOICE_AMBIGUOUS")
      ) {
        // The installed model catalog may have changed just after the first
        // request. Refresh once even when the initial catalog was freshly
        // fetched; never guess or randomly fall back after that retry.
        const refreshed = await this.#loadSpeakers(true);
        return this.#resolveVoiceFrom(refreshed.speakers, requested);
      }
      throw error;
    }
  }

  async createAudioQuery(text: string, styleId: number): Promise<AivisAudioQuery> {
    const normalizedText = normalizeAivisText(text, this.#config.maxTextLength);
    const id = validateAivisStyleId(styleId);
    const url = this.#endpoint("audio_query");
    url.searchParams.set("text", normalizedText);
    url.searchParams.set("speaker", String(id));
    return this.#request(
      url,
      { method: "POST", headers: { Accept: "application/json" } },
      this.#config.timeouts.queryMs,
      "audio_query",
      "TTS_AUDIO_QUERY_FAILED",
      async (response) => {
        if (!isJsonContentType(response)) {
          await response.body?.cancel().catch(() => undefined);
          throw new AivisTtsError(
            "TTS_AUDIO_QUERY_FAILED",
            "AivisSpeech returned a non-JSON AudioQuery response.",
            { details: { stage: "audio_query" } },
          );
        }
        let bytes: Uint8Array;
        try {
          bytes = await readBoundedBytes(response, MAX_JSON_RESPONSE_BYTES);
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          throw new AivisTtsError(
            "TTS_AUDIO_QUERY_FAILED",
            "AivisSpeech returned an invalid AudioQuery response.",
            { cause: error, details: { stage: "audio_query" } },
          );
        }
        const query = parseAudioQuery(parseJson(bytes));
        if (!query) {
          throw new AivisTtsError(
            "TTS_AUDIO_QUERY_FAILED",
            "AivisSpeech returned an invalid AudioQuery response.",
            { details: { stage: "audio_query" } },
          );
        }
        return query;
      },
    );
  }

  async synthesize(query: AivisAudioQuery, styleId: number): Promise<Uint8Array> {
    if (!query || typeof query !== "object" || Array.isArray(query)) {
      throw new AivisTtsError("TTS_INVALID_REQUEST", "AudioQuery must be an object.");
    }
    const id = validateAivisStyleId(styleId);
    let body: string;
    try {
      body = JSON.stringify(query);
    } catch (error) {
      throw new AivisTtsError(
        "TTS_INVALID_REQUEST",
        "AudioQuery must be JSON serializable.",
        { cause: error },
      );
    }
    const url = this.#endpoint("synthesis");
    url.searchParams.set("speaker", String(id));
    return this.#request(
      url,
      {
        method: "POST",
        headers: {
          Accept: "audio/wav",
          "Content-Type": "application/json",
        },
        body,
      },
      this.#config.timeouts.synthesisMs,
      "synthesis",
      "TTS_SYNTHESIS_FAILED",
      async (response) => {
        if (!isWaveContentType(response)) {
          await response.body?.cancel().catch(() => undefined);
          throw new AivisTtsError(
            "TTS_INVALID_AUDIO",
            "AivisSpeech returned an unexpected audio Content-Type.",
            { details: { stage: "synthesis" } },
          );
        }
        let audio: Uint8Array;
        try {
          audio = await readBoundedBytes(response, MAX_AUDIO_RESPONSE_BYTES);
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          throw new AivisTtsError(
            "TTS_INVALID_AUDIO",
            "AivisSpeech returned invalid or oversized audio.",
            { cause: error, details: { stage: "synthesis" } },
          );
        }
        if (!isRiffWave(audio)) {
          throw new AivisTtsError(
            "TTS_INVALID_AUDIO",
            "AivisSpeech did not return a valid RIFF/WAVE file.",
            { details: { stage: "synthesis" } },
          );
        }
        return audio;
      },
    );
  }

  async synthesizeText(
    text: string,
    request: AivisSynthesizeTextRequest = {},
  ): Promise<AivisSynthesisResult> {
    const normalizedText = normalizeAivisText(text, this.#config.maxTextLength);
    const requestedVoice = mergeSelector(this.#config.defaultVoice, request.voice);
    const hasExplicitStyleId = requestedVoice.styleId !== undefined;
    let voice = await this.resolveVoice(request.voice);
    const options = validateAivisSynthesisOptions({
      ...this.#config.defaultOptions,
      ...request.options,
    });
    try {
      return await this.#synthesizeResolvedText(normalizedText, voice, options);
    } catch (error) {
      if (
        !(error instanceof AivisTtsError)
        || error.code !== "TTS_AUDIO_QUERY_FAILED"
        || error.details?.stage !== "audio_query"
      ) throw error;

      const refreshedVoice = this.#resolveVoiceFrom(
        (await this.#loadSpeakers(true)).speakers,
        requestedVoice,
      );
      if (hasExplicitStyleId) {
        // A configured/requested global ID is never silently replaced. A stale
        // ID fails as VOICE_NOT_FOUND above; a still-installed ID preserves the
        // original AudioQuery failure without an implicit retry.
        throw error;
      }
      if (
        refreshedVoice.styleId === voice.styleId
        && refreshedVoice.speakerUuid === voice.speakerUuid
      ) throw error;

      voice = refreshedVoice;
      // Retry the full query/synthesis path at most once, under a cache key that
      // includes the newly resolved global Style ID.
      return this.#synthesizeResolvedText(normalizedText, voice, options);
    }
  }

  async #synthesizeResolvedText(
    normalizedText: string,
    voice: ResolvedAivisVoice,
    options: AivisSynthesisOptions,
  ): Promise<AivisSynthesisResult> {
    const key = createAivisCacheKey({
      version: AIVIS_CACHE_FORMAT_VERSION,
      text: normalizedText,
      speakerUuid: voice.speakerUuid,
      styleId: voice.styleId,
      styleName: voice.styleName,
      speedScale: options.speedScale ?? null,
      intonationScale: options.intonationScale ?? null,
      tempoDynamicsScale: options.tempoDynamicsScale ?? null,
      volumeScale: options.volumeScale ?? null,
    });

    let queryMs = 0;
    let synthesisMs = 0;
    const cached = await this.#cache.getOrCreate(key, async () => {
      let startedAt = this.#now();
      const query = await this.createAudioQuery(normalizedText, voice.styleId);
      queryMs = Math.max(0, this.#now() - startedAt);
      startedAt = this.#now();
      const audio = await this.synthesize(applyAivisSynthesisOptions(query, options), voice.styleId);
      synthesisMs = Math.max(0, this.#now() - startedAt);
      return audio;
    });
    return {
      audio: cached.audio,
      voice,
      cache: cached.status,
      queryMs,
      synthesisMs,
    };
  }

  async healthCheck(): Promise<AivisHealthStatus> {
    const startedAt = this.#now();
    try {
      const speakers = await this.getSpeakers({ forceRefresh: true });
      const voice = this.#resolveVoiceFrom(
        speakers,
        mergeSelector(this.#config.defaultVoice, undefined),
      );
      return {
        provider: "aivis",
        ready: true,
        engineReachable: true,
        voiceResolved: true,
        speakerName: voice.speakerName,
        styleName: voice.styleName,
        styleId: voice.styleId,
        latencyMs: Math.max(0, this.#now() - startedAt),
        error: null,
      };
    } catch (error) {
      const mapped = error instanceof AivisTtsError
        ? error
        : new AivisTtsError("TTS_INTERNAL_ERROR", "TTS health check failed.", { cause: error });
      const engineReachable = mapped.code !== "TTS_ENGINE_UNAVAILABLE"
        && mapped.code !== "TTS_ENGINE_TIMEOUT";
      return {
        provider: "aivis",
        ready: false,
        engineReachable,
        voiceResolved: false,
        speakerName: null,
        styleName: null,
        styleId: null,
        latencyMs: Math.max(0, this.#now() - startedAt),
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

  async #loadSpeakers(forceRefresh: boolean): Promise<LoadedSpeakers> {
    const cached = this.#speakersCache;
    if (!forceRefresh && cached && cached.expiresAt > this.#now()) {
      return { speakers: cached.speakers, fromCache: true };
    }

    const speakers = await this.#request(
      this.#endpoint("speakers"),
      { method: "GET", headers: { Accept: "application/json" } },
      this.#config.timeouts.connectMs,
      "speakers",
      "TTS_ENGINE_UNAVAILABLE",
      async (response) => {
        if (!isJsonContentType(response)) {
          await response.body?.cancel().catch(() => undefined);
          throw new AivisTtsError(
            "TTS_ENGINE_UNAVAILABLE",
            "AivisSpeech returned an invalid speaker catalog.",
            { details: { stage: "speakers" } },
          );
        }
        let bytes: Uint8Array;
        try {
          bytes = await readBoundedBytes(response, MAX_JSON_RESPONSE_BYTES);
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          throw new AivisTtsError(
            "TTS_ENGINE_UNAVAILABLE",
            "AivisSpeech returned an invalid speaker catalog.",
            { cause: error, details: { stage: "speakers" } },
          );
        }
        const parsed = parseSpeakers(parseJson(bytes));
        if (!parsed) {
          throw new AivisTtsError(
            "TTS_ENGINE_UNAVAILABLE",
            "AivisSpeech returned an invalid speaker catalog.",
            { details: { stage: "speakers" } },
          );
        }
        return parsed;
      },
    );
    this.#speakersCache = {
      speakers,
      expiresAt: this.#now() + this.#speakersCacheTtlMs,
    };
    return { speakers, fromCache: false };
  }

  #resolveVoiceFrom(
    speakers: readonly AivisSpeaker[],
    selector: AivisVoiceSelector,
  ): ResolvedAivisVoice {
    type Candidate = { speaker: AivisSpeaker; style: AivisStyle };
    let candidates: Candidate[] = speakers.flatMap((speaker) => (
      speaker.styles.map((style) => ({ speaker, style }))
    ));
    const speakerUuid = normalizeName(selector.speakerUuid);
    const speakerName = normalizeName(selector.speakerName);
    const styleName = normalizeName(selector.styleName);

    if (selector.styleId !== undefined) {
      const styleId = validateAivisStyleId(selector.styleId);
      candidates = candidates.filter(({ style }) => style.id === styleId);
      if (speakerUuid) {
        candidates = candidates.filter(({ speaker }) => (
          normalizeName(speaker.speaker_uuid) === speakerUuid
        ));
      } else if (speakerName) {
        candidates = candidates.filter(({ speaker }) => normalizeName(speaker.name) === speakerName);
      }
      if (styleName) {
        candidates = candidates.filter(({ style }) => normalizeName(style.name) === styleName);
      }
    } else {
      if (speakerUuid) {
        candidates = candidates.filter(({ speaker }) => (
          normalizeName(speaker.speaker_uuid) === speakerUuid
        ));
      } else if (speakerName) {
        candidates = candidates.filter(({ speaker }) => normalizeName(speaker.name) === speakerName);
      } else {
        throw new AivisTtsError(
          "TTS_INVALID_REQUEST",
          "AivisSpeech voice selection requires a speaker UUID or name.",
        );
      }
      if (styleName) {
        candidates = candidates.filter(({ style }) => normalizeName(style.name) === styleName);
      }
    }

    if (!candidates.length) throw voiceError("TTS_VOICE_NOT_FOUND", speakers);
    if (candidates.length > 1) throw voiceError("TTS_VOICE_AMBIGUOUS", speakers);
    const [{ speaker, style }] = candidates;
    return Object.freeze({
      speakerUuid: speaker.speaker_uuid,
      speakerName: speaker.name,
      styleName: style.name,
      styleId: style.id,
    });
  }

  #endpoint(pathname: string): URL {
    return new URL(pathname, `${this.#config.baseUrl}/`);
  }

  async #request<Result>(
    url: URL,
    init: RequestInit,
    timeoutMs: number,
    stage: RequestStage,
    failedCode: AivisErrorCode,
    consume: (response: Response) => Promise<Result>,
  ): Promise<Result> {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new AivisTtsError(
          "TTS_ENGINE_TIMEOUT",
          `AivisSpeech ${stage} request timed out.`,
          { details: { stage } },
        ));
      }, timeoutMs);
    });

    try {
      const perform = async (): Promise<Result> => {
        const response = await this.#fetch(url, {
          ...init,
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          if (response.status === 408 || response.status === 504) {
            throw new AivisTtsError(
              "TTS_ENGINE_TIMEOUT",
              `AivisSpeech ${stage} request timed out.`,
              { details: { stage } },
            );
          }
          throw new AivisTtsError(
            failedCode,
            stage === "audio_query"
              ? "AivisSpeech failed to create an AudioQuery."
              : stage === "synthesis"
                ? "AivisSpeech failed to synthesize audio."
                : "AivisSpeech Engine is unavailable.",
            { details: { stage } },
          );
        }
        return consume(response);
      };
      return await Promise.race([perform(), timeout]);
    } catch (error) {
      if (error instanceof AivisTtsError) throw error;
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new AivisTtsError(
          "TTS_ENGINE_TIMEOUT",
          `AivisSpeech ${stage} request timed out.`,
          { cause: error, details: { stage } },
        );
      }
      throw new AivisTtsError(
        "TTS_ENGINE_UNAVAILABLE",
        "AivisSpeech Engine is unavailable.",
        { cause: error, details: { stage } },
      );
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }
}
