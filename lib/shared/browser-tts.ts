export const TTS_PLAYBACK_STATES = [
  "idle",
  "buffering",
  "synthesizing",
  "ready",
  "playing",
  "paused",
  "error",
] as const;

export type TtsPlaybackState = (typeof TTS_PLAYBACK_STATES)[number];

export interface TtsPlaybackSnapshot {
  state: TtsPlaybackState;
  queueLength: number;
  currentTextLength: number;
  audioContextState: AudioContextState | "unavailable";
  audioStartedAt: number | null;
  audioEndedAt: number | null;
  currentTime: number;
  duration: number;
  currentRms: number;
  peakRms: number;
  mouthOpen: number;
  peakMouthOpen: number;
  lastError: string | null;
}

export interface TtsRequestOptions {
  voice?: {
    speakerUuid?: string;
    speakerName?: string;
    styleName?: string;
    styleId?: number;
  };
  options?: {
    speedScale?: number;
    intonationScale?: number;
    tempoDynamicsScale?: number;
    volumeScale?: number;
  };
}

export interface TtsPlaybackManagerOptions {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  audioContextFactory?: () => AudioContext;
  requestAnimationFrameImpl?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrameImpl?: (handle: number) => void;
  now?: () => number;
  onSnapshot?: (snapshot: TtsPlaybackSnapshot) => void;
  onMouthOpen?: (value: number) => void;
  onSpeakingChange?: (speaking: boolean) => void;
  requestTimeoutMs?: number;
  noiseGate?: number;
  attack?: number;
  release?: number;
}

interface QueueItem {
  id: number;
  text: string;
  requestOptions: TtsRequestOptions;
  controller: AbortController | null;
  prepared: Promise<AudioBuffer> | null;
}

interface CaptureResult {
  mimeType: string;
  base64: string;
  size: number;
  startedAt: number;
  endedAt: number;
}

const SENTENCE_END = new Set(["。", "！", "？", "!", "?"]);
const CLOSING_QUOTES = new Set(["」", "』", "”", "’", "】", "》", "）", ")", "〕"]);
const SOFT_BREAKS = new Set(["、", "，", ",", " ", "\t"]);
const OPENING_QUOTES = new Map([
  ["「", "」"],
  ["『", "』"],
  ["“", "”"],
  ["‘", "’"],
  ["【", "】"],
  ["《", "》"],
  ["（", "）"],
  ["〔", "〕"],
]);

/**
 * Cleans only the copy sent to speech synthesis. The visible assistant reply is
 * deliberately left untouched by the browser integration.
 */
