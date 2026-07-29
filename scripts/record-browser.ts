#!/usr/bin/env node

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

type JsonObject = Record<string, unknown>;

export interface RecordingOptions {
  chrome: string;
  ffmpeg: string;
  ffprobe: string;
  port: number;
  output: string;
  text: string;
  width: number;
  height: number;
  timeoutMs: number;
}

export interface TtsDiagnostics {
  engineReady?: unknown;
  voiceResolved?: unknown;
  state?: unknown;
  queueLength?: unknown;
  currentTextLength?: unknown;
  audioContextState?: unknown;
  audioStartedAt?: unknown;
  audioEndedAt?: unknown;
  currentTime?: unknown;
  duration?: unknown;
  currentRms?: unknown;
  peakRms?: unknown;
  mouthOpen?: unknown;
  peakMouthOpen?: unknown;
  lipSyncParameterIds?: unknown;
  mouthEvidence?: unknown;
  artMeshDeformationVerified?: unknown;
  lastError?: unknown;
}

interface TtsStatus {
  ready?: unknown;
  engineReachable?: unknown;
  voiceResolved?: unknown;
  speakerName?: unknown;
  styleName?: unknown;
  styleId?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
}

interface Frame {
  path: string;
  /** Raw CDP ScreencastFrameMetadata.timestamp in seconds. */
  timestamp: number;
  /** The frame timestamp converted to the browser Date.now() epoch. */
  wallTimeMs: number;
}

export interface FrameClockCalibration {
  browserWallTimeMs: number;
  cdpMonotonicSeconds: number;
}

export type FrameTimestampMode = "epoch" | "cdp-monotonic";

interface AudioCapture {
  mimeType: string;
  base64: string;
  size: number;
  startedAt: number;
  endedAt: number;
}

interface PlaybackEvidence {
  observedAt: number;
  audioStartedAt: number;
  currentTime: number;
  duration: number;
  currentRms: number;
  peakRms: number;
  mouthOpen: number;
  peakMouthOpen: number;
  lipSyncParameterIds: string[];
  mouthEvidence: "parameter_readback";
  artMeshDeformationVerified: boolean;
}

interface CdpResponse {
  id?: number;
  method?: string;
  params?: JsonObject;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ProbeResult {
  format?: { duration?: string };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    duration?: string;
  }>;
}

const DEFAULT_TEXT = "おかえりなさい。今日も会えて、すごくうれしいです。";
const DEFAULT_OUTPUT = "artifacts/promptsoul-unattended.mp4";
const COMMAND_TIMEOUT_MS = 90_000;
const RMS_THRESHOLD = 0.003;
const MOUTH_THRESHOLD = 0.015;
const MOUTH_ZERO_THRESHOLD = 0.01;
const MAX_FRAME_DELIVERY_DELAY_MS = 5_000;
const MAX_FRAME_START_ERROR_MS = 100;
const MAX_FRAME_GAP_SECONDS = 0.25;
const MAX_AV_DURATION_DELTA_SECONDS = 0.5;
const MIN_FINAL_MAX_VOLUME_DB = -55;
const MIN_FINAL_MEAN_VOLUME_DB = -65;

export const REQUIRED_CHROME_FLAGS = Object.freeze([
  "--headless=new",
  "--use-angle=swiftshader-webgl",
  "--enable-unsafe-swiftshader",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--autoplay-policy=no-user-gesture-required",
]);

function usage(): string {
  return [
    "Usage: tsx scripts/record-browser.ts [options]",
    "",
    "The Next.js server must already be listening on 127.0.0.1.",
    "",
    "Options (equivalent environment variables in parentheses):",
    "  --chrome <path>       Chrome/Chromium executable (CHROME)",
    "  --ffmpeg <path>       ffmpeg executable (FFMPEG)",
    "  --ffprobe <path>      ffprobe executable (FFPROBE)",
    "  --port <number>       Next.js port (PORT, default 8765)",
    "  --out <mp4-or-dir>    Output file or directory (OUT)",
    "  --text <japanese>     Existing TTS debug-panel text (TTS_TEXT)",
    "  --width <pixels>      Viewport width (WIDTH, default 720)",
    "  --height <pixels>     Viewport height (HEIGHT, default 1280)",
    "  --timeout <ms>        Playback/end timeout (RECORD_TIMEOUT_MS, default 120000)",
  ].join("\n");
}

