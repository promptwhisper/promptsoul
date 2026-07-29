#!/usr/bin/env node

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { getAivisTtsStatus, loadAivisTtsConfig, resetAivisServiceForTests } from "../lib/server/aivis-service";
import { loadCliEnvironment } from "./lib/load-cli-environment";

const AUTOSTART_WAIT_MS = 45_000;

async function tryAutostart(
  config: ReturnType<typeof loadAivisTtsConfig>,
): Promise<void> {
  if (!config.autostart) return;
  if (process.platform !== "darwin") {
    throw new Error("AIVIS_AUTOSTART is only supported on macOS; start AivisSpeech manually.");
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("open", ["-a", "AivisSpeech"], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`Could not open AivisSpeech (exit ${code ?? "unknown"}).`)));
  });
  const deadline = Date.now() + AUTOSTART_WAIT_MS;
  while (Date.now() < deadline) {
    resetAivisServiceForTests();
    if ((await getAivisTtsStatus()).engineReachable) return;
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(1_000, remaining));
  }
  throw new Error(
    `AivisSpeech was opened but the configured Engine at ${config.baseUrl} did not become ready within 45 seconds.`,
  );
}

async function main(): Promise<void> {
  loadCliEnvironment();
  const config = loadAivisTtsConfig();
  await tryAutostart(config);
  const status = await getAivisTtsStatus();
  if (!status.ready) {
    const reason = status.error ? `${status.error.code}: ${status.error.message}` : "unknown error";
    const candidates = status.error?.availableVoices?.flatMap((voice) => (
      voice.styles.map((style) => `- ${voice.speakerName} (${voice.speakerUuid}) / ${style.name}: ${style.id}`)
    )) ?? [];
    throw new Error([
      `AivisSpeech TTS is not ready (${reason}).`,
      ...(candidates.length ? ["Installed voice/style candidates:", ...candidates] : []),
      "Start AivisSpeech, install コハク, confirm the あまあま style, then run npm run tts:check again.",
      `Swagger is available at ${config.baseUrl}/docs while the Engine is running.`,
    ].join("\n"));
  }
  console.log([
    "AivisSpeech TTS ready",
    `speaker: ${status.speakerName}`,
    `style: ${status.styleName}`,
    `global Style ID: ${status.styleId}`,
    `latency: ${status.latencyMs} ms`,
  ].join("\n"));
}

main().catch((error) => {
  console.error(`ERROR: ${error instanceof Error ? error.message : "TTS check failed"}`);
  process.exitCode = 1;
});
