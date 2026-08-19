import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(path.join(process.cwd(), "assets", "app.js"), "utf8");

test("browser runtime applies realtime cues before the final mouth override", () => {
  assert.match(source, /import \{\s*ActionCueScheduler\s*\}/u);
  const binding = source.match(
    /function installLive2DFrameEffects[\s\S]*?\n  \}\n\n  function uninstallLive2DFrameEffects/u,
  )?.[0] ?? "";
  assert.match(binding, /beforeModelUpdate/u);
  assert.ok(binding.indexOf("actionCueScheduler.applyFrame") >= 0);
  assert.ok(binding.indexOf("setMouthOpen") > binding.indexOf("actionCueScheduler.applyFrame"));
  assert.match(source, /modelEpoch\s*\+=\s*1/u);
  assert.match(source, /onCueApplied:\s*\(event\)\s*=>/u);
  assert.match(source, /event\.appliedAt - event\.scheduledAt/u);
  assert.match(source, /partOpacityWrites:\s*state\.realtimeDiagnostics\.partOpacityWrites/u);
  assert.match(source, /dataset\.realtimePartOpacityIds/u);
  assert.match(source, /const opacity = value > 0\.5 \? 1 : 0/u);
  assert.match(source, /trusted_reference:\(\[A-Za-z0-9@_-\]/u);
  assert.match(source, /playMotion\(\s*trustedGroup,\s*trustedIndex/u);
});

test("the default Live2D layout keeps the full character inside the compact stage", () => {
  const layout = source.match(
    /function installModelControls[\s\S]*?state\.layoutModel = layout/u,
  )?.[0] ?? "";
  assert.match(layout, /\) \* 0\.72/u);
  assert.match(layout, /model\.position\.set\(app\.screen\.width \/ 2, app\.screen\.height \* 0\.32\)/u);
});

test("browser consumes both realtime segment and legacy delta chat streams", () => {
  assert.match(source, /event\?\.type === "start"/u);
  assert.match(source, /event\?\.type === "segment"/u);
  assert.match(source, /event\?\.type === "delta"/u);
  assert.match(source, /callbacks\.onSegment\?\.\(event, accumulated\)/u);
  assert.match(source, /tts\.enqueue\(segment\.text, \{\}, tag\)/u);
  assert.match(
    source,
    /bindAudio\(\s*tag\.segmentSeq,\s*event\.startAt,\s*event\.duration,\s*tag\.turnId,?\s*\)/u,
  );
  assert.match(source, /performance\.now\(\) \/ 1_000/u);
  assert.match(source, /REALTIME_FALLBACK_SEGMENT_SECONDS = 3/u);
});

test("stream timeout is idle-based and renewed only by complete stream events", () => {
  const request = source.match(
    /async function requestChatReply[\s\S]*?\n  \}\n\n  function updateTtsDiagnostics/u,
  )?.[0] ?? "";
  assert.match(request, /const resetIdleTimeout = \(\) =>/u);
  assert.match(request, /onActivity: resetIdleTimeout/u);
  assert.doesNotMatch(request, /const timer = window\.setTimeout/u);
  assert.equal(source.match(/callbacks\.onActivity\?\.\(\)/gu)?.length, 5);
});

test("fallback emotions start with tagged audio or the matching performance slot", () => {
  const segmentHandler = source.match(
    /onSegment: \(segment, accumulated\) => \{[\s\S]*?\n          \},\n          onDone:/u,
  )?.[0] ?? "";
  const audioStarted = source.match(
    /function handleRealtimeSegmentStarted[\s\S]*?\n  \}\n\n  function handleRealtimeSegmentEnded/u,
  )?.[0] ?? "";
  const performanceFallback = source.match(
    /function schedulePerformanceFallback[\s\S]*?\n  \}\n\n  function handleRealtimeSegmentScheduled/u,
  )?.[0] ?? "";
  assert.doesNotMatch(segmentHandler, /playEmotion\(/u);
  assert.match(audioStarted, /playRealtimeSegmentFallback\(run, tag\.segmentSeq\)/u);
  assert.match(performanceFallback, /startAt - \(performance\.now\(\) \/ 1_000\)/u);
});

test("TTS failure switches unresolved cues to fixed performance slots", () => {
  const fallback = source.match(
    /function switchRealtimeRunToPerformance[\s\S]*?\n  \}\n\n  function preserveCurrentPerformanceSegment/u,
  )?.[0] ?? "";
  assert.match(fallback, /beginTurn\(run\.turnId, run\.modelEpoch, "performance"\)/u);
  assert.match(fallback, /filter\(\(segment\) => !run\.startedSegments\.has\(segment\.seq\)\)/u);
  assert.match(fallback, /bindRealtimeSegmentWithoutTts\(run, segment\)/u);
  assert.match(fallback, /cancelPending\(\)/u);
  const deferredSwitch = source.match(
    /function requestRealtimePerformanceSwitch[\s\S]*?\n  \}\n\n  function preserveCurrentPerformanceSegment/u,
  )?.[0] ?? "";
  assert.match(deferredSwitch, /if \(run\.audioPending\.size\) return/u);
  assert.match(deferredSwitch, /performanceSwitchPending = true/u);
  assert.match(source, /handleRealtimeSegmentEnded[\s\S]*?performanceSwitchPending/u);
  const realtimeStart = source.match(
    /onStart: \(event\) => \{[\s\S]*?actionCueScheduler\.beginTurn/u,
  )?.[0] ?? "";
  assert.match(realtimeStart, /!state\.ttsEnabled/u);
  assert.match(realtimeStart, /run\.clockMode = "performance"/u);
});