function readInteger(value: string | undefined, fallback: number, label: string, min: number, max: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function executableWorks(candidate: string, versionFlag = "-version"): boolean {
  if (!candidate) return false;
  const result = spawnSync(candidate, [versionFlag], { stdio: "ignore", timeout: 10_000 });
  return result.status === 0;
}

function resolveChrome(explicit: string | undefined): string {
  const candidates = [
    explicit,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (executableWorks(candidate, "--version")) return candidate;
  }
  throw new Error("Chrome/Chromium was not found. Set CHROME or pass --chrome.");
}

function resolveMediaTool(explicit: string | undefined, fallback: string, label: string): string {
  const candidate = explicit || fallback;
  if (!executableWorks(candidate)) {
    throw new Error(`${label} was not found or could not run: ${candidate}`);
  }
  return candidate;
}

function outputPath(value: string): string {
  const absolute = resolve(value);
  return extname(absolute).toLowerCase() === ".mp4"
    ? absolute
    : join(absolute, "promptsoul-unattended.mp4");
}

export function parseRecordingOptions(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
): RecordingOptions {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--chrome", "--ffmpeg", "--ffprobe", "--port", "--out", "--text", "--width", "--height", "--timeout",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (!allowed.has(argument)) throw new Error(`Unknown argument: ${argument}\n${usage()}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}\n${usage()}`);
    values.set(argument, value);
    index += 1;
  }

  const text = (values.get("--text") ?? environment.TTS_TEXT ?? DEFAULT_TEXT).trim();
  if (!text) throw new Error("The recording TTS text must not be empty");
  if (text.length > 500) throw new Error("The recording TTS text must not exceed 500 characters");
  const port = readInteger(values.get("--port") ?? environment.PORT, 8765, "PORT", 1, 65_535);
  const width = readInteger(values.get("--width") ?? environment.WIDTH, 720, "WIDTH", 320, 7680);
  const height = readInteger(values.get("--height") ?? environment.HEIGHT, 1280, "HEIGHT", 320, 7680);
  const timeoutMs = readInteger(
    values.get("--timeout") ?? environment.RECORD_TIMEOUT_MS,
    120_000,
    "RECORD_TIMEOUT_MS",
    5_000,
    600_000,
  );
  const chrome = resolveChrome(values.get("--chrome") ?? environment.CHROME);
  const ffmpeg = resolveMediaTool(values.get("--ffmpeg") ?? environment.FFMPEG, "ffmpeg", "ffmpeg");
  let ffprobeCandidate = values.get("--ffprobe") ?? environment.FFPROBE;
  if (!ffprobeCandidate && ffmpeg.includes("/")) {
    const sibling = join(dirname(ffmpeg), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
    if (executableWorks(sibling)) ffprobeCandidate = sibling;
  }
  const ffprobe = resolveMediaTool(ffprobeCandidate, "ffprobe", "ffprobe");

  return {
    chrome,
    ffmpeg,
    ffprobe,
    port,
    output: outputPath(values.get("--out") ?? environment.OUT ?? DEFAULT_OUTPUT),
    text,
    width,
    height,
    timeoutMs,
  };
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly listeners = new Map<string, Set<(params: JsonObject) => void>>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data) as CdpResponse;
      if (message.id !== undefined) {
        const command = this.pending.get(message.id);
        if (!command) return;
        this.pending.delete(message.id);
        clearTimeout(command.timer);
        if (message.error) {
          command.reject(new Error(`CDP error ${message.error.code ?? ""}: ${message.error.message ?? "unknown error"}`));
        } else {
          command.resolve(message.result);
        }
        return;
      }
      if (!message.method) return;
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
    });
    socket.addEventListener("close", () => {
      for (const command of this.pending.values()) {
        clearTimeout(command.timer);
        command.reject(new Error("Chrome DevTools connection closed"));
      }
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error("Timed out connecting to Chrome DevTools")), 15_000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolvePromise();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        rejectPromise(new Error("Could not connect to Chrome DevTools"));
      }, { once: true });
    });
    return new CdpClient(socket);
  }

  on(method: string, listener: (params: JsonObject) => void): void {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
  }

  send<T extends JsonObject>(method: string, params: JsonObject = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`Timed out waiting for CDP command: ${method}`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => resolvePromise((value ?? {}) as T),
        reject: rejectPromise,
        timer,
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.socket.close();
  }
}

async function startChrome(
  options: RecordingOptions,
  profile: string,
): Promise<{ child: ChildProcess; debuggerUrl: string }> {
  const child = spawn(options.chrome, [
    ...REQUIRED_CHROME_FLAGS,
    "--force-device-scale-factor=1",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--window-size=${options.width},${options.height}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  try {
    const debuggerUrl = await new Promise<string>((resolvePromise, rejectPromise) => {
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        rejectPromise(new Error(`Timed out starting headless Chrome${stderr ? `: ${stderr.slice(-500)}` : ""}`));
      }, 20_000);
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        if (settled) return;
        stderr = `${stderr}${chunk}`.slice(-4_000);
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/u);
        if (!match) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(match[1]);
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectPromise(new Error(`Could not start headless Chrome: ${error.message}`));
      });
      child.once("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectPromise(new Error(`Headless Chrome exited before DevTools was ready (${code ?? signal ?? "unknown"})`));
      });
    });
    return { child, debuggerUrl };
  } catch (error) {
    await stopChrome(child);
    throw error;
  }
}

