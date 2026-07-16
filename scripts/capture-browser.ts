#!/usr/bin/env node

import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

type JsonObject = Record<string, unknown>;

interface Options {
  chrome: string;
  port: number;
  output: string;
  motion: string | null;
  freeze: number | null;
}

interface CapturePlan {
  name: string;
  width: number;
  height: number;
  query: string;
  readyMode: "motion" | "uitest" | "model";
}

interface PageState {
  href: string;
  documentReady: string;
  modelState: string;
  modelCopy: string;
  status: string;
  attribution: string;
  attributionVisible: boolean;
  horizontalOverflow: boolean;
}

interface MotionEntry {
  File?: unknown;
}

interface ModelDocument {
  FileReferences?: { Motions?: Record<string, MotionEntry[]> };
}

interface ActiveModel {
  document: ModelDocument;
  runtimeDirectory: string;
}

interface CdpResponse {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const COMMAND_TIMEOUT_MS = 30_000;
const PAGE_READY_TIMEOUT_MS = 45_000;

function usage(): string {
  return [
    "Usage: tsx scripts/capture-browser.ts --chrome <path> --port <number> --out <directory>",
    "       [--motion PromptSoul:0] [--freeze 1.2]",
  ].join("\n");
}

function parseOptions(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (!["--chrome", "--port", "--out", "--motion", "--freeze"].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}\n${usage()}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}\n${usage()}`);
    }
    values.set(argument, value);
    index += 1;
  }

  const chrome = values.get("--chrome");
  const output = values.get("--out");
  const port = Number(values.get("--port"));
  const freezeValue = values.get("--freeze");
  const freeze = freezeValue === undefined ? null : Number(freezeValue);
  if (!chrome || !output || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(usage());
  }
  if (freeze !== null && (!Number.isFinite(freeze) || freeze <= 0)) {
    throw new Error("--freeze must be a positive finite number");
  }
  return {
    chrome,
    port,
    output,
    motion: values.get("--motion") ?? null,
    freeze,
  };
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data) as CdpResponse;
      if (message.id === undefined) return;
      const command = this.pending.get(message.id);
      if (!command) return;
      this.pending.delete(message.id);
      clearTimeout(command.timer);
      if (message.error) {
        command.reject(new Error(`CDP error ${message.error.code ?? ""}: ${message.error.message ?? "unknown error"}`));
      } else {
        command.resolve(message.result);
      }
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

  send<T extends JsonObject>(method: string, params: JsonObject = {}): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
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
  chrome: string,
  profile: string,
  onSpawn: (child: ChildProcess) => void,
): Promise<{ child: ChildProcess; debuggerUrl: string }> {
  const child = spawn(chrome, [
    "--headless",
    "--use-angle=swiftshader-webgl",
    "--enable-unsafe-swiftshader",
    "--force-device-scale-factor=1",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--window-size=1440,1000",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  onSpawn(child);

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

function resolveRuntimePath(base: string, relativePath: string, description: string): string {
  if (!relativePath || relativePath.includes("\\") || isAbsolute(relativePath)) {
    throw new Error(`${description} has an unsafe runtime path`);
  }
  const resolvedBase = realpathSync(base);
  const candidate = realpathSync(resolve(resolvedBase, relativePath));
  const child = relative(resolvedBase, candidate);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`${description} escapes its allowed directory`);
  }
  return candidate;
}

function readActiveModel(): ActiveModel {
  const workspaceRoot = realpathSync(process.cwd());
  const config = JSON.parse(readFileSync("model.config.json", "utf8")) as { model3?: unknown };
  if (typeof config.model3 !== "string" || !config.model3) {
    throw new Error("model.config.json does not contain a model3 path");
  }
  const modelPath = resolveRuntimePath(workspaceRoot, config.model3, "The active model");
  return {
    document: JSON.parse(readFileSync(modelPath, "utf8")) as ModelDocument,
    runtimeDirectory: dirname(modelPath),
  };
}

function readMotionDuration(runtimeDirectory: string, entry: MotionEntry, description: string): number {
  if (typeof entry.File !== "string" || !entry.File) {
    throw new Error(`${description} has no runtime file`);
  }
  const motionPath = resolveRuntimePath(runtimeDirectory, entry.File, description);
  const motion = JSON.parse(readFileSync(motionPath, "utf8")) as {
    Meta?: { Duration?: unknown };
  };
  const duration = Number(motion.Meta?.Duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`${description} has an invalid duration`);
  }
  return duration;
}

function readCapturePlans(options: Options): CapturePlan[] {
  const activeModel = readActiveModel();
  if (options.motion) {
    const match = options.motion.match(/^([A-Za-z0-9_@.-]+):(\d+)$/u);
    if (!match) throw new Error("--motion must use the form Group:index");
    const group = match[1];
    const index = Number(match[2]);
    const entry = activeModel.document.FileReferences?.Motions?.[group]?.[index];
    if (!entry) throw new Error(`The active model does not contain ${options.motion}`);
    const duration = readMotionDuration(activeModel.runtimeDirectory, entry, options.motion);
    const freeze = options.freeze ?? Math.min(1, Math.round(duration * 40) / 100);
    if (freeze >= duration) {
      throw new Error(`--freeze must be shorter than the ${duration}s motion duration`);
    }
    const query = new URLSearchParams({ play: options.motion, freeze: String(freeze) }).toString();
    return [{
      name: options.motion.replaceAll(":", "_"),
      width: 900,
      height: 800,
      query,
      readyMode: "motion",
    }];
  }

  const motions = activeModel.document.FileReferences?.Motions?.PromptSoul;
  if (!Array.isArray(motions) || motions.length === 0) {
    throw new Error("The active model has no PromptSoul motions to verify");
  }
  const plans = motions.map((entry, index): CapturePlan => {
    const description = `PromptSoul motion ${index}`;
    const duration = readMotionDuration(activeModel.runtimeDirectory, entry, description);
    const freeze = Math.round(duration * 40) / 100;
    const stem = basename(String(entry.File), ".motion3.json").replace(/[^A-Za-z0-9_.-]+/gu, "_");
    return {
      name: `promptsoul${index}_${stem}`,
      width: 900,
      height: 800,
      query: new URLSearchParams({ play: `PromptSoul:${index}`, freeze: String(freeze) }).toString(),
      readyMode: "motion",
    };
  });
  plans.push(
    { name: "uitest", width: 900, height: 800, query: "uitest=1", readyMode: "uitest" },
    { name: "ui-desktop", width: 1440, height: 1000, query: "", readyMode: "model" },
    { name: "ui-mobile", width: 390, height: 844, query: "", readyMode: "model" },
  );
  return plans;
}

async function evaluatePageState(client: CdpClient): Promise<PageState> {
  const expression = String.raw`(() => {
    const model = document.querySelector("#modelState");
    const status = document.querySelector("#status .status-text");
    const attribution = document.querySelector("#stageAttribution");
    const rect = attribution?.getBoundingClientRect();
    const style = attribution ? getComputedStyle(attribution) : null;
    return {
      href: location.href,
      documentReady: document.readyState,
      modelState: model?.getAttribute("data-state") || "",
      modelCopy: model?.querySelector(".state-copy")?.textContent || "",
      status: status?.textContent || "",
      attribution: attribution?.textContent || "",
      attributionVisible: Boolean(rect && style && rect.bottom > 0 && rect.right > 0 &&
        rect.top < innerHeight && rect.left < innerWidth && style.display !== "none" &&
        style.visibility !== "hidden" && Number(style.opacity) > 0),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  })()`;
  const response = await client.send<{
    result?: { value?: PageState };
    exceptionDetails?: unknown;
  }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails || !response.result?.value) {
    throw new Error("Could not inspect the rendered page state");
  }
  return response.result.value;
}

async function waitForReady(client: CdpClient, plan: CapturePlan, expectedUrl: string): Promise<PageState> {
  const deadline = Date.now() + PAGE_READY_TIMEOUT_MS;
  let latest: PageState | null = null;
  const expectedMotion = plan.readyMode === "motion"
    ? new URLSearchParams(plan.query).get("play")
    : null;
  while (Date.now() < deadline) {
    try {
      latest = await evaluatePageState(client);
    } catch {
      await delay(150);
      continue;
    }
    if (latest.href === expectedUrl && latest.modelState === "error") {
      throw new Error(`Live2D model failed to load: ${latest.modelCopy || latest.status}`);
    }
    if (
      latest.href === expectedUrl &&
      expectedMotion &&
      latest.status.includes(`· ${expectedMotion} ·`) &&
      latest.status.includes("frozen@") &&
      latest.status.includes("active=false")
    ) {
      throw new Error(`The requested motion was no longer active at the freeze point: ${expectedMotion}`);
    }
    const uiTestMatch = plan.readyMode === "uitest"
      ? latest.status.match(
        /^uitest drag:\((-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\)->\((-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\) zoom:(-?\d+(?:\.\d+)?)->(-?\d+(?:\.\d+)?)$/u,
      )
      : null;
    const uiTestChanged = Boolean(uiTestMatch) && (
      Math.abs(Number(uiTestMatch?.[1]) - Number(uiTestMatch?.[3])) >= 1 ||
      Math.abs(Number(uiTestMatch?.[2]) - Number(uiTestMatch?.[4])) >= 1
    ) && Math.abs(Number(uiTestMatch?.[5]) - Number(uiTestMatch?.[6])) >= 0.001;
    const actionReady = plan.readyMode === "motion"
      ? Boolean(expectedMotion) &&
        latest.status.includes(`· ${expectedMotion} ·`) &&
        latest.status.includes("frozen@") &&
        latest.status.includes("started=true") &&
        latest.status.includes("playing=true") &&
        latest.status.includes("active=true")
      : plan.readyMode === "uitest"
        ? uiTestChanged
        : true;
    if (
      latest.href === expectedUrl &&
      latest.documentReady === "complete" &&
      latest.modelState === "ready" &&
      actionReady
    ) {
      if (!latest.attribution.trim() || !latest.attributionVisible) {
        throw new Error(`Model attribution is not visible in ${plan.name}`);
      }
      if (latest.horizontalOverflow) {
        throw new Error(`Horizontal overflow detected in ${plan.name}`);
      }
      return latest;
    }
    await delay(150);
  }
  throw new Error(
    `Timed out waiting for ${plan.name}: model=${latest?.modelState || "unknown"}; ` +
    `status=${latest?.status || "unavailable"}`,
  );
}

async function capturePlan(client: CdpClient, baseUrl: string, output: string, plan: CapturePlan): Promise<void> {
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: plan.width,
    height: plan.height,
    deviceScaleFactor: 1,
    mobile: plan.width <= 390,
  });
  const query = new URLSearchParams(plan.query);
  query.set("_promptsoul_verify", `${process.pid}-${Date.now()}-${plan.name}`);
  const url = `${baseUrl}/?${query.toString()}`;
  const navigation = await client.send<{ errorText?: string }>("Page.navigate", { url });
  if (navigation.errorText) throw new Error(`Navigation failed for ${plan.name}: ${navigation.errorText}`);
  const state = await waitForReady(client, plan, url);
  await delay(250);
  const screenshot = await client.send<{ data?: string }>("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  if (!screenshot.data) throw new Error(`Chrome returned no screenshot data for ${plan.name}`);
  const filename = join(output, `${plan.name}.png`);
  writeFileSync(filename, Buffer.from(screenshot.data, "base64"));
  console.log(`wrote ${filename} · ${state.status}`);
}

async function stopChrome(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<boolean>((resolvePromise) => {
    child.once("exit", () => resolvePromise(true));
  });
  child.kill("SIGTERM");
  if (await Promise.race([exited, delay(5_000, false, { ref: false })])) return;
  child.kill("SIGKILL");
  await Promise.race([exited, delay(2_000, undefined, { ref: false })]);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const plans = readCapturePlans(options);
  const output = resolve(options.output);
  if (existsSync(output) && lstatSync(output).isSymbolicLink()) {
    throw new Error("The browser verification output directory must not be a symbolic link");
  }
  mkdirSync(output, { recursive: true });
  const profile = mkdtempSync(join(output, "chrome-profile-"));
  let chrome: ChildProcess | null = null;
  let client: CdpClient | null = null;
  let cleanupPromise: Promise<void> | null = null;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      client?.close();
      if (chrome) await stopChrome(chrome);
      rmSync(profile, { recursive: true, force: true });
    })();
    return cleanupPromise;
  };
  const stopForSignal = (exitCode: number): void => {
    void cleanup().finally(() => process.exit(exitCode));
  };
  const handleInterrupt = (): void => stopForSignal(130);
  const handleTermination = (): void => stopForSignal(143);
  process.once("SIGINT", handleInterrupt);
  process.once("SIGTERM", handleTermination);
  try {
    const started = await startChrome(options.chrome, profile, (child) => { chrome = child; });
    chrome = started.child;
    client = await CdpClient.connect(await pageDebuggerUrl(started.debuggerUrl));
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    const baseUrl = `http://127.0.0.1:${options.port}`;
    for (const plan of plans) await capturePlan(client, baseUrl, output, plan);
  } finally {
    try {
      await cleanup();
    } finally {
      process.off("SIGINT", handleInterrupt);
      process.off("SIGTERM", handleTermination);
    }
  }
}

main().catch((error) => {
  console.error(`ERROR: ${error instanceof Error ? error.message : "browser verification failed"}`);
  process.exitCode = 1;
});
