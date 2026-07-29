export const AIVIS_ERROR_CODES = [
  "TTS_ENGINE_UNAVAILABLE",
  "TTS_ENGINE_TIMEOUT",
  "TTS_VOICE_NOT_FOUND",
  "TTS_VOICE_AMBIGUOUS",
  "TTS_INVALID_REQUEST",
  "TTS_AUDIO_QUERY_FAILED",
  "TTS_SYNTHESIS_FAILED",
  "TTS_INVALID_AUDIO",
  "TTS_INTERNAL_ERROR",
] as const;

export type AivisErrorCode = (typeof AIVIS_ERROR_CODES)[number];

export interface AivisStyle {
  readonly id: number;
  readonly name: string;
  readonly type?: string;
}

export interface AivisSpeaker {
  readonly name: string;
  readonly speaker_uuid: string;
  readonly styles: readonly AivisStyle[];
}

export interface PublicAivisStyle {
  readonly id: number;
  readonly name: string;
}

export interface PublicAivisVoice {
  readonly speakerUuid: string;
  readonly speakerName: string;
  readonly styles: readonly PublicAivisStyle[];
}

export interface AivisVoiceSelector {
  readonly speakerUuid?: string;
  readonly speakerName?: string;
  readonly styleName?: string;
  readonly styleId?: number;
}

export interface ResolvedAivisVoice {
  readonly speakerUuid: string;
  readonly speakerName: string;
  readonly styleName: string;
  readonly styleId: number;
}

/**
 * AivisSpeech extends VOICEVOX's AudioQuery over time. The index signature is
 * intentional: callers must round-trip fields introduced by newer engines.
 */
export interface AivisAudioQuery {
  readonly accent_phrases?: unknown;
  readonly kana?: unknown;
  speedScale?: number;
  pitchScale?: number;
  intonationScale?: number;
  tempoDynamicsScale?: number;
  volumeScale?: number;
  pauseLength?: number | null;
  pauseLengthScale?: number;
  [key: string]: unknown;
}

export interface AivisSynthesisOptions {
  readonly speedScale?: number;
  readonly intonationScale?: number;
  readonly tempoDynamicsScale?: number;
  readonly volumeScale?: number;
}

export interface AivisTimeouts {
  readonly connectMs: number;
  readonly queryMs: number;
  readonly synthesisMs: number;
}

export interface AivisClientConfig {
  readonly baseUrl: string;
  readonly defaultVoice: AivisVoiceSelector;
  readonly defaultOptions?: AivisSynthesisOptions;
  readonly maxTextLength: number;
  readonly timeouts: AivisTimeouts;
}

export interface AivisSynthesisResult {
  readonly audio: Uint8Array;
  readonly voice: ResolvedAivisVoice;
  readonly cache: "hit" | "miss" | "disabled";
  readonly queryMs: number;
  readonly synthesisMs: number;
}

export interface AivisHealthStatus {
  readonly provider: "aivis";
  readonly ready: boolean;
  readonly engineReachable: boolean;
  readonly voiceResolved: boolean;
  readonly speakerName: string | null;
  readonly styleName: string | null;
  readonly styleId: number | null;
  readonly latencyMs: number;
  readonly error: {
    readonly code: AivisErrorCode;
    readonly message: string;
    readonly availableVoices?: readonly PublicAivisVoice[];
  } | null;
}

export interface AivisErrorDetails {
  readonly stage?: "speakers" | "audio_query" | "synthesis";
  readonly availableVoices?: readonly PublicAivisVoice[];
}

const DEFAULT_ERROR_STATUS: Readonly<Record<AivisErrorCode, number>> = Object.freeze({
  TTS_ENGINE_UNAVAILABLE: 503,
  TTS_ENGINE_TIMEOUT: 504,
  TTS_VOICE_NOT_FOUND: 503,
  TTS_VOICE_AMBIGUOUS: 409,
  TTS_INVALID_REQUEST: 400,
  TTS_AUDIO_QUERY_FAILED: 502,
  TTS_SYNTHESIS_FAILED: 502,
  TTS_INVALID_AUDIO: 502,
  TTS_INTERNAL_ERROR: 500,
});

export class AivisTtsError extends Error {
  readonly code: AivisErrorCode;
  readonly status: number;
  readonly details?: AivisErrorDetails;

  constructor(
    code: AivisErrorCode,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly details?: AivisErrorDetails;
      readonly status?: number;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AivisTtsError";
    this.code = code;
    this.status = options.status ?? DEFAULT_ERROR_STATUS[code];
    this.details = options.details;
  }
}

export function toPublicAivisVoices(
  speakers: readonly AivisSpeaker[],
): readonly PublicAivisVoice[] {
  return speakers.map((speaker) => ({
    speakerUuid: speaker.speaker_uuid,
    speakerName: speaker.name,
    styles: speaker.styles.map((style) => ({ id: style.id, name: style.name })),
  }));
}