async function pageDebuggerUrl(browserDebuggerUrl: string): Promise<string> {
  const parsed = new URL(browserDebuggerUrl);
  const response = await fetch(`http://${parsed.hostname}:${parsed.port}/json/list`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Could not list Chrome targets: HTTP ${response.status}`);
  const targets = await response.json() as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
  const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (!page?.webSocketDebuggerUrl) throw new Error("Headless Chrome did not expose a page target");
  return page.webSocketDebuggerUrl;
}

async function evaluate<T>(client: CdpClient, expression: string): Promise<T> {
  const response = await client.send<{
    result?: { value?: T; description?: string };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  }>("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ||
      response.exceptionDetails.text ||
      "Page evaluation failed",
    );
  }
  return response.result?.value as T;
}

async function clickElement(client: CdpClient, selector: string, label: string): Promise<void> {
  const point = await evaluate<{ x: number; y: number } | null>(client, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement) || element.hidden || element.matches(":disabled")) return null;
    element.scrollIntoView({ block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!point) throw new Error(`Could not find a clickable ${label}: ${selector}`);
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1,
  });
}

async function setDebugText(client: CdpClient, text: string): Promise<void> {
  const changed = await evaluate<boolean>(client, `(() => {
    const element = document.querySelector(".tts-debug-panel textarea");
    if (!(element instanceof HTMLTextAreaElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(element, ${JSON.stringify(text)});
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return element.value === ${JSON.stringify(text)};
  })()`);
  if (!changed) throw new Error("Could not populate the existing TTS debug input");
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

export function frameTimestampToWallTime(
  timestampSeconds: number,
  calibration: FrameClockCalibration,
  mode: FrameTimestampMode,
): number {
  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) {
    throw new Error("Chrome returned an invalid screencast timestamp");
  }
  if (mode === "epoch") return timestampSeconds * 1_000;
  return calibration.browserWallTimeMs +
    ((timestampSeconds - calibration.cdpMonotonicSeconds) * 1_000);
}

export function resolveFrameTimestampMode(
  timestampSeconds: number,
  receivedAtMs: number,
  calibration: FrameClockCalibration,
): FrameTimestampMode {
  const candidates: Array<{ mode: FrameTimestampMode; distance: number }> = [
    {
      mode: "epoch",
      distance: Math.abs(frameTimestampToWallTime(timestampSeconds, calibration, "epoch") - receivedAtMs),
    },
    {
      mode: "cdp-monotonic",
      distance: Math.abs(frameTimestampToWallTime(timestampSeconds, calibration, "cdp-monotonic") - receivedAtMs),
    },
  ];
  candidates.sort((left, right) => left.distance - right.distance);
  const best = candidates[0];
  if (!best || best.distance > MAX_FRAME_DELIVERY_DELAY_MS) {
    throw new Error(
      `Could not map Chrome's screencast clock to the browser clock (closest offset ${Math.round(best?.distance ?? Infinity)}ms)`,
    );
  }
  return best.mode;
}

async function calibrateFrameClock(client: CdpClient): Promise<FrameClockCalibration> {
  const readTimestamp = async (): Promise<number> => {
    const metrics = await client.send<{
      metrics?: Array<{ name?: string; value?: number }>;
    }>("Performance.getMetrics");
    const timestamp = metrics.metrics?.find((metric) => metric.name === "Timestamp")?.value;
    if (!Number.isFinite(timestamp)) throw new Error("Chrome did not expose its monotonic performance clock");
    return Number(timestamp);
  };

  await client.send("Performance.enable");
  const before = await readTimestamp();
  const browserWallTimeMs = await evaluate<number>(client, "Date.now()");
  const after = await readTimestamp();
  if (!Number.isFinite(browserWallTimeMs) || browserWallTimeMs <= 0 || after < before) {
    throw new Error("Could not calibrate Chrome's frame and browser clocks");
  }
  return {
    browserWallTimeMs,
    cdpMonotonicSeconds: (before + after) / 2,
  };
}

export function isRealPlayback(diagnostics: TtsDiagnostics | null | undefined): boolean {
  if (!diagnostics) return false;
  return diagnostics.state === "playing" &&
    diagnostics.audioContextState === "running" &&
    numberValue(diagnostics.currentTime) > 0 &&
    numberValue(diagnostics.duration) > 0 &&
    numberValue(diagnostics.currentRms) > RMS_THRESHOLD &&
    numberValue(diagnostics.peakRms) > RMS_THRESHOLD &&
    numberValue(diagnostics.mouthOpen) > MOUTH_THRESHOLD &&
    numberValue(diagnostics.peakMouthOpen) > MOUTH_THRESHOLD &&
    stringArray(diagnostics.lipSyncParameterIds).length > 0 &&
    diagnostics.mouthEvidence === "parameter_readback" &&
    numberValue(diagnostics.audioStartedAt) > 0;
}

export function isPlaybackSettled(
  diagnostics: TtsDiagnostics | null | undefined,
  expectedStart: number,
  chatBusy: boolean,
): boolean {
  if (!diagnostics) return false;
  return !chatBusy &&
    diagnostics.state === "idle" &&
    numberValue(diagnostics.queueLength) === 0 &&
    numberValue(diagnostics.audioEndedAt) >= expectedStart &&
    numberValue(diagnostics.currentRms) <= RMS_THRESHOLD &&
    numberValue(diagnostics.mouthOpen) <= MOUTH_ZERO_THRESHOLD;
}

async function readTtsDiagnostics(client: CdpClient): Promise<TtsDiagnostics | null> {
  return await evaluate<TtsDiagnostics | null>(
    client,
    "window.__AITUBER_DIAGNOSTICS__?.tts ? { ...window.__AITUBER_DIAGNOSTICS__.tts } : null",
  );
}

async function waitForPageReady(client: CdpClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let latest = "page not loaded";
  while (Date.now() < deadline) {
    const state = await evaluate<{
      documentReady: string;
      modelState: string;
      modelCopy: string;
      engineReady: boolean;
      voiceResolved: boolean;
      runtimeReady: boolean;
      lastError: string | null;
    }>(client, `(() => {
      const diagnostics = window.__AITUBER_DIAGNOSTICS__?.tts;
      const model = document.querySelector("#modelState");
      return {
        documentReady: document.readyState,
        modelState: model?.getAttribute("data-state") || "",
        modelCopy: model?.textContent?.trim() || "",
        engineReady: diagnostics?.engineReady === true,
        voiceResolved: diagnostics?.voiceResolved === true,
        runtimeReady: Boolean(window.PromptSoulTTS &&
          typeof window.PromptSoulTTS.startAudioCapture === "function" &&
          typeof window.PromptSoulTTS.stopAudioCapture === "function"),
        lastError: typeof diagnostics?.lastError === "string" ? diagnostics.lastError : null,
      };
    })()`);
    latest = JSON.stringify(state);
    if (state.modelState === "error") {
      throw new Error(`Live2D failed before recording: ${state.modelCopy || "unknown model error"}`);
    }
    if (
      state.documentReady === "complete" &&
      state.modelState === "ready" &&
      state.engineReady &&
      state.voiceResolved &&
      state.runtimeReady
    ) return;
    await delay(200);
  }
  throw new Error(`Timed out waiting for page, Live2D and TTS readiness: ${latest}`);
}

async function waitForRealPlayback(client: CdpClient, timeoutMs: number): Promise<PlaybackEvidence> {
  const deadline = Date.now() + timeoutMs;
  let latest: TtsDiagnostics | null = null;
  while (Date.now() < deadline) {
    latest = await readTtsDiagnostics(client);
    if (typeof latest?.lastError === "string" && latest.lastError) {
      throw new Error(`TTS playback failed before real audio was observed: ${latest.lastError}`);
    }
    if (isRealPlayback(latest)) {
      const proven = latest as TtsDiagnostics;
      return {
        observedAt: Date.now(),
        audioStartedAt: numberValue(proven.audioStartedAt),
        currentTime: numberValue(proven.currentTime),
        duration: numberValue(proven.duration),
        currentRms: numberValue(proven.currentRms),
        peakRms: numberValue(proven.peakRms),
        mouthOpen: numberValue(proven.mouthOpen),
        peakMouthOpen: numberValue(proven.peakMouthOpen),
        lipSyncParameterIds: stringArray(proven.lipSyncParameterIds),
        mouthEvidence: "parameter_readback",
        artMeshDeformationVerified: proven.artMeshDeformationVerified === true,
      };
    }
    if (latest?.state === "idle" && numberValue(latest.audioEndedAt) > 0) {
      throw new Error(
        "TTS audio ended without proving simultaneous playback, non-silent RMS and Live2D mouth movement",
      );
    }
    await delay(33);
  }
  throw new Error(`Timed out waiting for real TTS playback evidence: ${JSON.stringify(latest)}`);
}

async function waitForPlaybackEnd(
  client: CdpClient,
  expectedStart: number,
  timeoutMs: number,
): Promise<{
  endedAt: number;
  peakRms: number;
  peakMouthOpen: number;
  finalRms: number;
  finalMouthOpen: number;
  finalState: string;
  finalQueueLength: number;
}> {
  const deadline = Date.now() + timeoutMs;
  let latest: TtsDiagnostics | null = null;
  let peakRms = 0;
  let peakMouthOpen = 0;
  while (Date.now() < deadline) {
    latest = await readTtsDiagnostics(client);
    peakRms = Math.max(peakRms, numberValue(latest?.currentRms), numberValue(latest?.peakRms));
    peakMouthOpen = Math.max(peakMouthOpen, numberValue(latest?.mouthOpen), numberValue(latest?.peakMouthOpen));
    if (typeof latest?.lastError === "string" && latest.lastError) {
      throw new Error(`TTS playback failed while recording: ${latest.lastError}`);
    }
    const chatBusy = await evaluate<boolean>(
      client,
      "document.querySelector('#chatForm')?.getAttribute('aria-busy') === 'true'",
    );
    if (isPlaybackSettled(latest, expectedStart, chatBusy)) {
      return {
        endedAt: numberValue(latest?.audioEndedAt),
        peakRms,
        peakMouthOpen,
        finalRms: numberValue(latest?.currentRms),
        finalMouthOpen: numberValue(latest?.mouthOpen),
        finalState: typeof latest?.state === "string" ? latest.state : "unknown",
        finalQueueLength: numberValue(latest?.queueLength),
      };
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for the LLM/TTS queue and mouth to settle: ${JSON.stringify(latest)}`);
}

async function preflightStatus(baseUrl: string): Promise<TtsStatus> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/status`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(
      `PromptSoul is not reachable at ${baseUrl}; start Next.js before recording (${error instanceof Error ? error.message : "request failed"})`,
    );
  }
  if (!response.ok) throw new Error(`/api/status returned HTTP ${response.status}`);
  const payload = await response.json() as { tts?: TtsStatus };
  const tts = payload.tts;
  if (!tts || tts.ready !== true) {
    const code = typeof tts?.error?.code === "string" ? tts.error.code : "TTS_NOT_READY";
    const message = typeof tts?.error?.message === "string"
      ? tts.error.message
      : "AivisSpeech or the configured voice is not ready";
    throw new Error(`${code}: ${message.replace(/[.!?。！？]+$/u, "")}. Recording was not started; no silent video was produced.`);
  }
  if (tts.engineReachable !== true || tts.voiceResolved !== true) {
    throw new Error("/api/status reported ready=true without a reachable engine and resolved voice");
  }
  return tts;
}

function writeAudioCapture(workDirectory: string, capture: AudioCapture): string {
  if (!capture || typeof capture.base64 !== "string" || typeof capture.mimeType !== "string") {
    throw new Error("The browser returned an invalid AudioContext capture object");
  }
  if (!capture.mimeType.startsWith("audio/")) {
    throw new Error(`The browser capture has an invalid MIME type: ${capture.mimeType || "empty"}`);
  }
  const bytes = Buffer.from(capture.base64, "base64");
  if (bytes.length < 256 || capture.size < 256 || Math.abs(bytes.length - capture.size) > 4) {
    throw new Error(`The browser captured no usable audio (${bytes.length} bytes)`);
  }
  if (!(capture.endedAt > capture.startedAt)) {
    throw new Error("The browser audio capture has invalid timestamps");
  }
  const extension = capture.mimeType.includes("ogg") ? "ogg" : "webm";
  const path = join(workDirectory, `browser-audio.${extension}`);
  writeFileSync(path, bytes);
  return path;
}

function selectAlignedFrames(
  frames: Frame[],
  captureStartedAt: number,
  audioStartedAt: number,
): { frames: Frame[]; commonStartWallTimeMs: number } {
  if (!frames.length) throw new Error("Chrome produced no timestamped screencast frames");
  let startIndex = -1;
  for (let index = 0; index < frames.length; index += 1) {
    const wallTime = frames[index].wallTimeMs;
    if (wallTime >= captureStartedAt && wallTime <= audioStartedAt) startIndex = index;
    if (wallTime > audioStartedAt) break;
  }
  if (startIndex < 0) {
    startIndex = frames.findIndex((frame) => frame.wallTimeMs >= audioStartedAt);
  }
  if (startIndex < 0) throw new Error("No screencast frame overlaps the beginning of real audio playback");
  const commonStartWallTimeMs = frames[startIndex].wallTimeMs;
  const startError = Math.abs(commonStartWallTimeMs - audioStartedAt);
  if (startError > MAX_FRAME_START_ERROR_MS) {
    throw new Error(`The closest video frame is ${Math.round(startError)}ms from the real audio start`);
  }
  return { frames: frames.slice(startIndex), commonStartWallTimeMs };
}

export function validateFrameIntervals(timestamps: number[]): number {
  if (timestamps.length < 15) throw new Error(`Only ${timestamps.length} post-playback frames were captured`);
  let duration = 1 / 30;
  for (let index = 0; index < timestamps.length - 1; index += 1) {
    const gap = timestamps[index + 1] - timestamps[index];
    if (!Number.isFinite(gap) || gap <= 0) {
      throw new Error(`Screencast timestamps are not strictly increasing at frame ${index + 1}`);
    }
    if (gap > MAX_FRAME_GAP_SECONDS) {
      throw new Error(
        `Headless Chrome stopped producing continuous frames for ${gap.toFixed(3)}s at frame ${index + 1}`,
      );
    }
    duration += gap;
  }
  return duration;
}

function writeFrameManifest(workDirectory: string, frames: Frame[]): { path: string; duration: number } {
  const duration = validateFrameIntervals(frames.map((frame) => frame.timestamp));
  if (frames.length < 15) throw new Error(`Only ${frames.length} post-playback frames were captured`);
  const manifest = join(workDirectory, "frames.ffconcat");
  const lines = ["ffconcat version 1.0"];
  for (let index = 0; index < frames.length; index += 1) {
    const current = frames[index];
    const next = frames[index + 1];
    const frameDuration = next
      ? next.timestamp - current.timestamp
      : 1 / 30;
    lines.push(`file '${basename(current.path)}'`, `duration ${frameDuration.toFixed(6)}`);
  }
  lines.push(`file '${basename(frames.at(-1)?.path ?? "")}'`);
  writeFileSync(manifest, `${lines.join("\n")}\n`);
  return { path: manifest, duration };
}

function run(command: string, arguments_: string[], label: string, cwd?: string): string {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const details = `${result.stderr || result.stdout || ""}`.trim().slice(-2_000);
    throw new Error(`${label} failed with exit code ${result.status}${details ? `: ${details}` : ""}`);
  }
  return result.stdout;
}

function encodeRecording(
  options: RecordingOptions,
  workDirectory: string,
  frames: Frame[],
  audioPath: string,
  audioTrimSeconds: number,
): { path: string; frameDuration: number } {
  const manifest = writeFrameManifest(workDirectory, frames);
  const encodedPath = join(workDirectory, "promptsoul-recording.mp4");
  run(options.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", "frames.ffconcat",
    "-i", audioPath,
    "-map", "0:v:0", "-map", "1:a:0",
    "-vf", "fps=30,format=yuv420p",
    "-af", `atrim=start=${audioTrimSeconds.toFixed(6)},asetpts=PTS-STARTPTS`,
    "-c:v", "libx264", "-preset", "medium", "-crf", "18",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    encodedPath,
  ], "ffmpeg encode/mux", workDirectory);
  return { path: encodedPath, frameDuration: manifest.duration };
}