test("partial performance failures retain only the active fixed-duration slot", () => {
  const preserve = source.match(
    /function preserveCurrentPerformanceSegment[\s\S]*?\n  \}\n\n  function setTtsMouthOpen/u,
  )?.[0] ?? "";
  assert.match(preserve, /anchor\.startAt <= now && now < anchor\.startAt \+ anchor\.duration/u);
  assert.match(preserve, /if \(seq !== currentSeq\) run\.performanceAnchors\.delete\(seq\)/u);
  assert.match(preserve, /beginTurn\(run\.turnId, run\.modelEpoch, "performance"\)/u);
  assert.match(preserve, /bindAudio\([\s\S]*?anchor\.startAt,[\s\S]*?anchor\.duration/u);
  assert.match(preserve, /performanceCancelTimer = window\.setTimeout/u);
  assert.match(preserve, /cancelTurn\(run\.turnId, 200\)/u);
});

test("new chat turns interrupt old work without locking the composer", () => {
  const busy = source.match(/function setChatBusy[\s\S]*?\n  \}/u)?.[0] ?? "";
  const send = source.match(
    /async function sendChatMessage[\s\S]*?\n  \}\n\n  function initChat/u,
  )?.[0] ?? "";
  assert.doesNotMatch(send, /state\.chatBusy\) return/u);
  assert.doesNotMatch(busy, /chatInput\.disabled\s*=|sendButton\.disabled\s*=/u);
  assert.match(send, /interruptActiveChat/u);
  assert.match(source, /chatController\?\.abort/u);
  assert.match(source, /cancelTurn\([^,]+, 200\)/u);
  assert.match(source, /function interruptActiveChat[\s\S]*?stopActiveLive2DMotion\(\)/u);
  assert.match(source, /motionManager\?\.stopAllMotions\?\.\(\)/u);
  assert.match(source, /const clockMode = state\.realtimeClockMode/u);
  assert.match(
    source,
    /interruptActiveChat\(\);[\s\S]*?actionCueScheduler\.dispose\(\);[\s\S]*?modelEpoch \+= 1/u,
  );
});

test("TTS status loss preserves realtime actions on the performance clock", () => {
  const unavailable = source.match(
    /function handleTtsUnavailable[\s\S]*?\n  \}\n\n  async function refreshTtsStatus/u,
  )?.[0] ?? "";
  const refresh = source.match(
    /async function refreshTtsStatus[\s\S]*?\n  \}\n\n  function speakCompletedReply/u,
  )?.[0] ?? "";
  assert.match(unavailable, /run\.realtime/u);
  assert.match(unavailable, /run\.clockMode === "audio"/u);
  assert.match(unavailable, /requestRealtimePerformanceSwitch\(run\)/u);
  assert.doesNotMatch(unavailable, /cancelActiveRealtimeCues/u);
  assert.equal(refresh.match(/handleTtsUnavailable\(\)/gu)?.length, 2);
  assert.doesNotMatch(refresh, /cancelActiveRealtimeCues/u);
});

test("TTS unavailability keeps performance cues and switches audio before stopping", () => {
  const handler = source.match(
    /function handleTtsUnavailable[\s\S]*?\n  \}/u,
  )?.[0];
  assert.ok(handler);

  const execute = (
    runtimeState: Record<string, any>,
    switchToPerformance: (run: Record<string, any>) => void,
  ) => runInNewContext(`${handler}\nhandleTtsUnavailable();`, {
    state: runtimeState,
    isCurrentChatRun: (run: Record<string, any>) => (
      run === runtimeState.activeChatRun && !run.cancelled
    ),
    requestRealtimePerformanceSwitch: switchToPerformance,
  });

  const performanceEvents: string[] = [];
  const performanceAnchors = new Map([[0, { startAt: 1, duration: 2 }]]);
  const performanceRun = {
    realtime: true,
    cancelled: false,
    cuesCancelled: false,
    clockMode: "performance",
    performanceAnchors,
  };
  const performanceState = {
    activeChatRun: performanceRun,
    ttsPlaybackRevision: 3,
    ttsManager: { stop: () => performanceEvents.push("stop") },
  };
  execute(performanceState, () => performanceEvents.push("switch"));

  assert.equal(performanceState.ttsPlaybackRevision, 4);
  assert.deepEqual(performanceEvents, ["stop"]);
  assert.equal(performanceRun.cuesCancelled, false);
  assert.equal(performanceRun.performanceAnchors, performanceAnchors);

  const audioEvents: string[] = [];
  const audioRun = {
    realtime: true,
    cancelled: false,
    cuesCancelled: false,
    clockMode: "audio",
  };
  const audioState = {
    activeChatRun: audioRun,
    ttsPlaybackRevision: 8,
    ttsManager: { stop: () => audioEvents.push("stop") },
  };
  execute(audioState, (run) => {
    audioEvents.push("switch");
    run.clockMode = "performance";
  });

  assert.equal(audioState.ttsPlaybackRevision, 9);
  assert.deepEqual(audioEvents, ["switch", "stop"]);
  assert.equal(audioRun.clockMode, "performance");
  assert.equal(audioRun.cuesCancelled, false);
});

