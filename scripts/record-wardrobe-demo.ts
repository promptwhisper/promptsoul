#!/usr/bin/env node

import { spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  CdpClient,
  clickElement,
  evaluate,
  pageDebuggerUrl,
  parseRecordingOptions,
  preflightStatus,
  startChrome,
  stopChrome,
  type RecordingOptions,
} from "./record-browser";

interface DemoOptions {
  recording: RecordingOptions;
  prompt: string;
  motionPrompt: string;
  chatText: string;
  timeoutMs: number;
  savedPresetId?: string;
  savedMotionId?: string;
}

interface CapturedFrame {
  path: string;
  timestamp: number;
  receivedAt: number;
}

interface AudioCapture {
  mimeType: string;
  base64: string;
  size: number;
  startedAt: number;
  endedAt: number;
}

interface Marker {
  name: string;
  seconds: number;
}

interface ChatProof {
  simultaneous: boolean;
  completed: boolean;
  sawTts: boolean;
  sawMotion: boolean;
  sawMouth: boolean;
  sawVisibleStage: boolean;
  maxRms: number;
  maxMouthOpen: number;
  maxConcurrentSignals: number;
  lipSyncParameterIds: string[];
  provenAtMs: number | null;
  stageBounds: { top: number; bottom: number; width: number; height: number } | null;
}

interface SavedMotionTarget {
  id: string;
  group: "PromptSoul";
  index: number;
  duration: number;
}

const DEFAULT_OUTPUT = "artifacts/wardrobe-demo/raw/promptsoul-wardrobe-demo-raw.mp4";
const DEFAULT_PROMPT = "二次元暗黑发光机能学院风：黑色短款制服外套，紫蓝霓虹发光滚边，精致金属扣件和层次腰带；只重新设计衣服，严格保留角色原有脸部、发型、眼睛、身体比例、UV 布局和透明边界。";
const DEFAULT_MOTION = "开心地大幅向左歪头，再向右歪头，最后回到原位";
const DEFAULT_CHAT = "新衣服太酷了！开心地和我打个招呼吧";

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function parseOptions(args: string[]): DemoOptions {
  const allowed = new Set([
    "--chrome", "--ffmpeg", "--ffprobe", "--port", "--out", "--width", "--height", "--timeout",
    "--prompt", "--motion-prompt", "--chat-text",
    "--saved-preset",
    "--saved-motion",
  ]);
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.has(args[index])) throw new Error(`Unknown argument: ${args[index]}`);
    if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${args[index]} requires a value`);
  }
  const output = resolve(readOption(args, "--out") || DEFAULT_OUTPUT);
  if (extname(output).toLowerCase() !== ".mp4") throw new Error("--out must be an .mp4 path");
  const width = Number(readOption(args, "--width") || 1080);
  const height = Number(readOption(args, "--height") || 1920);
  const port = Number(readOption(args, "--port") || 8765);
  const timeoutMs = Number(readOption(args, "--timeout") || 900_000);
  const recordingArgs = [
    "--port", String(port),
    "--out", output,
    "--text", readOption(args, "--chat-text") || DEFAULT_CHAT,
    "--width", String(width),
    "--height", String(height),
    "--timeout", String(Math.min(timeoutMs, 600_000)),
  ];
  for (const option of ["--chrome", "--ffmpeg", "--ffprobe"]) {
    const value = readOption(args, option);
    if (value) recordingArgs.push(option, value);
  }
  const recording = parseRecordingOptions(recordingArgs);
  const prompt = (readOption(args, "--prompt") || DEFAULT_PROMPT).trim();
  const motionPrompt = (readOption(args, "--motion-prompt") || DEFAULT_MOTION).trim();
  const chatText = (readOption(args, "--chat-text") || DEFAULT_CHAT).trim();
  const savedPresetId = readOption(args, "--saved-preset")?.trim();
  const savedMotionId = readOption(args, "--saved-motion")?.trim();
  if (prompt.length < 3 || prompt.length > 1_200) throw new Error("Wardrobe prompt must be 3-1200 characters");
  if (motionPrompt.length < 3 || motionPrompt.length > 1_000) throw new Error("Motion prompt must be 3-1000 characters");
  if (chatText.length < 1 || chatText.length > 240) throw new Error("Chat text must be 1-240 characters");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 1_800_000) {
    throw new Error("--timeout must be 60000-1800000 milliseconds");
  }
  if (savedPresetId && !/^outfit_[0-9a-f]{12}$/u.test(savedPresetId)) {
    throw new Error("--saved-preset must be a generated outfit preset ID");
  }
  if (savedMotionId && !/^promptsoul_ai_[0-9a-f]{12}$/u.test(savedMotionId)) {
    throw new Error("--saved-motion must be a generated PromptSoul motion ID");
  }
  return {
    recording,
    prompt,
    motionPrompt,
    chatText,
    timeoutMs,
    savedPresetId,
    savedMotionId,
  };
}

function run(command: string, args: string[], label: string, cwd?: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const details = `${result.stderr || result.stdout || ""}`.trim().slice(-3_000);
    throw new Error(`${label} failed (${result.status})${details ? `: ${details}` : ""}`);
  }
  return result.stdout;
}

async function waitFor(
  client: CdpClient,
  expression: string,
  label: string,
  timeoutMs: number,
  intervalMs = 150,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let latest: unknown = null;
  while (Date.now() < deadline) {
    latest = await evaluate(client, expression);
    if (latest === true) return;
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(latest)}`);
}