export function cleanTextForSpeech(value: string): string {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/```[\s\S]*?(?:```|$)/gu, " ")
    .replace(/`[^`\n]*(?:`|(?=\n)|$)/gu, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|www\.)[^)]*\)/giu, "$1")
    .replace(/(?:https?:\/\/|www\.)[^\s<>()「」『』。！？、，,]+/giu, " ")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]\s|\d+[.)]\s)\s*/gmu, "")
    .replace(/(?:\*\*|__|~~|\*|_)(?=\S)|(?<=\S)(?:\*\*|__|~~|\*|_)/gu, "")
    .replace(/\[(?:\d+(?:\s*[-,]\s*\d+)*)\]/gu, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .replace(/[ \t]+/gu, " ")
    .replace(/\s*\n\s*/gu, "\n")
    .trim();
}

/** Returns only a completion suffix that was not already delivered as deltas. */
export function getUnstreamedReplyTail(streamedText: string, finalText: string): string {
  const streamed = String(streamedText ?? "");
  const completed = String(finalText ?? "");
  if (!streamed) return completed;
  return completed.startsWith(streamed) ? completed.slice(streamed.length) : "";
}

function extendPastClosingQuotes(text: string, end: number): number {
  let cursor = end;
  while (cursor < text.length && CLOSING_QUOTES.has(text[cursor])) cursor += 1;
  return cursor;
}

function startsUrlAt(text: string, index: number): boolean {
  const rest = text.slice(index).toLowerCase();
  return rest.startsWith("https://") || rest.startsWith("http://") || rest.startsWith("www.");
}

function skipUrl(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && !/[\s<>()「」『』。！？、，,]/u.test(text[cursor])) cursor += 1;
  return cursor;
}

function punctuationEnd(text: string, index: number): number {
  let cursor = index;
  if (SENTENCE_END.has(text[cursor])) {
    while (cursor < text.length && SENTENCE_END.has(text[cursor])) cursor += 1;
    return cursor;
  }
  if (text[cursor] === "…") {
    while (text[cursor] === "…") cursor += 1;
    return cursor - index >= 2 ? cursor : index;
  }
  if (text.slice(cursor, cursor + 3) === "...") {
    cursor += 3;
    while (text[cursor] === ".") cursor += 1;
    return cursor;
  }
  return index;
}

export interface JapaneseSpeechSegmenterOptions {
  longSegmentLength?: number;
  minimumSegmentLength?: number;
}

export class JapaneseSpeechSegmenter {
  private buffer = "";
  private pendingShort = "";
  private pendingSeparator = "";
  private readonly longSegmentLength: number;
  private readonly minimumSegmentLength: number;

  constructor(options: JapaneseSpeechSegmenterOptions = {}) {
    this.longSegmentLength = Math.max(20, options.longSegmentLength ?? 52);
    this.minimumSegmentLength = Math.max(1, options.minimumSegmentLength ?? 4);
  }

  append(chunk: string): string[] {
    if (typeof chunk !== "string" || !chunk) return [];
    this.buffer += chunk;
    return this.drain(false);
  }

  flush(): string[] {
    const segments = this.drain(true);
    const tail = cleanTextForSpeech(this.pendingShort);
    this.pendingShort = "";
    this.pendingSeparator = "";
    if (tail) segments.push(tail);
    return segments;
  }

  clear(): void {
    this.buffer = "";
    this.pendingShort = "";
    this.pendingSeparator = "";
  }

  getBufferedText(): string {
    return `${this.pendingShort}${this.pendingSeparator}${this.buffer}`;
  }

  private drain(flush: boolean): string[] {
    const result: string[] = [];
    while (this.buffer) {
      const boundary = this.findBoundary(flush);
      if (boundary <= 0) break;
      const raw = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary).replace(/^\s+/u, "");
      this.pushCleanSegment(raw, result, flush && !this.buffer);
    }
    return result;
  }

  private findBoundary(flush: boolean): number {
    const quoteStack: string[] = [];
    let lastSafeBreak = -1;
    const naturalBreakFloor = Math.floor(this.longSegmentLength * 0.55);
    for (let index = 0; index < this.buffer.length; index += 1) {
      const character = this.buffer[index];

      if (this.buffer.startsWith("```", index)) {
        const closing = this.buffer.indexOf("```", index + 3);
        if (closing < 0) {
          if (flush) return this.buffer.length;
          return lastSafeBreak >= Math.floor(this.longSegmentLength * 0.55)
            ? lastSafeBreak
            : -1;
        }
        index = closing + 2;
        if (!quoteStack.length) lastSafeBreak = index + 1;
        if (lastSafeBreak >= this.longSegmentLength) return lastSafeBreak;
        continue;
      }

      if (character === "`") {
        const closing = this.buffer.indexOf("`", index + 1);
        if (closing < 0) {
          const newline = this.buffer.indexOf("\n", index + 1);
          if (newline < 0 && !flush) {
            return lastSafeBreak >= naturalBreakFloor ? lastSafeBreak : -1;
          }
          index = (newline < 0 ? this.buffer.length : newline) - 1;
        } else {
          index = closing;
        }
        if (!quoteStack.length && index + 1 >= this.longSegmentLength) {
          return lastSafeBreak >= naturalBreakFloor ? lastSafeBreak : index + 1;
        }
        continue;
      }

      if (startsUrlAt(this.buffer, index)) {
        const urlEnd = skipUrl(this.buffer, index);
        index = urlEnd - 1;
        if (!quoteStack.length && urlEnd >= this.longSegmentLength) {
          return lastSafeBreak >= naturalBreakFloor ? lastSafeBreak : urlEnd;
        }
        continue;
      }

      const expectedClose = OPENING_QUOTES.get(character);
      if (expectedClose) {
        quoteStack.push(expectedClose);
        continue;
      }
      if (CLOSING_QUOTES.has(character)) {
        if (quoteStack.at(-1) === character) quoteStack.pop();
        if (!quoteStack.length) lastSafeBreak = index + 1;
        if (lastSafeBreak >= this.longSegmentLength) return lastSafeBreak;
        continue;
      }

      const end = punctuationEnd(this.buffer, index);
      if (end > index) {
        if (!quoteStack.length) return extendPastClosingQuotes(this.buffer, end);
        const remainingQuotes = [...quoteStack];
        let cursor = end;
        while (cursor < this.buffer.length && CLOSING_QUOTES.has(this.buffer[cursor])) {
          if (remainingQuotes.at(-1) !== this.buffer[cursor]) break;
          remainingQuotes.pop();
          cursor += 1;
        }
        if (!remainingQuotes.length) return cursor;
        index = end - 1;
        continue;
      }

      if (character === "\n" && !quoteStack.length) return index + 1;
      if (SOFT_BREAKS.has(character) && !quoteStack.length) {
        lastSafeBreak = index + 1;
      }
      if (index + 1 >= this.longSegmentLength && !quoteStack.length) {
        return lastSafeBreak >= naturalBreakFloor
          ? lastSafeBreak
          : this.longSegmentLength;
      }
    }

    if (this.buffer.length >= this.longSegmentLength) {
      if (lastSafeBreak >= naturalBreakFloor) return lastSafeBreak;
      if (!quoteStack.length) return Math.min(this.buffer.length, this.longSegmentLength);
    }
    return flush ? this.buffer.length : -1;
  }

  private pushCleanSegment(raw: string, result: string[], final: boolean): void {
    const cleaned = cleanTextForSpeech(raw);
    if (!cleaned) return;
    const combined = cleanTextForSpeech(
      `${this.pendingShort}${this.pendingSeparator}${cleaned}`,
    );
    if (!final && combined.length < this.minimumSegmentLength) {
      this.pendingShort = combined;
      this.pendingSeparator = /\n\s*$/u.test(raw) ? "\n" : "";
      return;
    }
    this.pendingShort = "";
    this.pendingSeparator = "";
    if (combined) result.push(combined);
  }
}