test("partial realtime errors preserve current playback and publish diagnostics", () => {
  assert.match(source, /event\?\.partial === true/u);
  assert.match(source, /tts\.cancelPending\(\)/u);
  assert.match(source, /ttfcMs/u);
  assert.match(source, /invalidCues/u);
  assert.match(source, /bufferUnderruns/u);
  assert.match(source, /syncDriftMs/u);
  assert.match(source, /cueSegmentsAccepted/u);
  assert.match(source, /cueSegmentsBound/u);
  assert.match(source, /bindFailures/u);
  assert.match(source, /cueApplications/u);
  assert.match(source, /frameWrites/u);
  assert.match(source, /parameterWrites/u);
  assert.match(source, /lastCueParameterIds/u);
  assert.match(source, /dataset\.realtimeFrameWrites/u);
  assert.match(source, /promptsoul:realtime-state/u);
  assert.match(source, /segment\.cues\.length === 0[\s\S]*?\|\| !cuesAccepted/u);
  assert.match(source, /run\.clockMode = "performance"/u);
  assert.doesNotMatch(source, /\.motion3\.json/u);
});

test("runtime bind failures become tagged fallback motions instead of silent cues", () => {
  const audioBinding = source.match(
    /function handleRealtimeSegmentScheduled[\s\S]*?\n  \}\n\n  function handleRealtimeSegmentStarted/u,
  )?.[0] ?? "";
  const performanceBinding = source.match(
    /function bindRealtimeSegmentWithoutTts[\s\S]*?\n  \}\n\n  function switchRealtimeRunToPerformance/u,
  )?.[0] ?? "";
  assert.match(audioBinding, /if \(!bound\) markRealtimeSegmentFallback\(run, tag\.segmentSeq, true\)/u);
  assert.match(performanceBinding, /else if \(shouldBind\)[\s\S]*?markRealtimeSegmentFallback\(run, segment\.seq, true\)/u);
  assert.match(source, /onFrameApplied:\s*\(event\)\s*=>/u);
});

test("runtime no-op segments fall back only after their bound playback window ends", () => {
  const schedulerSetup = source.match(
    /function createActionCueScheduler[\s\S]*?return new ActionCueScheduler\([\s\S]*?\n  \}/u,
  )?.[0] ?? "";
  const endedHandler = source.match(
    /function handleRealtimeCueSegmentEnded[\s\S]*?\n  \}\n\n  function publishRealtimeDiagnostics/u,
  )?.[0] ?? "";
  assert.match(schedulerSetup, /onSegmentEnded:\s*handleRealtimeCueSegmentEnded/u);
  assert.match(endedHandler, /run\.boundCueSegments\.has\(event\.segmentSeq\)/u);
  assert.match(endedHandler, /event\.writeCount\s*!==\s*0/u);
  assert.match(endedHandler, /markRealtimeSegmentFallback\(run, event\.segmentSeq\)/u);
  assert.match(endedHandler, /playRealtimeSegmentFallback\(run, event\.segmentSeq\)/u);
  assert.match(endedHandler, /noopSegments/u);
  assert.match(source, /dataset\.realtimeNoop/u);
});

test("a realtime transport failure before the first segment restores demo playback", () => {
  const send = source.match(
    /async function sendChatMessage[\s\S]*?\n  \}\n\n  function initChat/u,
  )?.[0] ?? "";
  const errorHandler = send.match(
    /onError: \(\) => \{[\s\S]*?\n          \},\n        \}, controller\)/u,
  )?.[0] ?? "";
  assert.match(errorHandler, /run\.realtime && run\.resolvedSegments\.size === 0/u);
  assert.match(errorHandler, /actionCueScheduler\.cancelTurn\(run\.turnId, 200\)/u);
  assert.match(errorHandler, /run\.realtime = false/u);
  assert.match(errorHandler, /run\.turnId = null/u);

  const completion = send.match(
    /const reply = run\.partial[\s\S]*?run\.completed = true/u,
  )?.[0] ?? "";
  assert.match(completion, /addMessage\("assistant", reply, emotion\)/u);
  assert.match(completion, /if \(!run\.realtime\) speakCompletedReply\(reply, chatTtsRevision\)/u);
  assert.match(completion, /if \(!run\.realtime\) playReplyEmotionWithSpeech\(emotion\)/u);
});
