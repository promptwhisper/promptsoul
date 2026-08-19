import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import {
  DshRealtimeBackend,
  loadReferenceActions,
  realtimeHeadShakeCycles,
  realtimeCueSalienceTarget,
  requiresVisuallySalientRealtimeCues,
  type DshTurnRunner,
} from "../lib/server/dsh-realtime";
import type { ModelProfile } from "../lib/server/motion-authoring";

function profile(): ModelProfile {
  return {
    root: "/tmp/promptsoul-test",
    runtime: "/tmp/promptsoul-test/model",
    model3Path: "/tmp/promptsoul-test/model/test.model3.json",
    modelStem: "test",
    controls: [{
      token: "c01",
      parameterId: "ParamAngleX",
      displayName: "Head X",
      minimum: -30,
      maximum: 30,
      base: 0,
    }],
    availableIds: new Set(["ParamAngleX"]),
    physicsOutputs: new Set(),
    partOpacityIds: new Set(),
    safeRanges: new Map([["ParamAngleX", [-30, 30] as const]]),
    basePose: new Map([["ParamAngleX", 0]]),
    referenceMotionCount: 1,
    revision: "0123456789abcdef",
  };
}

function request() {
  return {
    message: "打个招呼",
    history: [],
    persona: { name: "Hiyori", systemPrompt: "Reply warmly." },
  } as const;
}

function emitSegment(options: Parameters<DshTurnRunner["run"]>[1], text = "你好") {
  options.onTextDelta(`${JSON.stringify({
    type: "segment",
    seq: 0,
    text,
    fallback: "happy",
    cues: [],
  })}\n`);
}