export function calculateRms(samples: Float32Array): number {
  if (!samples.length) return 0;
  let squared = 0;
  for (let index = 0; index < samples.length; index += 1) {
    squared += samples[index] * samples[index];
  }
  return Math.sqrt(squared / samples.length);
}

export function mapRmsToMouth(rms: number, noiseGate = 0.012): number {
  if (!Number.isFinite(rms) || rms <= noiseGate) return 0;
  return Math.min(1, Math.max(0, (rms - noiseGate) * 7.5));
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "TTS request was cancelled";
  if (error instanceof Error && error.message) return error.message.slice(0, 240);
  return "TTS playback failed";
}

async function responseError(response: Response): Promise<Error> {
  try {
    const payload = await response.json() as { error?: { code?: string; message?: string } };
    const code = typeof payload?.error?.code === "string" ? payload.error.code : `HTTP_${response.status}`;
    const message = typeof payload?.error?.message === "string"
      ? payload.error.message
      : `TTS API returned HTTP ${response.status}`;
    const error = new Error(`${code}: ${message}`);
    error.name = code;
    return error;
  } catch {
    return new Error(`TTS API returned HTTP ${response.status}`);
  }
}

export class TtsPlaybackManager {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly audioContextFactory: () => AudioContext;
  private readonly raf: (callback: FrameRequestCallback) => number;
  private readonly cancelRaf: (handle: number) => void;
  private readonly now: () => number;
  private readonly onSnapshot?: (snapshot: TtsPlaybackSnapshot) => void;
  private readonly onMouthOpen?: (value: number) => void;
  private readonly onSpeakingChange?: (speaking: boolean) => void;
  private readonly requestTimeoutMs: number;
  private readonly noiseGate: number;
  private readonly attack: number;
  private readonly release: number;
  private readonly segmenter = new JapaneseSpeechSegmenter();

  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private outputGain: GainNode | null = null;
  private captureDestination: MediaStreamAudioDestinationNode | null = null;
  private samples: Float32Array<ArrayBuffer> | null = null;
  private source: AudioBufferSourceNode | null = null;
  private queue: QueueItem[] = [];
  private current: QueueItem | null = null;
  private prefetch: QueueItem | null = null;
  private playbackResolve: (() => void) | null = null;
  private animationFrame: number | null = null;
  private generation = 0;
  private nextId = 1;
  private pumping = false;
  private disposed = false;
  private currentStartedAtContextTime = 0;
  private state: TtsPlaybackState = "idle";
  private currentRms = 0;
  private peakRms = 0;
  private mouthOpen = 0;
  private peakMouthOpen = 0;
  private audioStartedAt: number | null = null;
  private audioEndedAt: number | null = null;
  private currentDuration = 0;
  private lastError: string | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private captureChunks: Blob[] = [];
  private captureStartedAt = 0;