export function validateProbeResult(probe: ProbeResult): {
  duration: number;
  videoDuration: number;
  videoCodec: string;
  audioCodec: string;
  audioDuration: number;
  avDurationDelta: number;
} {
  const duration = Number(probe.format?.duration);
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  const videoDuration = Number(video?.duration);
  const audioDuration = Number(audio?.duration);
  if (!video) throw new Error("ffprobe found no video stream in the recording");
  if (!audio) throw new Error("ffprobe found no audio stream in the recording");
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("ffprobe reported an invalid recording duration");
  if (!Number.isFinite(videoDuration) || videoDuration <= 0) throw new Error("ffprobe reported an invalid video duration");
  if (!Number.isFinite(audioDuration) || audioDuration <= 0) throw new Error("ffprobe reported an invalid audio duration");
  const avDurationDelta = Math.abs(videoDuration - audioDuration);
  if (avDurationDelta > MAX_AV_DURATION_DELTA_SECONDS) {
    throw new Error(
      `ffprobe found ${avDurationDelta.toFixed(3)}s of audio/video duration drift ` +
      `(video ${videoDuration.toFixed(3)}s, audio ${audioDuration.toFixed(3)}s)`,
    );
  }
  return {
    duration,
    videoDuration,
    videoCodec: video.codec_name || "unknown",
    audioCodec: audio.codec_name || "unknown",
    audioDuration,
    avDurationDelta,
  };
}

