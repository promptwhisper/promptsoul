#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { isRiffWave } from "../lib/server/aivis-cache";
import {
  createAivisSpeechClient,
  DEFAULT_AIVIS_TEST_TEXT,
} from "../lib/server/aivis-service";
import { loadCliEnvironment } from "./lib/load-cli-environment";

function writeValidatedAtomic(filename: string, audio: Uint8Array): string {
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, audio);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;

    const stored = new Uint8Array(readFileSync(temporary));
    if (!isRiffWave(stored)) {
      throw new Error("The temporary smoke-test output is not a valid non-empty RIFF/WAVE file.");
    }
    const duration = verifyDuration(temporary);
    renameSync(temporary, filename);
    return duration;
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Continue removing the unpublished temporary file.
      }
    }
    rmSync(temporary, { force: true });
    throw error;
  }
}

function verifyDuration(filename: string): string {
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filename,
  ], { encoding: "utf8" });
  if (result.error && "code" in result.error && result.error.code === "ENOENT") {
    return "not checked (ffprobe unavailable; RIFF/WAVE structure was verified)";
  }
  if (result.status !== 0) throw new Error("ffprobe could not read the generated WAV.");
  const duration = Number(result.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Generated WAV has no positive duration.");
  return `${duration.toFixed(3)} s`;
}

async function main(): Promise<void> {
  loadCliEnvironment();
  const output = resolve(process.argv[2] || "artifacts/tts-smoke.wav");
  const environment = { ...process.env, TTS_CACHE_ENABLED: "false" };
  const client = createAivisSpeechClient({ environment });
  const result = await client.synthesizeText(DEFAULT_AIVIS_TEST_TEXT);
  if (!isRiffWave(result.audio)) {
    throw new Error("AivisSpeech returned data without a valid non-empty RIFF/WAVE structure.");
  }
  const duration = writeValidatedAtomic(output, result.audio);
  console.log([
    `wrote ${output}`,
    `speaker: ${result.voice.speakerName}`,
    `style: ${result.voice.styleName}`,
    `global Style ID: ${result.voice.styleId}`,
    `duration: ${duration}`,
  ].join("\n"));
}

main().catch((error) => {
  console.error(`ERROR: ${error instanceof Error ? error.message : "TTS smoke test failed"}`);
  process.exitCode = 1;
});