async function typeVisibleText(
  client: CdpClient,
  selector: string,
  text: string,
  label: string,
  delayMs = 28,
): Promise<void> {
  const cleared = await evaluate<boolean>(client, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement)) return false;
    if (document.body.dataset.recordingChatFocus !== "true") {
      element.scrollIntoView({ block: "center", inline: "center" });
    }
    element.focus();
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, "");
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return document.activeElement === element;
  })()`);
  if (!cleared) throw new Error(`Could not focus ${label}`);
  for (const character of text) {
    await client.send("Input.insertText", { text: character });
    await delay(delayMs);
  }
}

async function scrollTo(client: CdpClient, selector: string): Promise<void> {
  const found = await evaluate<boolean>(client, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return false;
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    return true;
  })()`);
  if (!found) throw new Error(`Could not scroll to ${selector}`);
  await delay(450);
}

async function enableChatFocusLayout(client: CdpClient): Promise<void> {
  const enabled = await evaluate<boolean>(client, `(() => {
    const stage = document.querySelector("#stage");
    const chat = document.querySelector(".chat-card");
    if (!(stage instanceof HTMLElement) || !(chat instanceof HTMLElement)) return false;
    let style = document.querySelector("#recordingChatFocusStyle");
    if (!(style instanceof HTMLStyleElement)) {
      style = document.createElement("style");
      style.id = "recordingChatFocusStyle";
      style.textContent = \`
        html:has(body[data-recording-chat-focus="true"]),
        body[data-recording-chat-focus="true"] {
          width: 100%;
          height: 100%;
          overflow: hidden !important;
          background: #090a12;
        }
        body[data-recording-chat-focus="true"] .ambient,
        body[data-recording-chat-focus="true"] .topbar,
        body[data-recording-chat-focus="true"] .page-footer,
        body[data-recording-chat-focus="true"] #wardrobeWorkshop,
        body[data-recording-chat-focus="true"] #motionWorkshop,
        body[data-recording-chat-focus="true"] .motion-deck {
          display: none !important;
        }
        body[data-recording-chat-focus="true"] .app-shell {
          width: 100vw !important;
          max-width: none !important;
          min-height: 100vh !important;
          margin: 0 !important;
          padding: 0 !important;
        }
        body[data-recording-chat-focus="true"] .lab-grid {
          display: block !important;
          width: 100vw !important;
          height: 100vh !important;
        }
        body[data-recording-chat-focus="true"] .character-card {
          position: fixed !important;
          z-index: 50 !important;
          inset: 0 0 auto 0 !important;
          width: 100vw !important;
          height: 590px !important;
          min-height: 590px !important;
          display: grid !important;
          grid-template-rows: 52px minmax(0, 1fr) !important;
          border-radius: 0 !important;
          overflow: hidden !important;
        }
        body[data-recording-chat-focus="true"] .character-heading {
          min-height: 52px !important;
          padding: 8px 14px !important;
        }
        body[data-recording-chat-focus="true"] .stage-wrap {
          height: auto !important;
          min-height: 0 !important;
        }
        body[data-recording-chat-focus="true"] .chat-card {
          position: fixed !important;
          z-index: 60 !important;
          inset: 590px 0 0 0 !important;
          width: 100vw !important;
          height: 370px !important;
          min-height: 0 !important;
          display: flex !important;
          flex-direction: column !important;
          border-radius: 0 !important;
          border-inline: 0 !important;
          border-bottom: 0 !important;
        }
        body[data-recording-chat-focus="true"] .chat-heading {
          min-height: 56px !important;
          padding: 7px 14px !important;
        }
        body[data-recording-chat-focus="true"] .chat-history {
          flex: 1 1 auto !important;
          min-height: 0 !important;
          padding: 8px 14px 5px !important;
        }
        body[data-recording-chat-focus="true"] .typing-row {
          min-height: 30px !important;
          padding: 3px 14px 5px !important;
        }
        body[data-recording-chat-focus="true"] .suggestion-area {
          display: none !important;
        }
        body[data-recording-chat-focus="true"] .chat-composer {
          flex: 0 0 auto !important;
          padding: 7px 10px !important;
        }
        body[data-recording-chat-focus="true"] .chat-footer {
          flex: 0 0 auto !important;
          min-height: 28px !important;
          padding-inline: 12px !important;
        }
      \`;
      document.head.append(style);
    }
    document.body.dataset.recordingChatFocus = "true";
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    return true;
  })()`);
  if (!enabled) throw new Error("Could not enable the recording chat focus layout");
  await waitFor(client, `(() => {
    const stage = document.querySelector("#stage");
    const chat = document.querySelector(".chat-card");
    const canvas = stage?.querySelector("canvas");
    if (!(stage instanceof HTMLElement) || !(chat instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) return false;
    const stageRect = stage.getBoundingClientRect();
    const chatRect = chat.getBoundingClientRect();
    return stageRect.top >= 48
      && stageRect.bottom <= 595
      && stageRect.width >= 500
      && stageRect.height >= 500
      && chatRect.top >= 585
      && chatRect.bottom <= window.innerHeight + 1
      && chatRect.width >= 500;
  })()`, "visible split-screen Live2D stage and chat", 10_000, 80);
}

