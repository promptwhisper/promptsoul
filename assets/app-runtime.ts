import type {
  TtsPlaybackSnapshot,
  TtsRequestOptions,
} from "@/lib/shared/browser-tts";

import "./app.js";

export interface PromptSoulTtsApi {
  enqueue(text: string, options?: TtsRequestOptions): number | null;
  appendStreamingText(chunk: string, options?: TtsRequestOptions): number[];
  flushStreamingText(options?: TtsRequestOptions): number[];
  clearStreamingText(): void;
  play(text: string, options?: TtsRequestOptions): number[];
  stop(): void;
  clear(): void;
  pause(): Promise<void>;
  resume(): Promise<void>;
  unlock(): Promise<boolean>;
  getState(): TtsPlaybackSnapshot;
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
  speakerName: string | null;
  styleName: string | null;
  styleId: number | null;
  lipSyncParameterIds: string[];
  mouthEvidence: "parameter_readback" | "none";
  artMeshDeformationVerified: false;
}

declare global {
  interface Window {
    PromptSoulTTS?: PromptSoulTtsApi;
    __AITUBER_DIAGNOSTICS__?: {
      tts?: PromptSoulTtsDiagnostics;
      [key: string]: unknown;
    };
  }
}

export {};