  constructor(options: TtsPlaybackManagerOptions = {}) {
    this.endpoint = options.endpoint ?? "/api/tts";
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.audioContextFactory = options.audioContextFactory ?? (() => {
      const Constructor = window.AudioContext || (window as Window & {
        webkitAudioContext?: typeof AudioContext;
      }).webkitAudioContext;
      if (!Constructor) throw new Error("Web Audio API is unavailable");
      return new Constructor();
    });
    this.raf = options.requestAnimationFrameImpl ?? requestAnimationFrame.bind(globalThis);
    this.cancelRaf = options.cancelAnimationFrameImpl ?? cancelAnimationFrame.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.onSnapshot = options.onSnapshot;
    this.onMouthOpen = options.onMouthOpen;
    this.onSpeakingChange = options.onSpeakingChange;
    this.requestTimeoutMs = Math.max(1000, options.requestTimeoutMs ?? 60000);
    this.noiseGate = options.noiseGate ?? 0.012;
    this.attack = Math.min(1, Math.max(0.01, options.attack ?? 0.58));
    this.release = Math.min(1, Math.max(0.01, options.release ?? 0.2));
    this.emitSnapshot();
  }

  enqueue(text: string, requestOptions: TtsRequestOptions = {}): number | null {
    const cleaned = cleanTextForSpeech(text);
    if (!cleaned || this.disposed) return null;
    const item: QueueItem = {
      id: this.nextId++,
      text: cleaned,
      requestOptions,
      controller: null,
      prepared: null,
    };
    this.queue.push(item);
    if (this.current && ["playing", "paused"].includes(this.state) && !this.prefetch) {
      void this.prefetchNext();
    }
    void this.pump();
    this.emitSnapshot();
    return item.id;
  }

  appendStreamingText(chunk: string, requestOptions: TtsRequestOptions = {}): number[] {
    return this.segmenter.append(chunk)
      .map((segment) => this.enqueue(segment, requestOptions))
      .filter((id): id is number => id !== null);
  }

  flushStreamingText(requestOptions: TtsRequestOptions = {}): number[] {
    return this.segmenter.flush()
      .map((segment) => this.enqueue(segment, requestOptions))
      .filter((id): id is number => id !== null);
  }

  clearStreamingText(): void {
    this.segmenter.clear();
  }

