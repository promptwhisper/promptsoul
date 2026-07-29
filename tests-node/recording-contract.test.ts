import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  REQUIRED_CHROME_FLAGS,
  frameTimestampToWallTime,
  isPlaybackSettled,
  isRealPlayback,
  parseVolumeDetect,
  resolveFrameTimestampMode,
  validateFrameIntervals,
  validateProbeResult,
  type TtsDiagnostics,
} from "../scripts/record-browser";

const PLAYING: TtsDiagnostics = {
  engineReady: true,
  voiceResolved: true,
  state: "playing",
  queueLength: 1,
  audioContextState: "running",
  audioStartedAt: 100,
  audioEndedAt: null,
  currentTime: 0.25,
  duration: 2.5,
  currentRms: 0.08,
  peakRms: 0.12,
  mouthOpen: 0.4,
  peakMouthOpen: 0.7,
  lipSyncParameterIds: ["ParamMouthOpenY"],
  mouthEvidence: "parameter_readback",
  artMeshDeformationVerified: false,
  lastError: null,
};

test("recording accepts only simultaneous real audio and mouth evidence", () => {
  assert.equal(isRealPlayback(PLAYING), true);
  for (const key of ["state", "audioContextState", "currentTime", "currentRms", "mouthOpen"] as const) {
    assert.equal(isRealPlayback({ ...PLAYING, [key]: key.includes("Time") ? 0 : "idle" }), false, key);
  }
  assert.equal(isRealPlayback({ ...PLAYING, peakRms: 0 }), false);
  assert.equal(isRealPlayback({ ...PLAYING, peakMouthOpen: 0 }), false);
  assert.equal(isRealPlayback({ ...PLAYING, lipSyncParameterIds: [] }), false);
  assert.equal(isRealPlayback({ ...PLAYING, mouthEvidence: "none" }), false);
});

test("recording ends only after chat, queue, audio and mouth settle", () => {
  const settled: TtsDiagnostics = {
    ...PLAYING,
    state: "idle",
    queueLength: 0,
    audioEndedAt: 200,
    currentRms: 0,
    mouthOpen: 0,
  };
  assert.equal(isPlaybackSettled(settled, 100, false), true);
  assert.equal(isPlaybackSettled({ ...settled, queueLength: 1 }, 100, false), false);
  assert.equal(isPlaybackSettled({ ...settled, mouthOpen: 0.2 }, 100, false), false);
  assert.equal(isPlaybackSettled(settled, 100, true), false);
});

test("recording keeps required headless WebGL and background-rendering flags", () => {
  assert.ok(REQUIRED_CHROME_FLAGS.includes("--use-angle=swiftshader-webgl"));
  assert.ok(REQUIRED_CHROME_FLAGS.includes("--enable-unsafe-swiftshader"));
  assert.ok(REQUIRED_CHROME_FLAGS.includes("--disable-background-timer-throttling"));
  assert.ok(REQUIRED_CHROME_FLAGS.includes("--disable-renderer-backgrounding"));
  assert.ok(REQUIRED_CHROME_FLAGS.includes("--disable-backgrounding-occluded-windows"));
  assert.equal(REQUIRED_CHROME_FLAGS.some((flag) => flag === "--disable-gpu"), false);
  const source = readFileSync("scripts/record-browser.ts", "utf8");
  assert.doesNotMatch(source, /Web Speech|speechSynthesis/u);
  assert.match(source, /\.tts-debug-panel \.provider-close/u);
  assert.match(source, /dialog\?\.hasAttribute\("open"\)/u);
  assert.match(source, /window\.PromptSoulTTS\.play/u);
  assert.match(source, /Runtime\.consoleAPICalled/u);
  assert.doesNotMatch(source, /frame\.receivedAt/u);
  assert.match(source, /aligned\.commonStartWallTimeMs - capture\.startedAt/u);
  assert.ok(source.lastIndexOf("inspectFinalAudio(") < source.lastIndexOf("renameSync("));
  assert.ok(source.lastIndexOf("extractValidationFrames(") < source.lastIndexOf("renameSync("));
});

test("CDP frame timestamps map to the browser wall clock without using delivery time as media time", () => {
  const calibration = {
    browserWallTimeMs: 1_700_000_000_000,
    cdpMonotonicSeconds: 125.25,
  };
  const epochTimestamp = 1_700_000_000.5;
  assert.equal(resolveFrameTimestampMode(epochTimestamp, 1_700_000_000_515, calibration), "epoch");
  assert.equal(frameTimestampToWallTime(epochTimestamp, calibration, "epoch"), 1_700_000_000_500);

  const monotonicTimestamp = 125.75;
  assert.equal(resolveFrameTimestampMode(monotonicTimestamp, 1_700_000_000_515, calibration), "cdp-monotonic");
  assert.equal(
    frameTimestampToWallTime(monotonicTimestamp, calibration, "cdp-monotonic"),
    1_700_000_000_500,
  );
});

test("recording rejects discontinuous frames instead of compressing their time", () => {
  assert.ok(validateFrameIntervals(Array.from({ length: 15 }, (_, index) => index / 30)) > 0);
  const timestamps = Array.from({ length: 15 }, (_, index) => index / 30);
  timestamps[8] = timestamps[7] + 0.251;
  for (let index = 9; index < timestamps.length; index += 1) timestamps[index] = timestamps[index - 1] + (1 / 30);
  assert.throws(() => validateFrameIntervals(timestamps), /stopped producing continuous frames/u);
});

test("ffprobe validation requires positive video and audio streams", () => {
  assert.deepEqual(validateProbeResult({
    format: { duration: "3.25" },
    streams: [
      { codec_type: "video", codec_name: "h264", duration: "3.25" },
      { codec_type: "audio", codec_name: "aac", duration: "2.80" },
    ],
  }), {
    duration: 3.25,
    videoDuration: 3.25,
    videoCodec: "h264",
    audioCodec: "aac",
    audioDuration: 2.8,
    avDurationDelta: 0.4500000000000002,
  });
  assert.throws(() => validateProbeResult({
    format: { duration: "3.25" },
    streams: [{ codec_type: "video", codec_name: "h264" }],
  }), /no audio stream/u);
  assert.throws(() => validateProbeResult({
    format: { duration: "4.0" },
    streams: [
      { codec_type: "video", codec_name: "h264", duration: "4.0" },
      { codec_type: "audio", codec_name: "aac", duration: "3.0" },
    ],
  }), /duration drift/u);
});

test("final muxed audio must contain measurable non-silent energy", () => {
  assert.deepEqual(parseVolumeDetect(`
    [Parsed_volumedetect_0] mean_volume: -24.3 dB
    [Parsed_volumedetect_0] max_volume: -2.1 dB
  `), { meanVolumeDb: -24.3, maxVolumeDb: -2.1 });
  assert.throws(() => parseVolumeDetect(`
    [Parsed_volumedetect_0] mean_volume: -inf dB
    [Parsed_volumedetect_0] max_volume: -inf dB
  `), /digital silence/u);
  assert.throws(() => parseVolumeDetect(`
    [Parsed_volumedetect_0] mean_volume: -80.0 dB
    [Parsed_volumedetect_0] max_volume: -70.0 dB
  `), /effectively silent/u);
});