async function preflightWardrobe(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/wardrobe`, {
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Wardrobe preflight returned HTTP ${response.status}`);
  const wardrobe = await response.json() as {
    available?: unknown;
    activePresetId?: unknown;
    revision?: unknown;
    modelName?: unknown;
    generator?: { provider?: unknown; available?: unknown };
  };
  if (wardrobe.available !== true) throw new Error("The active model does not allow wardrobe generation");
  if (wardrobe.generator?.provider !== "openai" || wardrobe.generator.available !== true) {
    throw new Error("Real OpenAI PromptSkin generation is required; mock and unavailable providers are rejected");
  }
  if (wardrobe.activePresetId !== "original") {
    const select = await fetch(`${baseUrl}/api/wardrobe/select`, {
      method: "POST",
      headers: {
        Host: new URL(baseUrl).host,
        Origin: baseUrl,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ presetId: "original", revision: wardrobe.revision }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!select.ok) throw new Error(`Could not restore the original outfit before recording: HTTP ${select.status}`);
  }
  return typeof wardrobe.modelName === "string" && wardrobe.modelName.trim()
    ? wardrobe.modelName.trim()
    : "Current model";
}

async function preflightSavedMotion(
  baseUrl: string,
  motionId: string | undefined,
): Promise<SavedMotionTarget | null> {
  if (!motionId) return null;
  const response = await fetch(`${baseUrl}/api/motions/capabilities`, {
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Motion preflight returned HTTP ${response.status}`);
  const payload = await response.json() as {
    motions?: Array<{
      name?: unknown;
      group?: unknown;
      index?: unknown;
      duration?: unknown;
    }>;
  };
  const motion = payload.motions?.find((entry) => entry.name === motionId);
  if (
    !motion
    || motion.group !== "PromptSoul"
    || !Number.isInteger(motion.index)
    || Number(motion.index) < 0
    || !(Number(motion.duration) > 0)
  ) {
    throw new Error(`Saved generated motion is unavailable: ${motionId}`);
  }
  return {
    id: motionId,
    group: "PromptSoul",
    index: Number(motion.index),
    duration: Number(motion.duration),
  };
}

function writeFrameManifest(directory: string, frames: CapturedFrame[]): { path: string; duration: number } {
  if (frames.length < 30) throw new Error(`Chrome produced only ${frames.length} frames`);
  const lines = ["ffconcat version 1.0"];
  let duration = 1 / 30;
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const next = frames[index + 1];
    const interval = next ? next.timestamp - frame.timestamp : 1 / 30;
    if (!Number.isFinite(interval) || interval <= 0 || interval > 1) {
      throw new Error(`Invalid screencast interval ${interval} at frame ${index}`);
    }
    duration += next ? interval : 0;
    lines.push(`file '${basename(frame.path)}'`, `duration ${interval.toFixed(6)}`);
  }
  lines.push(`file '${basename(frames.at(-1)!.path)}'`);
  const path = join(directory, "frames.ffconcat");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return { path, duration };
}

function writeAudio(directory: string, capture: AudioCapture): string {
  const bytes = Buffer.from(capture.base64, "base64");
  if (!capture.mimeType.startsWith("audio/") || bytes.length < 256 || capture.size < 256) {
    throw new Error("The browser returned no usable AudioContext recording");
  }
  const extension = capture.mimeType.includes("ogg") ? "ogg" : "webm";
  const path = join(directory, `audio.${extension}`);
  writeFileSync(path, bytes);
  return path;
}

function encode(
  options: DemoOptions,
  directory: string,
  frames: CapturedFrame[],
  capture: AudioCapture,
  videoStartWallTime: number,
): { encoded: string; duration: number } {
  const manifest = writeFrameManifest(directory, frames);
  const audio = writeAudio(directory, capture);
  const trim = Math.max(0, (videoStartWallTime - capture.startedAt) / 1_000);
  const encoded = join(directory, "encoded.mp4");
  run(options.recording.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", basename(manifest.path),
    "-i", basename(audio),
    "-map", "0:v:0", "-map", "1:a:0",
    "-vf", `scale=${options.recording.width}:${options.recording.height}:flags=lanczos,fps=30,format=yuv420p`,
    "-af", `atrim=start=${trim.toFixed(6)},asetpts=PTS-STARTPTS,apad`,
    "-t", manifest.duration.toFixed(6),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    basename(encoded),
  ], "wardrobe demo encoding", directory);
  return { encoded, duration: manifest.duration };
}

async function recordDemo(options: DemoOptions): Promise<void> {
  const baseUrl = `http://127.0.0.1:${options.recording.port}`;
  await preflightStatus(baseUrl);
  const modelName = await preflightWardrobe(baseUrl);
  const savedMotion = await preflightSavedMotion(baseUrl, options.savedMotionId);
  mkdirSync(dirname(options.recording.output), { recursive: true });
  if (existsSync(options.recording.output) && lstatSync(options.recording.output).isSymbolicLink()) {
    throw new Error("Recording output must not be a symbolic link");
  }
  const workDirectory = mkdtempSync(join(dirname(options.recording.output), ".wardrobe-record-"));
  const profile = join(workDirectory, "chrome-profile");
  mkdirSync(profile);
  const frames: CapturedFrame[] = [];
  const markers: Marker[] = [];
  const runtimeErrors: string[] = [];
  let chrome: ChildProcess | null = null;
  let client: CdpClient | null = null;
  let captureStarted = false;
  let screencastStarted = false;
  let videoStartWallTime = 0;
  let chatProof: ChatProof | null = null;

  const mark = (name: string): void => {
    if (!videoStartWallTime) return;
    markers.push({ name, seconds: Number(((Date.now() - videoStartWallTime) / 1_000).toFixed(3)) });
  };

  try {
    const started = await startChrome(options.recording, profile);
    chrome = started.child;
    client = await CdpClient.connect(await pageDebuggerUrl(started.debuggerUrl));
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Log.enable");
    client.on("Runtime.exceptionThrown", (params) => {
      const details = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
      runtimeErrors.push(details?.exception?.description || details?.text || "Unhandled page exception");
    });
    client.on("Runtime.consoleAPICalled", (params) => {
      const call = params as { type?: string; args?: Array<{ value?: unknown; description?: string }> };
      if (call.type !== "error" && call.type !== "assert") return;
      const message = (call.args || []).map((argument) => (
        typeof argument.value === "string" ? argument.value : argument.description || ""
      )).filter(Boolean).join(" ");
      runtimeErrors.push(message || `console.${call.type}`);
    });
    client.on("Page.screencastFrame", (params) => {
      if (typeof params.data !== "string" || typeof params.sessionId !== "number") return;
      const timestamp = Number((params.metadata as { timestamp?: unknown } | undefined)?.timestamp);
      if (Number.isFinite(timestamp) && (!frames.length || timestamp > frames.at(-1)!.timestamp)) {
        const path = join(workDirectory, `frame-${String(frames.length).padStart(7, "0")}.jpg`);
        const receivedAt = Date.now();
        writeFileSync(path, Buffer.from(params.data, "base64"));
        frames.push({ path, timestamp, receivedAt });
        if (!videoStartWallTime) videoStartWallTime = receivedAt;
      }
      void client?.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => undefined);
    });

    const cssWidth = Math.round(options.recording.width / 2);
    const cssHeight = Math.round(options.recording.height / 2);
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: cssWidth,
      height: cssHeight,
      deviceScaleFactor: 2,
      mobile: false,
      screenWidth: options.recording.width,
      screenHeight: options.recording.height,
    });
    const navigation = await client.send<{ errorText?: string }>("Page.navigate", { url: `${baseUrl}/` });
    if (navigation.errorText) throw new Error(`Navigation failed: ${navigation.errorText}`);
    await waitFor(client, `(() => {
      const wardrobe = document.querySelector("#wardrobeWorkshop");
      const model = document.querySelector("#modelState");
      return document.readyState === "complete"
        && model?.getAttribute("data-state") === "ready"
        && wardrobe?.getAttribute("data-state") === "ready"
        && document.querySelector("#wardrobeAvailability")?.textContent?.includes("OPENAI")
        && window.__AITUBER_DIAGNOSTICS__?.tts?.engineReady === true
        && window.__AITUBER_DIAGNOSTICS__?.tts?.voiceResolved === true;
    })()`, "Live2D, OpenAI wardrobe and AivisSpeech readiness", 120_000);

    const lipSyncAvailable = await evaluate<boolean>(
      client,
      'document.querySelector("#stage")?.getAttribute("data-lip-sync") === "available"',
    );
    if (!lipSyncAvailable) {
      throw new Error(
        `${modelName} has no bound mouth parameter; strict chat recording refuses audio-only lip sync`,
      );
    }

    await evaluate(client, `(() => {
      const style = document.createElement("style");
      style.textContent = "::-webkit-scrollbar{display:none!important}html{scrollbar-width:none!important}";
      document.head.appendChild(style);
      const modelName = ${JSON.stringify(modelName)};
      const attribution = modelName.toLowerCase().includes("rice")
        ? "Rice · 示例模型（版权归 Live2D Inc. 所有）"
        : modelName.toLowerCase().includes("chitose")
          ? "Chitose · 示例模型（版权归 Live2D Inc. 所有）"
        : modelName.toLowerCase().includes("mao")
          ? "Mao · 示例模型（版权归 Live2D Inc. 所有）"
        : modelName + " · 本地演示模型（版权归原作者所有）";
      const stageAttribution = document.querySelector("#stageAttribution");
      const footerAttribution = document.querySelector("#footerModelAttribution");
      if (stageAttribution) stageAttribution.textContent = attribution;
      if (footerAttribution) footerAttribution.textContent = "演示角色：" + attribution;
      window.scrollTo(0, 0);
    })()`);
    await clickElement(client, ".voice-trigger", "voice settings trigger");
    await delay(150);
    const unlocked = await evaluate<boolean>(client, "window.PromptSoulTTS?.unlock?.() ?? false");
    if (!unlocked) throw new Error("Could not unlock the browser AudioContext");
    await evaluate(client, `(() => {
      const dialog = document.querySelector(".tts-debug-panel")?.closest("dialog");
      if (dialog instanceof HTMLDialogElement && dialog.open) dialog.close();
    })()`);
    await scrollTo(client, "#stage");

    const captureStart = await evaluate<{ mimeType?: unknown; startedAt?: unknown }>(
      client,
      "window.PromptSoulTTS.startAudioCapture()",
    );
    if (typeof captureStart?.mimeType !== "string" || !(Number(captureStart.startedAt) > 0)) {
      throw new Error("Could not start browser audio capture");
    }
    captureStarted = true;
    await client.send("Page.startScreencast", {
      format: "jpeg",
      quality: 94,
      maxWidth: options.recording.width,
      maxHeight: options.recording.height,
      everyNthFrame: 1,
    });
    screencastStarted = true;
    await waitFor(client, "document.querySelectorAll('#stage canvas').length > 0", "first Live2D canvas", 10_000);
    const firstFrameDeadline = Date.now() + 10_000;
    while (!frames.length && Date.now() < firstFrameDeadline) await delay(25);
    if (!frames.length) throw new Error("Chrome produced no screencast frames");

    mark("original_model");
    await delay(3_000);
    let generatedPresetId = options.savedPresetId || "";
    await scrollTo(client, "#wardrobeWorkshop");
    if (generatedPresetId) {
      mark("wardrobe_prompt_start");
      await typeVisibleText(client, "#wardrobePrompt", options.prompt, "wardrobe prompt", 24);
      await delay(800);
      mark("wardrobe_prompt_complete");
      await clickElement(
        client,
        `#wardrobePresetList button[data-preset-id=${JSON.stringify(generatedPresetId)}]`,
        "saved generated outfit preset",
      );
      mark("saved_preset_submit");
      await waitFor(client, `(() => {
        const active = document.querySelector('#wardrobePresetList button[data-active="true"]');
        return active?.dataset.presetId === ${JSON.stringify(generatedPresetId)}
          && document.querySelector("#modelState")?.getAttribute("data-state") === "ready";
      })()`, "saved generated outfit switch", 45_000);
    } else {
      mark("wardrobe_prompt_start");
      await typeVisibleText(client, "#wardrobePrompt", options.prompt, "wardrobe prompt", 24);
      await delay(800);
      await clickElement(client, "#wardrobeGenerateButton", "Generate and wear button");
      mark("wardrobe_submit");
      await waitFor(client, "document.querySelector('#wardrobeForm')?.getAttribute('aria-busy') === 'true'", "wardrobe generation start", 10_000);
      await waitFor(client, `(() => {
        const form = document.querySelector("#wardrobeForm");
        const active = document.querySelector('#wardrobePresetList button[data-active="true"]');
        return form?.getAttribute("aria-busy") === "false"
          && active instanceof HTMLButtonElement
          && active.dataset.presetId !== "original"
          && document.querySelector("#modelState")?.getAttribute("data-state") === "ready";
      })()`, "real wardrobe generation and hot reload", options.timeoutMs, 300);
      generatedPresetId = await evaluate<string>(
        client,
        "document.querySelector('#wardrobePresetList button[data-active=\"true\"]')?.dataset.presetId || ''",
      );
    }
    if (!/^outfit_[0-9a-f]{12}$/u.test(generatedPresetId)) throw new Error("The OpenAI outfit was not saved as a real preset");
    mark("wardrobe_complete");
    await scrollTo(client, "#stage");
    mark("generated_model");
    await delay(4_500);

    await scrollTo(client, "#wardrobeWorkshop");
    await clickElement(client, '#wardrobePresetList button[data-preset-id="original"]', "original outfit preset");
    await waitFor(client, `(() => {
      const active = document.querySelector('#wardrobePresetList button[data-active="true"]');
      return active?.dataset.presetId === "original"
        && document.querySelector("#modelState")?.getAttribute("data-state") === "ready";
    })()`, "original outfit switch", 45_000);
    mark("preset_original");
    await scrollTo(client, "#stage");
    await delay(3_200);

    await scrollTo(client, "#wardrobeWorkshop");
    await clickElement(
      client,
      `#wardrobePresetList button[data-preset-id=${JSON.stringify(generatedPresetId)}]`,
      "generated outfit preset",
    );
    await waitFor(client, `(() => {
      const active = document.querySelector('#wardrobePresetList button[data-active="true"]');
      return active?.dataset.presetId === ${JSON.stringify(generatedPresetId)}
        && document.querySelector("#modelState")?.getAttribute("data-state") === "ready";
    })()`, "generated outfit switch", 45_000);
    mark("preset_generated");
    await scrollTo(client, "#stage");
    await delay(4_200);

    await scrollTo(client, "#motionWorkshop");
    mark("motion_prompt_start");
    await typeVisibleText(client, "#motionPrompt", options.motionPrompt, "motion prompt", 30);
    await delay(700);
    mark("motion_prompt_complete");
    if (savedMotion) {
      const savedMotionSelector = `.motion-button[data-group=${JSON.stringify(savedMotion.group)}][data-index=${JSON.stringify(String(savedMotion.index))}]`;
      await clickElement(
        client,
        savedMotionSelector,
        "saved generated motion button",
      );
      mark("saved_motion_submit");
    } else {
      await clickElement(client, "#motionGenerateButton", "Generate motion button");
      mark("motion_submit");
      await waitFor(client, "document.querySelector('#motionWorkshopForm')?.getAttribute('aria-busy') === 'true'", "motion generation start", 10_000);
      await waitFor(client, `(() => {
        const form = document.querySelector("#motionWorkshopForm");
        const result = document.querySelector("#motionWorkshopResult");
        return form?.getAttribute("aria-busy") === "false"
          && result instanceof HTMLElement
          && !result.hidden
          && document.querySelector("#modelState")?.getAttribute("data-state") === "ready";
      })()`, "motion generation", 240_000, 250);
      mark("motion_complete");
      await clickElement(client, "#motionReplayButton", "Replay generated motion button");
    }
    const playingSelector = savedMotion
      ? `.motion-button[data-group=${JSON.stringify(savedMotion.group)}][data-index=${JSON.stringify(String(savedMotion.index))}].is-playing`
      : ".motion-button.is-playing";
    await waitFor(
      client,
      `document.querySelector(${JSON.stringify(playingSelector)}) instanceof HTMLButtonElement`,
      "generated motion playback",
      10_000,
    );
    await scrollTo(client, "#stage");
    mark("motion_playing");
    await waitFor(
      client,
      `!document.querySelector(${JSON.stringify(playingSelector)})`,
      "complete generated motion cycle",
      15_000,
      40,
    );
    mark("motion_playback_complete");
    await delay(700);

    await enableChatFocusLayout(client);
    await clickElement(client, "#resetView", "Reset model for visible chat stage");
    await delay(850);
    await evaluate(client, `(() => {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      const proof = {
        simultaneous: false,
        completed: false,
        sawTts: false,
        sawMotion: false,
        sawMouth: false,
        sawVisibleStage: false,
        maxRms: 0,
        maxMouthOpen: 0,
        maxConcurrentSignals: 0,
        lipSyncParameterIds: [],
        provenAtMs: null,
        stageBounds: null,
      };
      document.body.dataset.recordingSmoothTts = "true";
      window.__PROMPTSOUL_RECORDING_CHAT_PROOF__ = proof;
      const startedAt = performance.now();
      const sample = () => {
        const tts = window.__AITUBER_DIAGNOSTICS__?.tts;
        const stage = document.querySelector("#stage");
        const rect = stage instanceof HTMLElement ? stage.getBoundingClientRect() : null;
        const rms = Number(tts?.currentRms) || 0;
        const mouth = Number(tts?.mouthOpen) || 0;
        const ttsPlaying = tts?.state === "playing" && Number(tts.currentTime) > 0 && rms > 0.003;
        const motionPlaying = document.querySelector(".motion-button.is-playing") instanceof HTMLButtonElement;
        const mouthMoving = mouth > 0.015
          && Array.isArray(tts?.lipSyncParameterIds)
          && tts.lipSyncParameterIds.length > 0;
        const stageVisible = rect !== null
          && rect.top >= 0
          && rect.bottom <= 600
          && rect.width >= 500
          && rect.height >= 450;
        proof.sawTts ||= ttsPlaying;
        proof.sawMotion ||= motionPlaying;
        proof.sawMouth ||= mouthMoving;
        proof.sawVisibleStage ||= stageVisible;
        proof.maxRms = Math.max(proof.maxRms, rms);
        proof.maxMouthOpen = Math.max(proof.maxMouthOpen, mouth);
        proof.maxConcurrentSignals = Math.max(
          proof.maxConcurrentSignals,
          Number(ttsPlaying) + Number(motionPlaying) + Number(mouthMoving),
        );
        proof.stageBounds = rect === null ? null : {
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
        proof.lipSyncParameterIds = Array.isArray(tts?.lipSyncParameterIds)
          ? [...tts.lipSyncParameterIds]
          : proof.lipSyncParameterIds;
        if (!proof.simultaneous && ttsPlaying && motionPlaying && mouthMoving && stageVisible) {
          proof.simultaneous = true;
          proof.provenAtMs = Math.round(performance.now() - startedAt);
        }
        proof.completed ||= proof.sawTts
          && tts?.state === "idle"
          && Number(tts?.audioEndedAt) > 0;
        window.requestAnimationFrame(sample);
      };
      window.requestAnimationFrame(sample);
    })()`);
    mark("chat_focus_visible");
    mark("chat_prompt_start");
    await typeVisibleText(client, "#chatInput", options.chatText, "chat message", 34);
    await delay(650);
    await clickElement(client, "#sendButton", "Send chat button");
    mark("chat_submit");
    await waitFor(
      client,
      `(() => {
        const tts = window.__AITUBER_DIAGNOSTICS__?.tts;
        return tts?.state === "playing" && Number(tts.currentTime) > 0 && Number(tts.currentRms) > 0.003;
      })()`,
      "continuous synthesized speech playback",
      180_000,
      40,
    );
    const chatMotionEnsured = await evaluate<boolean>(client, `(() => {
      if (document.querySelector(".motion-button.is-playing")) return true;
      const replay = document.querySelector("#motionReplayButton");
      if (!(replay instanceof HTMLButtonElement) || replay.disabled) return false;
      replay.click();
      return true;
    })()`);
    if (!chatMotionEnsured) throw new Error("Could not synchronize a generated motion with chat speech");
    try {
      await waitFor(
        client,
        `(() => {
          const proof = window.__PROMPTSOUL_RECORDING_CHAT_PROOF__;
          return proof?.simultaneous === true || proof?.completed === true;
        })()`,
        "simultaneous AI reply, real voice, mouth movement and action or completed speech",
        180_000,
        40,
      );
    } catch (error) {
      chatProof = await evaluate<ChatProof>(client, "window.__PROMPTSOUL_RECORDING_CHAT_PROOF__");
      throw new Error(
        `${error instanceof Error ? error.message : "Chat proof failed"}; evidence=${JSON.stringify(chatProof)}`,
      );
    }
    chatProof = await evaluate<ChatProof>(client, "window.__PROMPTSOUL_RECORDING_CHAT_PROOF__");
    if (!chatProof.simultaneous) {
      throw new Error(`Chat completed without simultaneous voice, mouth movement and action; evidence=${JSON.stringify(chatProof)}`);
    }
    mark("voice_action_proven");
    await waitFor(client, `(() => {
      const tts = window.__AITUBER_DIAGNOSTICS__?.tts;
      return document.querySelector("#chatForm")?.getAttribute("aria-busy") === "false"
        && tts?.state === "idle"
        && Number(tts.queueLength) === 0
        && Number(tts.audioEndedAt) > 0;
    })()`, "chat and voice completion", 180_000, 80);
    mark("voice_action_complete");
    await delay(1_500);
    mark("final_model");
    await delay(3_500);

    await client.send("Page.stopScreencast");
    screencastStarted = false;
    await delay(150);
    const capture = await evaluate<AudioCapture | null>(client, "window.PromptSoulTTS.stopAudioCapture()");
    captureStarted = false;
    if (!capture) throw new Error("Browser audio capture returned no result");
    if (runtimeErrors.length) throw new Error(`Browser runtime error: ${runtimeErrors[0]}`);

    const encoded = encode(options, workDirectory, frames, capture, videoStartWallTime);
    const probeText = run(options.recording.ffprobe, [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,r_frame_rate",
      "-of", "json",
      encoded.encoded,
    ], "wardrobe demo ffprobe");
    const probe = JSON.parse(probeText) as {
      format?: { duration?: string };
      streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string }>;
    };
    const video = probe.streams?.find((stream) => stream.codec_type === "video");
    const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
    const duration = Number(probe.format?.duration);
    if (
      video?.codec_name !== "h264"
      || audio?.codec_name !== "aac"
      || video.width !== options.recording.width
      || video.height !== options.recording.height
      || video.r_frame_rate !== "30/1"
      || !Number.isFinite(duration)
      || duration <= 20
    ) {
      throw new Error(`Encoded recording failed validation: ${probeText}`);
    }
    const markerPath = options.recording.output.replace(/\.mp4$/iu, ".markers.json");
    renameSync(encoded.encoded, options.recording.output);
    writeFileSync(markerPath, `${JSON.stringify({
      source: options.recording.output,
      prompt: options.prompt,
      motionPrompt: options.motionPrompt,
      chatText: options.chatText,
      generatedPresetId,
      generatedMotionId: savedMotion?.id || null,
      generatedMotionDuration: savedMotion?.duration || null,
      chatLayout: "stage-and-chat-split",
      chatProof,
      duration,
      frames: frames.length,
      markers,
    }, null, 2)}\n`);
    if (!existsSync(options.recording.output) || statSync(options.recording.output).size < 1_000_000) {
      throw new Error("Published recording is missing or too small");
    }
    console.log(JSON.stringify({
      output: options.recording.output,
      markerPath,
      duration,
      frames: frames.length,
      generatedPresetId,
      markers,
    }, null, 2));
  } finally {
    if (client && screencastStarted) await client.send("Page.stopScreencast").catch(() => undefined);
    if (client && captureStarted) {
      await evaluate(client, "window.PromptSoulTTS?.stopAudioCapture?.().catch(() => null)").catch(() => undefined);
    }
    try { client?.close(); } catch { /* best effort */ }
    if (chrome) await stopChrome(chrome).catch(() => undefined);
    rmSync(workDirectory, { recursive: true, force: true });
  }
}

recordDemo(parseOptions(process.argv.slice(2))).catch((error: unknown) => {
  console.error(`ERROR: ${error instanceof Error ? error.message : "wardrobe demo recording failed"}`);
  process.exitCode = 1;
});
