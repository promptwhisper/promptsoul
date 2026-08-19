import type {
  TtsPlaybackSnapshot,
  TtsRequestOptions,
} from "@/lib/shared/browser-tts";

import "./app.js";

export interface PromptSoulTtsApi {
  enqueue(text: string, options?: TtsRequestOptions, tag?: unknown): number | null;
  appendStreamingText(chunk: string, options?: TtsRequestOptions): number[];
  flushStreamingText(options?: TtsRequestOptions): number[];
  clearStreamingText(): void;
  play(text: string, options?: TtsRequestOptions): number[];
  stop(): void;
  clear(): void;
  cancelPending(): void;
  pause(): Promise<void>;
  resume(): Promise<void>;
  unlock(): Promise<boolean>;
  getState(): TtsPlaybackSnapshot;
  getAudioContextTime(): number | null;
  refreshStatus(): Promise<unknown>;
  startAudioCapture(): Promise<{ mimeType: string; startedAt: number }>;
  stopAudioCapture(): Promise<{
    mimeType: string;
    base64: string;
    size: number;
    startedAt: number;
    endedAt: number;
  } | null>;
}

export interface PromptSoulTtsDiagnostics extends TtsPlaybackSnapshot {
  engineReady: boolean;
  voiceResolved: boolean;
  lipSyncAvailable: boolean;
  speakerName: string | null;
  styleName: string | null;
  styleId: number | null;
  lipSyncParameterIds: string[];
  mouthEvidence: "parameter_readback" | "none";
  artMeshDeformationVerified: false;
}

export interface PromptSoulRealtimeDiagnostics {
  ttfcMs: number | null;
  invalidCues: number;
  noopSegments: number;
  bufferUnderruns: number;
  syncDriftMs: number | null;
  syncDriftP95Ms: number | null;
  segmentsReceived: number;
  cueSegmentsAccepted: number;
  cueSegmentsBound: number;
  cueSegmentsFallback: number;
  bindFailures: number;
  cueApplications: number;
  frameWrites: number;
  parameterWrites: number;
  partOpacityWrites: number;
  partOpacityIds: string[];
  clockMode: "audio" | "performance" | null;
  lastCueClockMode: string | null;
  lastCueParameterIds: string[];
}

declare global {
  interface Window {
    PromptSoulTTS?: PromptSoulTtsApi;
    __AITUBER_DIAGNOSTICS__?: {
      tts?: PromptSoulTtsDiagnostics;
      realtime?: PromptSoulRealtimeDiagnostics;
      [key: string]: unknown;
    };
  }
}

export {};