function probeRecording(options: RecordingOptions, videoPath: string): ReturnType<typeof validateProbeResult> {
  const output = run(options.ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,codec_name,duration",
    "-of", "json",
    videoPath,
  ], "ffprobe validation");
  return validateProbeResult(JSON.parse(output) as ProbeResult);
}

export function parseVolumeDetect(output: string): { meanVolumeDb: number; maxVolumeDb: number } {
  const readLevel = (name: string): number => {
    const match = output.match(new RegExp(`${name}:\\s*(-?inf|[+-]?\\d+(?:\\.\\d+)?)\\s*dB`, "iu"));
    if (!match) throw new Error(`ffmpeg volumedetect did not report ${name}`);
    return match[1].toLowerCase() === "-inf" ? Number.NEGATIVE_INFINITY : Number(match[1]);
  };
  const meanVolumeDb = readLevel("mean_volume");
  const maxVolumeDb = readLevel("max_volume");
  if (!Number.isFinite(meanVolumeDb) || !Number.isFinite(maxVolumeDb)) {
    throw new Error("The final muxed audio track is digital silence");
  }
  if (maxVolumeDb <= MIN_FINAL_MAX_VOLUME_DB || meanVolumeDb <= MIN_FINAL_MEAN_VOLUME_DB) {
    throw new Error(
      `The final muxed audio track is effectively silent ` +
      `(mean ${meanVolumeDb.toFixed(1)} dB, max ${maxVolumeDb.toFixed(1)} dB)`,
    );
  }
  return { meanVolumeDb, maxVolumeDb };
}