describe("DSH realtime conversation backend", () => {
  test("loads complete motion3 references and prioritizes hiyori_m08", () => {
    const root = mkdtempSync(path.join(tmpdir(), "promptsoul-dsh-reference-"));
    const runtime = path.join(root, "models", "avatar");
    const motionDir = path.join(runtime, "motion");
    mkdirSync(motionDir, { recursive: true });
    const exactMotion = {
      Version: 3,
      Meta: { Duration: 2.1, CurveCount: 3 },
      Curves: [
        { Target: "Parameter", Id: "ParamArmLA", Segments: [0, 0, 1, 0.2, 0.4, 0.4, 0.8, 0.6, 1] },
        { Target: "PartOpacity", Id: "PartArmA", Segments: [0, 0, 0, 2.1, 0] },
        { Target: "PartOpacity", Id: "PartArmB", Segments: [0, 0.99, 0, 2.1, 0.99] },
      ],
    };
    writeFileSync(path.join(motionDir, "hiyori_m08.motion3.json"), JSON.stringify(exactMotion));
    writeFileSync(path.join(motionDir, "other.motion3.json"), JSON.stringify({ Version: 3, Curves: [] }));
    const model3Path = path.join(runtime, "avatar.model3.json");
    writeFileSync(model3Path, JSON.stringify({
      Version: 3,
      FileReferences: { Motions: {
        Idle: [{ File: "motion/other.motion3.json" }],
        Tap: [{ File: "motion/hiyori_m08.motion3.json" }],
      } },
    }));
    try {
      const references = loadReferenceActions({
        ...profile(), root, runtime, model3Path,
      }, "给我跳个舞");
      assert.equal(references[0]?.file, "motion/hiyori_m08.motion3.json");
      assert.deepEqual(references[0]?.motion3, exactMotion);
      assert.equal((references[0]?.motion3 as any).Curves.length, 3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("detects explicit gross movement commands without treating discussion or negation as commands", () => {
    for (const message of [
      "给我跳个舞",
      "请做一个明显的大幅摇头动作",
      "大幅左右摇头三次",
      "明显大幅摇头三次",
      "跳舞",
      "挥手一下",
      "开心地大幅挥挥手",
      "和我打个招呼",
      "生成一个大幅开心挥手动作",
      "Could you dance for me?",
      "手を振ってください",
    ]) {
      assert.equal(requiresVisuallySalientRealtimeCues(message), true, message);
    }
    assert.equal(realtimeCueSalienceTarget("摇头一下"), 0.65);
    assert.equal(realtimeCueSalienceTarget("请明显地大幅摇头"), 0.85);
    assert.equal(realtimeCueSalienceTarget("轻轻点头一下"), 0.4);
    assert.equal(realtimeCueSalienceTarget("聊聊舞蹈历史"), undefined);
    assert.equal(realtimeHeadShakeCycles("大幅摇头三次"), 3);
    assert.equal(realtimeHeadShakeCycles("请摇头两次"), 2);
    assert.equal(realtimeHeadShakeCycles("摇头一下"), 2);
    assert.equal(realtimeHeadShakeCycles("点头三次"), undefined);
    for (const message of [
      "你会哪些动作？",
      "为什么角色会摇头？",
      "不要摇头",
      "Please don't dance.",
      "Let's talk about dance history.",
    ]) {
      assert.equal(requiresVisuallySalientRealtimeCues(message), false, message);
    }
  });

  test("feeds failed visible-motion constraints back to DSH and emits only its valid retry", async () => {
    const inputs: any[] = [];
    const runner: DshTurnRunner = {
      async run(input, options) {
        const parsed = JSON.parse(input);
        inputs.push(parsed);
        const retrying = parsed.required_motion?.retry_reason !== null;
        options.onTextDelta(`${JSON.stringify({
          type: "segment",
          seq: 0,
          text: "好，你看。",
          fallback: "happy",
          cues: [{
            id: retrying ? "dsh_retry" : "weak",
            at: 0,
            span: 1,
            curves: retrying ? [
              {
                control: "c01",
                keys: [[0, 0], [0.14, -0.85], [0.28, 0.85], [0.42, -0.85], [0.56, 0.85], [0.7, -0.85], [0.84, 0.85], [1, 0]],
              },
              { control: "c02", keys: [[0, 0], [0.5, 0.65], [1, 0]] },
            ] : [{ control: "c01", keys: [[0, 0], [0.5, 0.19], [1, 0]] }],
          }],
        })}\n`);
        return { reason: "completed" };
      },
      async close() {},
    };
    const backend = new DshRealtimeBackend({
      createRunner: () => runner,
      loadProfile: () => ({
        ...profile(),
        controls: [
          ...profile().controls,
          {
            token: "c02",
            parameterId: "ParamAngleZ",
            displayName: "Head Z",
            minimum: -30,
            maximum: 30,
            base: 0,
          },
        ],
        availableIds: new Set(["ParamAngleX", "ParamAngleZ"]),
      }),
    });
    const movementSegments: Array<{ cuesRejected: boolean; cues: unknown[] }> = [];
    await backend.stream(
      { ...request(), message: "请大幅摇头三次" },
      (segment) => movementSegments.push(segment),
      new AbortController().signal,
    );
    assert.equal(inputs.length, 2);
    assert.deepEqual(inputs[0].required_motion, {
      minimum_primary_peak: 0.85,
      first_cue_at_most: 0.15,
      minimum_cue_span: 0.75,
      head_shake_cycles: 3,
      required_yaw_extrema: 6,
      maximum_curve_keys: 64,
      minimum_roll_peak: 0.6,
      retry_reason: null,
    });
    assert.equal(inputs[1].required_motion.retry_reason, "previous_cues_failed_visible_motion_validation");
    assert.equal(movementSegments.length, 1);
    assert.equal(movementSegments[0]?.cuesRejected, false);
    assert.equal((movementSegments[0]?.cues[0] as any)?.id, "dsh_retry");

    const ordinarySegments: Array<{ cuesRejected: boolean; cues: unknown[] }> = [];
    await backend.stream(
      request(),
      (segment) => ordinarySegments.push(segment),
      new AbortController().signal,
    );
    assert.equal(inputs[2].required_motion, null);
    assert.equal(ordinarySegments[0]?.cuesRejected, false);
    assert.equal(ordinarySegments[0]?.cues.length, 1);
  });

  test("a natural wave request selects the complete reference without technical prompt syntax", async () => {
    const inputs: any[] = [];
    const runner: DshTurnRunner = {
      async run(input, options) {
        const parsed = JSON.parse(input);
        inputs.push(parsed);
        options.onTextDelta(`${JSON.stringify({
          type: "segment",
          seq: 0,
          text: "看我的完整动作。",
          fallback: "happy",
          cues: [{
            id: "complete",
            at: 0,
            span: 1,
            curves: [
              { control: "c01", keys: [[0, 0], [0.5, 0.9], [1, 0]] },
              { control: "c02", keys: [[0, 0], [0.5, 0.6], [1, 0]] },
            ],
          }],
        })}\n`);
        return { reason: "completed" };
      },
      async close() {},
    };
    const namedProfile: ModelProfile = {
      ...profile(),
      controls: [
        ...profile().controls,
        {
          token: "c02", parameterId: "ParamAngleY", displayName: "Head Y",
          minimum: -30, maximum: 30, base: 0,
        },
      ],
      availableIds: new Set(["ParamAngleX", "ParamAngleY"]),
    };
    const backend = new DshRealtimeBackend({
      createRunner: () => runner,
      loadProfile: () => namedProfile,
      loadReferenceActions: () => [{
        group: "Tap", index: 1, file: "motion/hiyori_m08.motion3.json",
        motion3: { Meta: { Duration: 1 }, Curves: [
          { Target: "Parameter", Id: "ParamAngleX", Segments: [0, 0, 0, 1, 1] },
          { Target: "Parameter", Id: "ParamAngleY", Segments: [0, 0, 0, 1, 1] },
        ] },
      }],
    });
    const segments: any[] = [];
    await backend.stream(
      { ...request(), message: "开心地大幅挥挥手" },
      (segment) => segments.push(segment),
      new AbortController().signal,
    );
    assert.equal(inputs.length, 1);
    assert.deepEqual(inputs[0].required_reference.curve_ids, ["ParamAngleX", "ParamAngleY"]);
    assert.equal(inputs[0].required_motion.retry_reason, null);
    assert.equal(segments[0].cues[0].id, "trusted_reference:Tap:1");
    assert.deepEqual(segments[0].cues[0].curves.map((curve: any) => curve.parameterId), [
      "ParamAngleX", "ParamAngleY",
    ]);
  });

  test("a named reference falls back to the trusted complete motion after one invalid DSH attempt", async () => {
    let attempts = 0;
    const runner: DshTurnRunner = {
      async run(_input, options) {
        attempts += 1;
        options.onTextDelta(`${JSON.stringify({
          type: "segment", seq: 0, text: "看我的动作。", fallback: "happy",
          cues: [{
            id: "trimmed", at: 0, span: 1,
            curves: [{ control: "c01", keys: [[0, 0], [0.5, 0.9], [1, 0]] }],
          }],
        })}\n`);
        return { reason: "completed" };
      },
      async close() {},
    };
    const namedProfile: ModelProfile = {
      ...profile(),
      controls: [
        ...profile().controls,
        {
          token: "c02", parameterId: "ParamAngleY", displayName: "Head Y",
          minimum: -30, maximum: 30, base: 0,
        },
      ],
      availableIds: new Set(["ParamAngleX", "ParamAngleY"]),
    };
    const backend = new DshRealtimeBackend({
      createRunner: () => runner,
      loadProfile: () => namedProfile,
      loadReferenceActions: () => [{
        group: "Tap", index: 1, file: "motion/hiyori_m08.motion3.json",
        motion3: {
          Meta: { Duration: 1 },
          Curves: [
            { Target: "Parameter", Id: "ParamAngleX", Segments: [0, 0, 0, 1, 1] },
            { Target: "Parameter", Id: "ParamAngleY", Segments: [0, 0, 0, 1, 1] },
          ],
        },
      }],
    });
    const segments: any[] = [];
    await backend.stream(
      { ...request(), message: "参考 hiyori_m08 生成一个大幅挥手动作" },
      (segment) => segments.push(segment),
      new AbortController().signal,
    );
    assert.equal(attempts, 1);
    assert.equal(segments[0].cuesRejected, false);
    assert.equal(segments[0].cues[0].id, "trusted_reference:Tap:1");
    assert.deepEqual(segments[0].cues[0].curves.map((curve: any) => curve.parameterId), [
      "ParamAngleX", "ParamAngleY",
    ]);
  });

  test("emits compiled speech-action segments before the DSH turn completes", async () => {
    let completed = false;
    const runner: DshTurnRunner = {
      async run(_input, options) {
        options.onTextDelta('{"type":"segment","seq":0,"text":"你好，","fallback":"happy","cues":[');
        options.onTextDelta('{"id":"hello","at":0,"span":1,"curves":[{"control":"c01","keys":[[0,0],[0.5,0.5],[1,0]]}]}]}\n');
        assert.equal(completed, false);
        completed = true;
        return { reason: "completed" };
      },
      async close() {},
    };
    const backend = new DshRealtimeBackend({
      createRunner: () => runner,
      loadProfile: profile,
      lipSyncParameterIds: () => [],
    });
    const segments: Array<{ text: string; cues: unknown[] }> = [];

    const result = await backend.stream(
      request(),
      (segment) => segments.push(segment),
      new AbortController().signal,
    );

    assert.equal(completed, true);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].text, "你好，");
    assert.equal(segments[0].cues.length, 1);
    assert.deepEqual(result, {
      reply: "你好，",
      emotion: "happy",
      mode: "dsh-realtime",
      modelRevision: "0123456789abcdef",
      segmentCount: 1,
    });
  });

  test("reuses one runtime and exposes raw non-lip-sync control metadata", async () => {
    let created = 0;
    let closed = 0;
    let resets = 0;
    const inputs: string[] = [];
    const runner: DshTurnRunner = {
      async run(input, options) {
        inputs.push(input);
        emitSegment(options);
        return { reason: "completed" };
      },
      async close() { closed += 1; },
    };
    const withMouth = (): ModelProfile => ({
      ...profile(),
      controls: [
        ...profile().controls,
        {
          token: "c02",
          parameterId: "ParamMouthOpenY",
          displayName: "Mouth open",
          minimum: 0,
          maximum: 1,
          base: 0,
        },
      ],
    });
    const backend = new DshRealtimeBackend({
      createRunner: () => { created += 1; return runner; },
      loadProfile: withMouth,
      lipSyncParameterIds: () => ["ParamMouthOpenY"],
      loadReferenceActions: () => [{
        group: "Tap", index: 0, file: "motion/reference.motion3.json",
        motion3: { Version: 3, Curves: [{ Target: "Parameter", Id: "ParamAngleX", Segments: [0, 0, 0, 1, 20] }] },
      }],
      onRunnerReset: () => { resets += 1; },
    });

    await backend.stream(request(), () => {}, new AbortController().signal);
    await backend.stream(request(), () => {}, new AbortController().signal);

    assert.equal(created, 1);
    assert.equal(closed, 0);
    assert.equal(resets, 0);
    assert.deepEqual(
      inputs.map((input) => JSON.parse(input).control_catalog),
      [
        [{ target: "Parameter", id: "ParamAngleX", control: "c01", name: "Head turn left/right (yaw; primary silhouette)", minimum: -30, maximum: 30, base: 0 }],
        [{ target: "Parameter", id: "ParamAngleX", control: "c01", name: "Head turn left/right (yaw; primary silhouette)", minimum: -30, maximum: 30, base: 0 }],
      ],
    );
    assert.equal(JSON.parse(inputs[0]).reference_actions[0].motion3.Curves[0].Id, "ParamAngleX");
    assert.doesNotMatch(inputs[0], /ParamMouthOpenY/u);
  });

  test("describes standard Cubism axes semantically alongside their raw ids", async () => {
    const inputs: string[] = [];
    const semanticProfile = (): ModelProfile => ({
      ...profile(),
      controls: [
        ...profile().controls,
        {
          token: "c02",
          parameterId: "ParamAngleY",
          displayName: "Angle Y",
          minimum: -30,
          maximum: 30,
          base: 0,
        },
        {
          token: "c03",
          parameterId: "ParamAngleZ",
          displayName: "Angle Z",
          minimum: -30,
          maximum: 30,
          base: 0,
        },
        {
          token: "c04",
          parameterId: "ParamHairAhoge",
          displayName: "Hair Move Ahoge",
          minimum: -10,
          maximum: 10,
          base: 0,
        },
      ],
    });
    const runner: DshTurnRunner = {
      async run(input, options) {
        inputs.push(input);
        emitSegment(options);
        return { reason: "completed" };
      },
      async close() {},
    };
    const backend = new DshRealtimeBackend({
      createRunner: () => runner,
      loadProfile: semanticProfile,
    });

    await backend.stream(request(), () => {}, new AbortController().signal);

    const catalog = JSON.parse(inputs[0]).control_catalog;
    assert.deepEqual(catalog, [
      { target: "Parameter", id: "ParamAngleX", control: "c01", name: "Head turn left/right (yaw; primary silhouette)", minimum: -30, maximum: 30, base: 0 },
      { target: "Parameter", id: "ParamAngleY", control: "c02", name: "Head look up/down (pitch; primary silhouette)", minimum: -30, maximum: 30, base: 0 },
      { target: "Parameter", id: "ParamAngleZ", control: "c03", name: "Head tilt left/right (roll; primary silhouette)", minimum: -30, maximum: 30, base: 0 },
      { target: "Parameter", id: "ParamHairAhoge", control: "c04", name: "Hair strand sway (secondary detail; not a primary gesture)", minimum: -10, maximum: 10, base: 0 },
    ]);
    assert.match(JSON.stringify(catalog), /ParamAngleX|ParamHairAhoge/u);
  });

  test("includes raw PartOpacity ids and a coordinated existing-action example", async () => {
    const inputs: string[] = [];
    const runner: DshTurnRunner = {
      async run(input, options) {
        inputs.push(input);
        emitSegment(options);
        return { reason: "completed" };
      },
      async close() {},
    };
    const backend = new DshRealtimeBackend({
      createRunner: () => runner,
      loadReferenceActions: () => [{
        group: "Tap", index: 1, file: "motion/hiyori_m08.motion3.json",
        motion3: { Version: 3, Curves: [
          { Target: "Parameter", Id: "ParamArmLA", Segments: [0, 0, 0, 1, 1] },
          { Target: "PartOpacity", Id: "PartArmA", Segments: [0, 0, 0, 1, 1] },
          { Target: "PartOpacity", Id: "PartArmB", Segments: [0, 1, 0, 1, 0] },
        ] },
      }],
      loadProfile: () => ({
        ...profile(),
        controls: [
          ...profile().controls,
          { token: "c02", parameterId: "ParamBodyAngleZ", displayName: "Body Z", minimum: -10, maximum: 10, base: 0 },
          { token: "c03", parameterId: "ParamArmLA", displayName: "Arm L", minimum: -1, maximum: 1, base: 0 },
          { token: "c04", parameterId: "ParamArmRA", displayName: "Arm R", minimum: -1, maximum: 1, base: 0 },
        ],
        partOpacityControls: [
          { token: "p01", partId: "PartArmA", displayName: "Coordinated visibility layer 1", minimum: 0, maximum: 1, base: 0 },
          { token: "p02", partId: "PartArmB", displayName: "Coordinated visibility layer 2", minimum: 0, maximum: 1, base: 1 },
        ],
      }),
    });

    await backend.stream(request(), () => {}, new AbortController().signal);
    const input = JSON.parse(inputs[0]);
    assert.equal(input.control_catalog.at(-2).id, "PartArmA");
    assert.equal(input.control_catalog.at(-2).target, "PartOpacity");
    const arm = input.reference_actions[0];
    assert.equal(arm.file, "motion/hiyori_m08.motion3.json");
    assert.deepEqual(arm.motion3.Curves.map((item: any) => item.Id), [
      "ParamArmLA", "PartArmA", "PartArmB",
    ]);
  });

  test("rotates the resident runtime after a bounded number of successful sessions", async () => {
    const closeCounts = [0, 0];
    const runners = closeCounts.map((_count, index): DshTurnRunner => ({
      async run(_input, options) {
        emitSegment(options, `runner-${index}`);
        return { reason: "completed" };
      },
      async close() { closeCounts[index] += 1; },
    }));
    let created = 0;
    let resets = 0;
    const backend = new DshRealtimeBackend({
      createRunner: () => runners[created++]!,
      loadProfile: profile,
      maxTurnsPerRunner: 2,
      onRunnerReset: () => { resets += 1; },
    });

    await backend.stream(request(), () => {}, new AbortController().signal);
    await backend.stream(request(), () => {}, new AbortController().signal);
    const third = await backend.stream(request(), () => {}, new AbortController().signal);

    assert.equal(created, 2);
    assert.deepEqual(closeCounts, [1, 0]);
    assert.equal(resets, 1);
    assert.equal(third.reply, "runner-1");
    await backend.close();
    assert.deepEqual(closeCounts, [1, 1]);
  });

  test("rejects an invalid resident runtime turn limit", () => {
    assert.throws(
      () => new DshRealtimeBackend({
        createRunner: () => ({ async run() { return { reason: "completed" }; }, async close() {} }),
        maxTurnsPerRunner: 0,
      }),
      /positive safe integer/u,
    );
  });

  test("does not turn a completed response into a failure when scheduled rotation cleanup fails", async () => {
    const backend = new DshRealtimeBackend({
      createRunner: () => ({
        async run(_input, options) {
          emitSegment(options, "completed-before-cleanup");
          return { reason: "completed" };
        },
        async close() { throw new Error("cleanup failed"); },
      }),
      loadProfile: profile,
      maxTurnsPerRunner: 1,
    });

    const result = await backend.stream(request(), () => {}, new AbortController().signal);
    assert.equal(result.reply, "completed-before-cleanup");
  });

  test("a concurrent turn closes the in-flight runtime without letting its old catch close the replacement", async () => {
    let resolveFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    let firstCloseCount = 0;
    let secondCloseCount = 0;
    const firstRunner: DshTurnRunner = {
      run: async (_input, options) => {
        firstStarted();
        await new Promise<void>((resolve) => { resolveFirst = resolve; });
        emitSegment(options, "stale");
        return { reason: "completed" };
      },
      async close() {
        firstCloseCount += 1;
      },
    };
    const secondRunner: DshTurnRunner = {
      async run(_input, options) {
        emitSegment(options, "replacement");
        return { reason: "completed" };
      },
      async close() { secondCloseCount += 1; },
    };
    const runners = [firstRunner, secondRunner];
    let resets = 0;
    const backend = new DshRealtimeBackend({
      createRunner: () => runners.shift()!,
      loadProfile: profile,
      onRunnerReset: () => { resets += 1; },
    });

    const first = backend.stream(request(), () => {}, new AbortController().signal);
    const firstFailure = assert.rejects(
      first,
      (error: unknown) => error instanceof Error && "code" in error && error.code === "dsh_turn_superseded",
    );
    await started;
    const second = await backend.stream(request(), () => {}, new AbortController().signal);
    resolveFirst();
    await firstFailure;

    assert.equal(second.reply, "replacement");
    assert.equal(firstCloseCount, 1);
    assert.equal(secondCloseCount, 0);
    assert.equal(resets, 1);
    await backend.close();
    assert.equal(secondCloseCount, 1);
    assert.equal(resets, 1);
  });

  test("protocol and incomplete-turn failures close the runtime before the next request", async () => {
    const closeCounts = [0, 0, 0];
    const runners: DshTurnRunner[] = [
      {
        async run(_input, options) {
          options.onTextDelta("not json\n");
          return { reason: "completed" };
        },
        async close() { closeCounts[0] += 1; },
      },
      {
        async run() { return { reason: "max-tokens" }; },
        async close() { closeCounts[1] += 1; },
      },
      {
        async run(_input, options) {
          emitSegment(options, "recovered");
          return { reason: "completed" };
        },
        async close() { closeCounts[2] += 1; },
      },
    ];
    let resets = 0;
    const backend = new DshRealtimeBackend({
      createRunner: () => runners.shift()!,
      loadProfile: profile,
      onRunnerReset: () => { resets += 1; },
    });

    await assert.rejects(backend.stream(request(), () => {}, new AbortController().signal));
    await assert.rejects(
      backend.stream(request(), () => {}, new AbortController().signal),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "dsh_turn_incomplete",
    );
    const recovered = await backend.stream(request(), () => {}, new AbortController().signal);

    assert.equal(recovered.reply, "recovered");
    assert.deepEqual(closeCounts, [1, 1, 0]);
    assert.equal(resets, 2);
  });

  test("delivers valid lines before a later protocol error in the same text delta", async () => {
    const first = JSON.stringify({
      type: "segment",
      seq: 0,
      text: "先播放这一段。",
      fallback: "nod",
      cues: [],
    });
    const runner: DshTurnRunner = {
      async run(_input, options) {
        options.onTextDelta(`${first}\nnot-json\n`);
        return { reason: "completed" };
      },
      async close() {},
    };
    const backend = new DshRealtimeBackend({
      createRunner: () => runner,
      loadProfile: profile,
    });
    const segments: string[] = [];

    await assert.rejects(
      backend.stream(
        request(),
        (segment) => segments.push(segment.text),
        new AbortController().signal,
      ),
    );

    assert.deepEqual(segments, ["先播放这一段。"]);
  });

  test("an aborted active turn resets its runner but an aborted request before acquisition does not", async () => {
    let closeCount = 0;
    let resetCount = 0;
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const runner: DshTurnRunner = {
      async run(_input, options) {
        started();
        await new Promise<void>((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
        return { reason: "completed" };
      },
      async close() { closeCount += 1; },
    };
    const backend = new DshRealtimeBackend({
      createRunner: () => runner,
      loadProfile: profile,
      onRunnerReset: () => { resetCount += 1; },
    });
    const preAborted = new AbortController();
    preAborted.abort();

    await assert.rejects(backend.stream(request(), () => {}, preAborted.signal));
    assert.equal(resetCount, 0);

    const active = new AbortController();
    const turn = backend.stream(request(), () => {}, active.signal);
    await running;
    active.abort();
    await assert.rejects(turn);

    assert.equal(closeCount, 1);
    assert.equal(resetCount, 1);
  });
});