  async unlock(): Promise<boolean> {
    if (this.disposed) return false;
    try {
      const context = this.ensureContext();
      if (context.state === "suspended") await context.resume();
      if (String(context.state) !== "running") {
        throw new Error("TTS_AUDIO_CONTEXT_SUSPENDED: click the page and try again");
      }
      this.emitSnapshot();
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  async pause(): Promise<void> {
    if (!this.context || this.state !== "playing") return;
    const context = this.context;
    const generation = this.generation;
    await context.suspend();
    if (
      this.disposed
      || generation !== this.generation
      || context !== this.context
      || !this.current
      || !this.source
      || this.state !== "playing"
    ) return;
    this.setState("paused");
  }

  async resume(): Promise<void> {
    if (!this.context || this.state !== "paused") return;
    const context = this.context;
    const generation = this.generation;
    await context.resume();
    if (
      this.disposed
      || generation !== this.generation
      || context !== this.context
      || !this.current
      || !this.source
      || this.state !== "paused"
    ) return;
    this.setState("playing");
    this.startMetering();
  }

  stop(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.segmenter.clear();
    for (const item of [this.current, this.prefetch, ...this.queue]) item?.controller?.abort();
    this.queue = [];
    this.prefetch = null;
    this.current = null;
    if (this.source) {
      this.source.onended = null;
      try { this.source.stop(); } catch { /* already stopped */ }
      this.source.disconnect();
      this.source = null;
    }
    this.playbackResolve?.();
    this.playbackResolve = null;
    this.audioEndedAt = this.now();
    this.currentDuration = 0;
    this.currentRms = 0;
    this.onSpeakingChange?.(false);
    this.releaseMouth();
    this.setState("idle");
  }

  clear(): void {
    this.stop();
  }

  async destroy(): Promise<void> {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    if (this.animationFrame !== null) this.cancelRaf(this.animationFrame);
    this.animationFrame = null;
    this.currentRms = 0;
    this.currentDuration = 0;
    this.setMouth(0);
    this.emitSnapshot();
    const recorder = this.mediaRecorder;
    if (recorder) {
      recorder.ondataavailable = null;
      if (recorder.state !== "inactive") {
        try { recorder.stop(); } catch { /* recorder already stopped */ }
      }
    }
    this.mediaRecorder = null;
    this.captureChunks = [];
    this.captureDestination?.stream.getTracks?.().forEach((track) => track.stop());
    this.analyser?.disconnect();
    this.outputGain?.disconnect();
    try {
      await this.context?.close();
    } catch {
      // Destruction is best-effort during page teardown. All graph references
      // are still released in finally even if a browser rejects close().
    } finally {
      this.context = null;
      this.analyser = null;
      this.outputGain = null;
      this.captureDestination = null;
      this.samples = null;
      this.emitSnapshot();
    }
  }

  getState(): TtsPlaybackSnapshot {
    const contextTime = this.context?.currentTime ?? 0;
    const playingTime = ["playing", "paused"].includes(this.state)
      ? Math.max(0, Math.min(this.currentDuration, contextTime - this.currentStartedAtContextTime))
      : 0;
    return {
      state: this.state,
      queueLength: this.queue.length + (this.current ? 1 : 0),
      currentTextLength: this.current?.text.length ?? 0,
      audioContextState: this.context?.state ?? "unavailable",
      audioStartedAt: this.audioStartedAt,
      audioEndedAt: this.audioEndedAt,
      currentTime: playingTime,
      duration: this.currentDuration,
      currentRms: this.currentRms,
      peakRms: this.peakRms,
      mouthOpen: this.mouthOpen,
      peakMouthOpen: this.peakMouthOpen,
      lastError: this.lastError,
    };
  }

  async startAudioCapture(): Promise<{ mimeType: string; startedAt: number }> {
    if (this.mediaRecorder?.state === "recording") {
      return { mimeType: this.mediaRecorder.mimeType, startedAt: this.captureStartedAt };
    }
    if (!await this.unlock()) {
      throw new Error("TTS_AUDIO_CONTEXT_SUSPENDED: audio capture could not be unlocked");
    }
    this.ensureAudioGraph();
    if (!this.captureDestination || typeof MediaRecorder === "undefined") {
      throw new Error("MediaRecorder audio capture is unavailable");
    }
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]
      .find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
    this.captureChunks = [];
    this.mediaRecorder = mimeType
      ? new MediaRecorder(this.captureDestination.stream, { mimeType })
      : new MediaRecorder(this.captureDestination.stream);
    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.captureChunks.push(event.data);
    };
    this.captureStartedAt = this.now();
    this.mediaRecorder.start(250);
    return { mimeType: this.mediaRecorder.mimeType, startedAt: this.captureStartedAt };
  }