function inspectFinalAudio(
  options: RecordingOptions,
  videoPath: string,
): ReturnType<typeof parseVolumeDetect> {
  const result = spawnSync(options.ffmpeg, [
    "-hide_banner", "-nostats", "-i", videoPath,
    "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-",
  ], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error(`ffmpeg audio validation could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const details = `${result.stderr || result.stdout || ""}`.trim().slice(-2_000);
    throw new Error(
      `ffmpeg audio validation failed with exit code ${result.status}${details ? `: ${details}` : ""}`,
    );
  }
  return parseVolumeDetect(`${result.stdout || ""}\n${result.stderr || ""}`);
}

function extractValidationFrames(
  options: RecordingOptions,
  videoPath: string,
  duration: number,
  workDirectory: string,
): { count: number; positionsSeconds: number[] } {
  const directory = join(workDirectory, "validation-frames");
  mkdirSync(directory, { recursive: true });
  const positions = [0.15, Math.max(0.15, duration / 2), Math.max(0.15, duration - 0.2)];
  positions.forEach((position, index) => {
    const output = join(directory, `check-${index + 1}.jpg`);
    run(options.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", Math.min(position, Math.max(0, duration - 0.01)).toFixed(3),
      "-i", videoPath,
      "-frames:v", "1", "-q:v", "2",
      output,
    ], `validation frame ${index + 1}`);
    if (!existsSync(output) || statSync(output).size < 1_000) {
      throw new Error(`Validation frame ${index + 1} is missing or empty`);
    }
  });
  return { count: positions.length, positionsSeconds: positions };
}

async function stopChrome(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<boolean>((resolvePromise) => child.once("exit", () => resolvePromise(true)));
  child.kill("SIGTERM");
  if (await Promise.race([exited, delay(5_000, false, { ref: false })])) return;
  child.kill("SIGKILL");
  await Promise.race([exited, delay(2_000, false, { ref: false })]);
}

async function record(options: RecordingOptions): Promise<void> {
  const baseUrl = `http://127.0.0.1:${options.port}`;
  const ttsStatus = await preflightStatus(baseUrl);
  mkdirSync(dirname(options.output), { recursive: true });
  if (existsSync(options.output) && lstatSync(options.output).isSymbolicLink()) {
    throw new Error("The recording output must not be a symbolic link");
  }
  const workDirectory = mkdtempSync(join(dirname(options.output), ".record-browser-"));
  const profile = join(workDirectory, "chrome-profile");
  mkdirSync(profile);

  let chrome: ChildProcess | null = null;
  let client: CdpClient | null = null;
  let captureStarted = false;
  let screencastStarted = false;
  let cleanupPromise: Promise<void> | null = null;
  const frames: Frame[] = [];
  const runtimeErrors: string[] = [];
  let frameClockCalibration: FrameClockCalibration | null = null;
  let frameTimestampMode: FrameTimestampMode | null = null;
  let frameClockError: Error | null = null;

  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      if (client && captureStarted) {
        await evaluate(client, "window.PromptSoulTTS?.stopAudioCapture?.().catch(() => null)").catch(() => undefined);
      }
      if (client && screencastStarted) {
        await client.send("Page.stopScreencast").catch(() => undefined);
      }
      try { client?.close(); } catch { /* best-effort shutdown */ }
      if (chrome) await stopChrome(chrome).catch(() => undefined);
      try { rmSync(workDirectory, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    })();
    return cleanupPromise;
  };
  const stopForSignal = (code: number): void => { void cleanup().finally(() => process.exit(code)); };
  const onInterrupt = (): void => stopForSignal(130);
  const onTermination = (): void => stopForSignal(143);
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTermination);

  try {
    const started = await startChrome(options, profile);
    chrome = started.child;
    client = await CdpClient.connect(await pageDebuggerUrl(started.debuggerUrl));
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Log.enable");
    frameClockCalibration = await calibrateFrameClock(client);
    client.on("Runtime.exceptionThrown", (params) => {
      const details = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
      runtimeErrors.push(details?.exception?.description || details?.text || "Unhandled page exception");
    });
    client.on("Log.entryAdded", (params) => {
      const entry = params.entry as { level?: string; text?: string; url?: string; source?: string } | undefined;
      if (entry?.level === "error") {
        const faviconMiss = entry.url && (() => {
          try {
            const url = new URL(entry.url);
            return url.origin === baseUrl && url.pathname === "/favicon.ico" &&
              /status of 404|404 \(Not Found\)/iu.test(entry.text || "");
          } catch {
            return false;
          }
        })();
        if (faviconMiss) return;
        const location = entry.url ? ` (${entry.url})` : entry.source ? ` [${entry.source}]` : "";
        runtimeErrors.push(`${entry.text || "Browser log error"}${location}`);
      }
    });
    client.on("Runtime.consoleAPICalled", (params) => {
      const call = params as {
        type?: string;
        args?: Array<{ value?: unknown; description?: string }>;
      };
      if (call.type !== "error" && call.type !== "assert") return;
      const message = (call.args ?? []).map((argument) => (
        typeof argument.value === "string"
          ? argument.value
          : argument.description || String(argument.value ?? "")
      )).filter(Boolean).join(" ");
      runtimeErrors.push(message || `Browser console.${call.type}`);
    });
    client.on("Page.screencastFrame", (params) => {
      if (typeof params.data !== "string" || typeof params.sessionId !== "number") return;
      const acknowledge = (): void => {
        void client?.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => undefined);
      };
      if (frameClockError) {
        acknowledge();
        return;
      }
      try {
        if (!frameClockCalibration) throw new Error("The frame clock was not calibrated before screencasting");
        const receivedAt = Date.now();
        const metadata = params.metadata as { timestamp?: unknown } | undefined;
        const timestamp = numberValue(metadata?.timestamp);
        frameTimestampMode ??= resolveFrameTimestampMode(timestamp, receivedAt, frameClockCalibration);
        const wallTimeMs = frameTimestampToWallTime(timestamp, frameClockCalibration, frameTimestampMode);
        const deliveryDelay = receivedAt - wallTimeMs;
        if (deliveryDelay < -100 || deliveryDelay > MAX_FRAME_DELIVERY_DELAY_MS) {
          throw new Error(`Chrome delivered a frame with an invalid ${Math.round(deliveryDelay)}ms clock offset`);
        }
        if (frames.length && timestamp <= frames[frames.length - 1].timestamp) {
          throw new Error("Chrome screencast timestamps stopped increasing");
        }
        const path = join(workDirectory, `frame-${String(frames.length).padStart(6, "0")}.jpg`);
        writeFileSync(path, Buffer.from(params.data, "base64"));
        frames.push({ path, timestamp, wallTimeMs });
      } catch (error) {
        frameClockError = error instanceof Error ? error : new Error("Could not timestamp a Chrome frame");
      }
      acknowledge();
    });

    await client.send("Emulation.setDeviceMetricsOverride", {
      width: options.width,
      height: options.height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: options.width,
      screenHeight: options.height,
    });
    const navigation = await client.send<{ errorText?: string }>("Page.navigate", { url: `${baseUrl}/` });
    if (navigation.errorText) throw new Error(`Navigation failed: ${navigation.errorText}`);
    await waitForPageReady(client, Math.min(options.timeoutMs, 90_000));

    await evaluate(client, `(() => {
      const style = document.createElement("style");
      style.textContent = "::-webkit-scrollbar{display:none!important}html{scrollbar-width:none!important}";
      document.head.appendChild(style);
      window.scrollTo(0, 0);
    })()`);

    // This is a real CDP pointer click. It creates the same user activation that
    // the unattended Chrome session uses in production, rather than pretending
    // an HTTP 200 means Web Audio is running.
    await clickElement(client, ".voice-trigger", "TTS debug trigger");
    await delay(100);
    await setDebugText(client, options.text);
    const unlocked = await evaluate<boolean>(client, "window.PromptSoulTTS?.unlock?.() ?? false");
    if (!unlocked) throw new Error("The automated browser gesture did not unlock AudioContext");
    await clickElement(client, ".tts-debug-panel .provider-close", "TTS debug close button");
    const dialogCloseDeadline = Date.now() + 2_000;
    let dialogOpen = true;
    while (dialogOpen && Date.now() < dialogCloseDeadline) {
      dialogOpen = await evaluate<boolean>(
        client,
        "document.querySelector('.tts-debug-panel')?.closest('dialog')?.hasAttribute('open') === true",
      );
      if (dialogOpen) await delay(25);
    }
    if (dialogOpen) {
      // The real pointer attempt above may be swallowed while a controlled
      // dialog rerenders after its async status refresh. Closing the already
      // opened native dialog is a deterministic UI cleanup, not an audio or
      // readiness shortcut; all playback evidence remains independently gated.
      dialogOpen = !(await evaluate<boolean>(client, `(() => {
        const dialog = document.querySelector(".tts-debug-panel")?.closest("dialog");
        if (!(dialog instanceof HTMLDialogElement)) return false;
        if (dialog.open) dialog.close();
        return !dialog.open;
      })()`));
    }
    await evaluate(client, "document.querySelector('#stage')?.scrollIntoView({ block: 'center', inline: 'center' })");
    await delay(100);
    const stageState = await evaluate<{
      dialogOpen: boolean;
      stageExists: boolean;
      canvasExists: boolean;
      width: number;
      height: number;
      visible: boolean;
      inViewport: boolean;
    }>(client, `(() => {
      const dialog = document.querySelector(".tts-debug-panel")?.closest("dialog");
      const stage = document.querySelector("#stage");
      const canvas = stage?.querySelector("canvas");
      const rect = stage instanceof HTMLElement ? stage.getBoundingClientRect() : null;
      const visible = stage instanceof HTMLElement && getComputedStyle(stage).visibility !== "hidden";
      return {
        dialogOpen: dialog?.hasAttribute("open") === true,
        stageExists: stage instanceof HTMLElement,
        canvasExists: canvas instanceof HTMLCanvasElement,
        width: rect?.width || 0,
        height: rect?.height || 0,
        visible,
        inViewport: Boolean(rect && rect.bottom > 0 && rect.top < innerHeight),
      };
    })()`);
    if (
      stageState.dialogOpen ||
      !stageState.stageExists ||
      !stageState.canvasExists ||
      stageState.width <= 100 ||
      stageState.height <= 100 ||
      !stageState.visible ||
      !stageState.inViewport
    ) {
      throw new Error(`The Live2D stage is not recordable after closing TTS debug: ${JSON.stringify(stageState)}`);
    }

    await client.send("Page.startScreencast", {
      format: "jpeg",
      quality: 92,
      maxWidth: options.width,
      maxHeight: options.height,
      everyNthFrame: 1,
    });
    screencastStarted = true;
    const firstFrameDeadline = Date.now() + 10_000;
    while (!frames.length && !frameClockError && Date.now() < firstFrameDeadline) await delay(25);
    if (frameClockError) throw frameClockError;
    if (!frames.length) throw new Error("Chrome produced no screencast frames");

    const captureStart = await evaluate<{ mimeType: string; startedAt: number }>(
      client,
      "window.PromptSoulTTS.startAudioCapture()",
    );
    if (!captureStart?.mimeType || !(captureStart.startedAt > 0)) {
      throw new Error("The runtime could not start AudioContext output capture");
    }
    captureStarted = true;

    const queued = await evaluate<number[]>(
      client,
      `window.PromptSoulTTS.play(${JSON.stringify(options.text)})`,
    );
    if (!Array.isArray(queued)) {
      throw new Error("The existing TTS playback manager returned an invalid queue result");
    }
    const evidence = await waitForRealPlayback(client, options.timeoutMs);

    // Flush any final streaming fragment. The debug preview already flushes its
    // own text, so this is a no-op there and closes the contract for chat-driven
    // unattended recordings as well.
    await evaluate(client, "window.PromptSoulTTS.flushStreamingText()" );
    const ended = await waitForPlaybackEnd(client, evidence.audioStartedAt, options.timeoutMs);
    await delay(150);

    await client.send("Page.stopScreencast");
    screencastStarted = false;
    await delay(100);
    if (frameClockError) throw frameClockError;
    const capture = await evaluate<AudioCapture | null>(client, "window.PromptSoulTTS.stopAudioCapture()");
    captureStarted = false;
    if (!capture) throw new Error("The runtime returned no captured AudioContext audio");
    if (runtimeErrors.length) {
      throw new Error(`Browser reported an unhandled error: ${runtimeErrors[0]}`);
    }

    const audioPath = writeAudioCapture(workDirectory, capture);
    // Both media tracks now use browser epoch milliseconds: audio timestamps
    // originate in Date.now(), while CDP frame metadata is mapped through the
    // calibrated Chrome performance clock. Start on the closest real frame and
    // trim the captured AudioContext stream to that exact same instant.
    const aligned = selectAlignedFrames(frames, capture.startedAt, evidence.audioStartedAt);
    const trimSeconds = Math.max(0, (aligned.commonStartWallTimeMs - capture.startedAt) / 1_000);
    const encoded = encodeRecording(options, workDirectory, aligned.frames, audioPath, trimSeconds);
    const probe = probeRecording(options, encoded.path);
    const frameDurationError = Math.abs(probe.videoDuration - encoded.frameDuration);
    if (frameDurationError > 0.15) {
      throw new Error(
        `Encoded video duration differs from CDP frame timing by ${frameDurationError.toFixed(3)}s`,
      );
    }
    const audioLevels = inspectFinalAudio(options, encoded.path);
    const validationFrames = extractValidationFrames(
      options,
      encoded.path,
      probe.duration,
      workDirectory,
    );

    // Publishing is deliberately the final fallible filesystem operation. Until
    // every ffprobe, loudness and extracted-frame check above succeeds, all data
    // remains inside the disposable same-filesystem work directory.
    renameSync(encoded.path, options.output);

    console.log(JSON.stringify({
      output: options.output,
      frames: aligned.frames.length,
      duration: probe.duration,
      videoDuration: probe.videoDuration,
      videoCodec: probe.videoCodec,
      audioCodec: probe.audioCodec,
      audioDuration: probe.audioDuration,
      avDurationDelta: probe.avDurationDelta,
      audioLevels,
      frameClock: {
        mode: frameTimestampMode,
        commonStartWallTimeMs: aligned.commonStartWallTimeMs,
        audioStartOffsetMs: evidence.audioStartedAt - aligned.commonStartWallTimeMs,
      },
      tts: {
        speakerName: typeof ttsStatus.speakerName === "string" ? ttsStatus.speakerName : null,
        styleName: typeof ttsStatus.styleName === "string" ? ttsStatus.styleName : null,
        styleId: typeof ttsStatus.styleId === "number" ? ttsStatus.styleId : null,
        textLength: options.text.length,
        currentTimeAtProof: evidence.currentTime,
        durationAtProof: evidence.duration,
        rmsAtProof: evidence.currentRms,
        peakRms: Math.max(evidence.peakRms, ended.peakRms),
        mouthAtProof: evidence.mouthOpen,
        peakMouthOpen: Math.max(evidence.peakMouthOpen, ended.peakMouthOpen),
        lipSyncParameterIds: evidence.lipSyncParameterIds,
        mouthEvidence: evidence.mouthEvidence,
        artMeshDeformationVerified: evidence.artMeshDeformationVerified,
        audioStartedAt: evidence.audioStartedAt,
        audioEndedAt: ended.endedAt,
        finalRms: ended.finalRms,
        finalMouthOpen: ended.finalMouthOpen,
        finalState: ended.finalState,
        finalQueueLength: ended.finalQueueLength,
      },
      validationFrames,
    }, null, 2));
  } finally {
    try {
      await cleanup();
    } finally {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTermination);
    }
  }
}

async function main(): Promise<void> {
  await record(parseRecordingOptions(process.argv.slice(2)));
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`ERROR: ${error instanceof Error ? error.message : "unattended browser recording failed"}`);
    process.exitCode = 1;
  });
}