  async stopAudioCapture(): Promise<CaptureResult | null> {
    const recorder = this.mediaRecorder;
    if (!recorder || recorder.state === "inactive") return null;
    const endedAt = this.now();
    await new Promise<void>((resolve) => {
      recorder.addEventListener("stop", () => resolve(), { once: true });
      recorder.stop();
    });
    const blob = new Blob(this.captureChunks, { type: recorder.mimeType || "audio/webm" });
    const base64 = await this.blobToBase64(blob);
    const result = {
      mimeType: blob.type,
      base64,
      size: blob.size,
      startedAt: this.captureStartedAt,
      endedAt,
    };
    this.mediaRecorder = null;
    this.captureChunks = [];
    return result;
  }

  private ensureContext(): AudioContext {
    if (this.disposed) throw new Error("TTS playback manager has been destroyed");
    if (!this.context || this.context.state === "closed") {
      this.context = this.audioContextFactory();
    }
    this.ensureAudioGraph();
    return this.context;
  }

  private ensureAudioGraph(): void {
    if (!this.context || this.analyser) return;
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0;
    this.outputGain = this.context.createGain();
    this.captureDestination = this.context.createMediaStreamDestination?.() ?? null;
    this.analyser.connect(this.outputGain);
    this.outputGain.connect(this.context.destination);
    if (this.captureDestination) this.outputGain.connect(this.captureDestination);
    this.samples = new Float32Array(this.analyser.fftSize);
  }

  private async prepare(item: QueueItem): Promise<AudioBuffer> {
    if (item.prepared) return item.prepared;
    const controller = new AbortController();
    item.controller = controller;
    item.prepared = (async () => {
      const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        const response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: { Accept: "audio/wav", "Content-Type": "application/json" },
          body: JSON.stringify({ text: item.text, ...item.requestOptions }),
          signal: controller.signal,
        });
        if (!response.ok) throw await responseError(response);
        const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
        if (!contentType.includes("audio/wav") && !contentType.includes("audio/x-wav")) {
          throw new Error("TTS_INVALID_AUDIO: response is not WAV audio");
        }
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength < 12) throw new Error("TTS_INVALID_AUDIO: response is empty");
        const header = new Uint8Array(bytes, 0, 12);
        const ascii = String.fromCharCode(...header);
        if (!ascii.startsWith("RIFF") || ascii.slice(8, 12) !== "WAVE") {
          throw new Error("TTS_INVALID_AUDIO: response has no RIFF/WAVE header");
        }
        const context = this.ensureContext();
        return await context.decodeAudioData(bytes.slice(0));
      } finally {
        clearTimeout(timer);
        item.controller = null;
      }
    })();
    return item.prepared;
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.disposed || this.current) return;
    this.pumping = true;
    const runGeneration = this.generation;
    try {
      while (!this.disposed && runGeneration === this.generation && !this.current && this.queue.length) {
        const item = this.queue.shift();
        if (!item) break;
        this.current = item;
        if (this.prefetch === item) this.prefetch = null;
        // A previous sentence may have failed while a later one remains
        // playable. Clear stale diagnostics when a new attempt begins so a
        // recovered queue and unattended verifier do not report an old error.
        this.lastError = null;
        this.setState(item.prepared ? "buffering" : "synthesizing");
        try {
          const buffer = await this.prepare(item);
          if (runGeneration !== this.generation || this.current !== item) break;
          this.setState("ready");
          await this.play(item, buffer, runGeneration);
        } catch (error) {
          if (runGeneration !== this.generation || (error instanceof DOMException && error.name === "AbortError")) {
            break;
          }
          this.setError(error);
        } finally {
          if (this.current === item) this.current = null;
        }
      }
    } finally {
      this.pumping = false;
      if (!this.current && !this.queue.length && runGeneration === this.generation) this.setState("idle");
      // stop() deliberately advances generation while the old pump may still
      // be unwinding. A replacement sentence queued in the same task must be
      // picked up by a fresh generation rather than left idle forever.
      if (!this.current && this.queue.length && !this.disposed) void this.pump();
    }
  }

  private async play(item: QueueItem, buffer: AudioBuffer, runGeneration: number): Promise<void> {
    const context = this.ensureContext();
    if (context.state === "suspended") await context.resume();
    if (runGeneration !== this.generation || this.current !== item) return;
    if (String(context.state) !== "running") {
      throw new Error("TTS_AUDIO_CONTEXT_SUSPENDED: click the page and try again");
    }
    if (!this.analyser) throw new Error("Web Audio analyser is unavailable");
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser);
    this.source = source;
    this.currentDuration = Number.isFinite(buffer.duration) ? buffer.duration : 0;
    this.currentStartedAtContextTime = context.currentTime;
    this.audioStartedAt = this.now();
    this.audioEndedAt = null;
    this.currentRms = 0;
    this.peakRms = 0;
    this.peakMouthOpen = 0;
    this.setState("playing");
    this.onSpeakingChange?.(true);
    try {
      await new Promise<void>((resolve, reject) => {
        this.playbackResolve = resolve;
        source.onended = () => resolve();
        try {
          source.start(0);
          this.startMetering();
          void this.prefetchNext();
        } catch (error) {
          reject(error);
        }
      });
    } finally {
      if (this.source === source) {
        source.onended = null;
        source.disconnect();
        this.source = null;
      }
      this.playbackResolve = null;
    }
    if (runGeneration !== this.generation) return;
    this.audioEndedAt = this.now();
    this.currentRms = 0;
    this.onSpeakingChange?.(false);
    this.releaseMouth();
    this.emitSnapshot();
  }

  private async prefetchNext(): Promise<void> {
    if (!this.current || this.prefetch || !this.queue.length) return;
    const item = this.queue[0];
    this.prefetch = item;
    try {
      await this.prepare(item);
    } catch {
      // pump() owns error reporting and recovery in queue order.
    }
  }

  private startMetering(): void {
    if (this.animationFrame !== null) return;
    const update = () => {
      this.animationFrame = null;
      if (this.state === "playing" && this.analyser && this.samples) {
        this.analyser.getFloatTimeDomainData(this.samples);
        this.currentRms = calculateRms(this.samples);
        this.peakRms = Math.max(this.peakRms, this.currentRms);
        const target = mapRmsToMouth(this.currentRms, this.noiseGate);
        const smoothing = target > this.mouthOpen ? this.attack : this.release;
        this.setMouth(this.mouthOpen + ((target - this.mouthOpen) * smoothing));
        this.emitSnapshot();
        this.animationFrame = this.raf(update);
      } else if (this.mouthOpen > 0.001) {
        this.setMouth(this.mouthOpen * (1 - this.release));
        this.emitSnapshot();
        this.animationFrame = this.raf(update);
      } else {
        this.setMouth(0);
        this.emitSnapshot();
      }
    };
    this.animationFrame = this.raf(update);
  }

  private releaseMouth(): void {
    this.startMetering();
  }

  private setMouth(value: number): void {
    this.mouthOpen = Math.min(1, Math.max(0, Number(value) || 0));
    if (this.mouthOpen < 0.001) this.mouthOpen = 0;
    this.peakMouthOpen = Math.max(this.peakMouthOpen, this.mouthOpen);
    this.onMouthOpen?.(this.mouthOpen);
  }

  private setState(state: TtsPlaybackState): void {
    this.state = state;
    this.emitSnapshot();
  }

  private setError(error: unknown): void {
    this.lastError = safeErrorMessage(error);
    this.currentRms = 0;
    this.onSpeakingChange?.(false);
    this.releaseMouth();
    this.setState("error");
  }

  private emitSnapshot(): void {
    this.onSnapshot?.(this.getState());
  }

  private async blobToBase64(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }
}
