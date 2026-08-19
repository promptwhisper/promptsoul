import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ActionCueScheduler,
  type ActionCueParameterAccess,
  type ResolvedSegment,
} from "../lib/shared/action-cue-scheduler";

interface Write {
  parameter: string;
  value: number;
}

function createParameters(
  baselines: Record<string, number>,
): { access: ActionCueParameterAccess; writes: Write[] } {
  const writes: Write[] = [];
  return {
    access: {
      read: (parameter) => baselines[parameter],
      write: (parameter, value) => {
        writes.push({ parameter, value });
        return true;
      },
    },
    writes,
  };
}

function createSegment(
  overrides: Partial<ResolvedSegment> = {},
): ResolvedSegment {
  return {
    turnId: "turn-1",
    modelEpoch: 7,
    seq: 0,
    cues: [
      {
        id: "cue-0",
        at: 0.25,
        span: 0.5,
        curves: [
          {
            parameter: "ParamAngleX",
            minimum: -5,
            maximum: 5,
            keys: [[0, 0], [0.5, 1], [1, 0]],
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("ActionCueScheduler", () => {
  test("rejects empty and all-zero cues instead of accepting a silent segment", () => {
    const scheduler = new ActionCueScheduler();
    scheduler.beginTurn("turn-1", 7, "audio");

    assert.equal(scheduler.enqueueSegment(createSegment({
      cues: [{ id: "empty", at: 0, span: 1, curves: [] }],
    })), false);
    assert.equal(scheduler.enqueueSegment(createSegment({
      cues: [{
        id: "zero",
        at: 0,
        span: 1,
        curves: [{
          parameter: "ParamAngleX",
          minimum: -5,
          maximum: 5,
          keys: [[0, 0], [0.5, 0], [1, 0]],
        }],
      }],
    })), false);
  });

  test("reports only parameter writes confirmed by the runtime accessor", () => {
    const cueEvents: string[] = [];
    const frameEvents: Array<{ writeCount: number; parameterIds: readonly string[] }> = [];
    const scheduler = new ActionCueScheduler({
      onCueApplied: (event) => cueEvents.push(event.cueId),
      onFrameApplied: (event) => frameEvents.push(event),
    });
    scheduler.beginTurn("turn-1", 7, "performance");
    scheduler.enqueueSegment(createSegment({
      cues: [{
        id: "confirmed",
        at: 0,
        span: 1,
        curves: [{
          parameter: "ParamAngleX",
          minimum: -5,
          maximum: 5,
          keys: [[0, 0], [0.5, 1], [1, 0]],
        }],
      }],
    }));
    scheduler.bindAudio(0, 0, 2, "turn-1");

    assert.equal(scheduler.applyFrame(1, {
      read: () => 0,
      write: () => false,
    }), 0);
    assert.deepEqual(cueEvents, []);
    assert.deepEqual(frameEvents, []);

    assert.equal(scheduler.applyFrame(1.1, {
      read: () => 0,
      write: () => true,
    }), 1);
    assert.deepEqual(cueEvents, ["confirmed"]);
    assert.deepEqual(frameEvents, [{
      turnId: "turn-1",
      modelEpoch: 7,
      appliedAt: 1.1,
      clockId: "performance",
      writeCount: 1,
      parameterIds: ["ParamAngleX"],
    }]);
  });

  test("uses one baseline and restores a PartOpacity address after its cue", () => {
    const values: Record<string, number> = { "PartOpacity:PartArmA": 0 };
    const writes: Write[] = [];
    const access: ActionCueParameterAccess = {
      read: (parameter) => values[parameter],
      write: (parameter, value) => {
        values[parameter] = value;
        writes.push({ parameter, value });
        return true;
      },
    };
    const scheduler = new ActionCueScheduler();
    scheduler.beginTurn("turn-1", 7, "audio");
    scheduler.enqueueSegment(createSegment({
      cues: [{
        id: "part", at: 0, span: 1,
        curves: [{
          parameter: "PartOpacity:PartArmA", minimum: 0, maximum: 1,
          keys: [[0, 0], [0.5, 1], [1, 0]],
        }],
      }],
    }));
    scheduler.bindAudio(0, 0, 2, "turn-1");
    scheduler.applyFrame(1, access);
    assert.equal(values["PartOpacity:PartArmA"], 1);
    scheduler.applyFrame(2, access);
    assert.equal(values["PartOpacity:PartArmA"], 0);
    assert.deepEqual(writes.map((entry) => entry.value), [1, 0]);
  });

  test("reports a bound segment once after its window ends with no successful writes", () => {
    const endedEvents: Array<{
      turnId: string;
      modelEpoch: number;
      segmentSeq: number;
      clockId: string | null;
      scheduledStartAt: number;
      scheduledEndAt: number;
      observedAt: number;
      writeCount: number;
    }> = [];
    const scheduler = new ActionCueScheduler({
      onSegmentEnded: (event) => endedEvents.push(event),
    });
    scheduler.beginTurn("turn-1", 7, "audio");
    scheduler.enqueueSegment(createSegment({
      cues: [{
        id: "clamped",
        at: 0,
        span: 1,
        curves: [{
          parameter: "ParamAngleX",
          minimum: -5,
          maximum: 5,
          keys: [[0, 0], [0.5, 1], [1, 0]],
        }],
      }],
    }));
    scheduler.bindAudio(0, 10, 2, "turn-1");

    assert.equal(scheduler.applyFrame(9.9, createParameters({ ParamAngleX: 5 }).access), 0);
    assert.deepEqual(endedEvents, []);
    assert.equal(scheduler.applyFrame(11, createParameters({ ParamAngleX: 5 }).access), 0);
    assert.deepEqual(endedEvents, []);
    assert.equal(scheduler.applyFrame(12, createParameters({ ParamAngleX: 5 }).access), 0);
    assert.deepEqual(endedEvents, [{
      turnId: "turn-1",
      modelEpoch: 7,
      segmentSeq: 0,
      clockId: "audio",
      scheduledStartAt: 10,
      scheduledEndAt: 12,
      observedAt: 12,
      writeCount: 0,
    }]);

    scheduler.applyFrame(13, createParameters({ ParamAngleX: 5 }).access);
    assert.equal(endedEvents.length, 1);
  });

  test("reports successful runtime writes when a bound segment ends", () => {
    const endedWriteCounts: number[] = [];
    const scheduler = new ActionCueScheduler({
      onSegmentEnded: (event) => endedWriteCounts.push(event.writeCount),
    });
    const parameters = createParameters({ ParamAngleX: 0 });
    scheduler.beginTurn("turn-1", 7, "performance");
    scheduler.enqueueSegment(createSegment());
    scheduler.bindAudio(0, 0, 0.4, "turn-1");

    assert.equal(scheduler.applyFrame(0.2, parameters.access), 1);
    assert.equal(scheduler.applyFrame(0.21, parameters.access), 1);
    assert.equal(scheduler.applyFrame(0.4, parameters.access), 0);
    assert.deepEqual(endedWriteCounts, [2]);
  });

  test("does not count replacement-turn cancellation fade writes for a no-op segment", () => {
    const endedWriteCounts: number[] = [];
    const scheduler = new ActionCueScheduler({
      onSegmentEnded: (event) => endedWriteCounts.push(event.writeCount),
    });
    const parameters = createParameters({ ParamAngleX: 5 });
    scheduler.beginTurn("turn-1", 7, "performance");
    scheduler.enqueueSegment(createSegment({
      cues: [{
        id: "old-offset",
        at: 0,
        span: 1,
        curves: [{
          parameter: "ParamAngleX",
          minimum: -5,
          maximum: 5,
          keys: [[0, 0], [0.5, -4], [1, 0]],
        }],
      }],
    }));
    scheduler.bindAudio(0, 0, 2, "turn-1");
    assert.equal(scheduler.applyFrame(1, parameters.access), 1);

    scheduler.cancelTurn("turn-1", 200);
    scheduler.beginTurn("turn-2", 7, "performance");
    scheduler.enqueueSegment(createSegment({
      turnId: "turn-2",
      cues: [{
        id: "clamped-replacement",
        at: 0,
        span: 1,
        curves: [{
          parameter: "ParamAngleX",
          minimum: -5,
          maximum: 5,
          keys: [[0, 0], [0.5, 1], [1, 0]],
        }],
      }],
    }));
    scheduler.bindAudio(0, 1, 0.2, "turn-2");

    assert.equal(scheduler.applyFrame(1.1, parameters.access), 1);
    scheduler.applyFrame(1.2, parameters.access);
    assert.deepEqual(endedWriteCounts, [0]);
  });

  test("reports the first frame that actually writes each cue parameter", () => {
    const events: Array<{
      segmentSeq: number;
      cueId: string;
      scheduledAt: number;
      appliedAt: number;
      clockId: string | null;
      parameterIds: readonly string[];
    }> = [];
    const scheduler = new ActionCueScheduler({
      onCueApplied: (event) => events.push(event),
    });
    const parameters = createParameters({ ParamAngleX: 0 });
    scheduler.beginTurn("turn-1", 7, "audio");
    scheduler.enqueueSegment(createSegment({
      cues: [{
        id: "measured",
        at: 0.25,
        span: 0.5,
        curves: [{
          parameter: "ParamAngleX",
          minimum: -5,
          maximum: 5,
          keys: [[0, 0], [0.5, 1], [1, 0]],
        }],
      }],
    }));
    scheduler.bindAudio(0, 10, 4, "turn-1");

    assert.equal(scheduler.applyFrame(11, parameters.access), 0);
    assert.deepEqual(events, []);
    assert.equal(scheduler.applyFrame(11.01, parameters.access), 1);
    assert.deepEqual(events, [{
      turnId: "turn-1",
      modelEpoch: 7,
      segmentSeq: 0,
      cueId: "measured",
      scheduledAt: 11,
      appliedAt: 11.01,
      clockId: "audio",
      parameterIds: ["ParamAngleX"],
    }]);
    scheduler.applyFrame(11.02, parameters.access);
    assert.equal(events.length, 1);
  });

  test("anchors normalized cue timing to AudioContext seconds", () => {
    const scheduler = new ActionCueScheduler();
    const parameters = createParameters({ ParamAngleX: 2 });
    assert.equal(scheduler.beginTurn("turn-1", 7), true);
    assert.equal(scheduler.enqueueSegment(createSegment()), true);
    assert.equal(scheduler.bindAudio(0, 10, 4), true);

    assert.equal(scheduler.applyFrame(10.99, parameters.access), 0);
    assert.equal(scheduler.applyFrame(11, parameters.access), 0);
    assert.deepEqual(parameters.writes, []);

    assert.equal(scheduler.applyFrame(11.5, parameters.access), 1);
    assert.deepEqual(parameters.writes.at(-1), {
      parameter: "ParamAngleX",
      value: 2.5,
    });

    assert.equal(scheduler.applyFrame(12, parameters.access), 1);
    assert.deepEqual(parameters.writes.at(-1), {
      parameter: "ParamAngleX",
      value: 3,
    });

    const writesBeforeEnd = parameters.writes.length;
    assert.equal(scheduler.applyFrame(13, parameters.access), 0);
    assert.equal(parameters.writes.length, writesBeforeEnd + 1);
  });

  test("reanchors a performance segment when rendering resumes after its window", () => {
    const scheduler = new ActionCueScheduler();
    const parameters = createParameters({ ParamAngleX: 0 });
    scheduler.beginTurn("turn-1", 7, "performance");
    scheduler.enqueueSegment(createSegment({
      cues: [{
        id: "resume-visible",
        at: 0,
        span: 1,
        curves: [{
          parameter: "ParamAngleX",
          minimum: -5,
          maximum: 5,
          keys: [[0, 0], [0.5, 1], [1, 0]],
        }],
      }],
    }));
    scheduler.bindAudio(0, 10, 0.2, "turn-1");

    assert.equal(scheduler.applyFrame(20, parameters.access), 0);
    assert.equal(scheduler.applyFrame(20.1, parameters.access), 1);
    assert.deepEqual(parameters.writes.at(-1), {
      parameter: "ParamAngleX",
      value: 1,
    });
  });

  test("treats the first bound performance segment independently from earlier empty frames", () => {
    const scheduler = new ActionCueScheduler();
    const parameters = createParameters({ ParamAngleX: 0 });
    scheduler.beginTurn("turn-1", 7, "performance");
    assert.equal(scheduler.applyFrame(5, parameters.access), 0);
    scheduler.enqueueSegment(createSegment({
      cues: [{
        id: "late-first-segment",
        at: 0,
        span: 1,
        curves: [{
          parameter: "ParamAngleX",
          minimum: -5,
          maximum: 5,
          keys: [[0, 0], [0.5, 1], [1, 0]],
        }],
      }],
    }));
    scheduler.bindAudio(0, 10, 0.2, "turn-1");

    assert.equal(scheduler.applyFrame(20, parameters.access), 0);
    assert.equal(scheduler.applyFrame(20.1, parameters.access), 1);
    assert.equal(parameters.writes.at(-1)?.value, 1);
  });

  test("preserves a performance cue phase when rendering resumes mid-segment", () => {
    const scheduler = new ActionCueScheduler();
    const parameters = createParameters({ ParamAngleX: 0 });
    scheduler.beginTurn("turn-1", 7, "performance");
    scheduler.enqueueSegment(createSegment({
      cues: [{
        id: "resume-phase",
        at: 0,
        span: 1,
        curves: [{
          parameter: "ParamAngleX",
          minimum: -5,
          maximum: 5,
          keys: [[0, 0], [0.5, 1], [1, 0]],
        }],
      }],
    }));
    scheduler.bindAudio(0, 10, 4, "turn-1");

    assert.equal(scheduler.applyFrame(11, parameters.access), 1);
    assert.equal(parameters.writes.at(-1)?.value, 0.5);
    assert.equal(scheduler.applyFrame(20, parameters.access), 1);
    assert.equal(parameters.writes.at(-1)?.value, 0.5);
  });

  test("does not reanchor an AudioContext segment after rendering pauses", () => {
    const endedEvents: Array<{
      scheduledStartAt: number;
      scheduledEndAt: number;
      writeCount: number;
    }> = [];
    const scheduler = new ActionCueScheduler({
      onSegmentEnded: (event) => endedEvents.push({
        scheduledStartAt: event.scheduledStartAt,
        scheduledEndAt: event.scheduledEndAt,
        writeCount: event.writeCount,
      }),
    });
    const parameters = createParameters({ ParamAngleX: 0 });
    scheduler.beginTurn("turn-1", 7, "audio");
    scheduler.enqueueSegment(createSegment());
    scheduler.bindAudio(0, 10, 2, "turn-1");

    assert.equal(scheduler.applyFrame(20, parameters.access), 0);
    assert.deepEqual(parameters.writes, []);
    assert.deepEqual(endedEvents, [{
      scheduledStartAt: 10,
      scheduledEndAt: 12,
      writeCount: 0,
    }]);
  });

  test("translates queued performance segments together without changing their order", () => {
    const endedSegments: Array<{
      segmentSeq: number;
      scheduledStartAt: number;
      scheduledEndAt: number;
      writeCount: number;
    }> = [];
    const scheduler = new ActionCueScheduler({
      onSegmentEnded: (event) => endedSegments.push({
        segmentSeq: event.segmentSeq,
        scheduledStartAt: event.scheduledStartAt,
        scheduledEndAt: event.scheduledEndAt,
        writeCount: event.writeCount,
      }),
    });
    const parameters = createParameters({ ParamAngleX: 0, ParamBodyAngleX: 0 });
    scheduler.beginTurn("turn-1", 7, "performance");
    scheduler.enqueueSegment(createSegment({
      seq: 0,
      cues: [{
        id: "first",
        at: 0,
        span: 1,
        curves: [{
          parameter: "ParamAngleX",
          minimum: -5,
          maximum: 5,
          keys: [[0, 0], [0.5, 1], [1, 0]],
        }],
      }],
    }));
    scheduler.enqueueSegment(createSegment({
      seq: 1,
      cues: [{
        id: "second",
        at: 0,
        span: 1,
        curves: [{
          parameter: "ParamBodyAngleX",
          minimum: -5,
          maximum: 5,
          keys: [[0, 0], [0.5, 1], [1, 0]],
        }],
      }],
    }));
    scheduler.bindAudio(0, 10, 0.4, "turn-1");
    scheduler.bindAudio(1, 10, 0.4, "turn-1");

    assert.equal(scheduler.applyFrame(20, parameters.access), 0);
    assert.equal(scheduler.applyFrame(20.2, parameters.access), 1);
    assert.deepEqual(parameters.writes.at(-1), {
      parameter: "ParamAngleX",
      value: 1,
    });
    assert.equal(scheduler.applyFrame(20.4, parameters.access), 0);
    assert.deepEqual(endedSegments, [{
      segmentSeq: 0,
      scheduledStartAt: 20,
      scheduledEndAt: 20.4,
      writeCount: 1,
    }]);
    assert.equal(scheduler.applyFrame(20.6, parameters.access), 1);
    assert.deepEqual(parameters.writes.at(-1), {
      parameter: "ParamBodyAngleX",
      value: 1,
    });
  });

  test("uses smoothstep interpolation between literal key values", () => {
    const scheduler = new ActionCueScheduler();
    const parameters = createParameters({ ParamAngleX: 10 });
    scheduler.beginTurn("turn-1", 7);
    scheduler.enqueueSegment(createSegment({
      cues: [{
        id: "smooth",
        at: 0,
        span: 1,
        curves: [{
          parameter: "ParamAngleX",
          minimum: -20,
          maximum: 20,
          keys: [[0, 0], [0.5, 1], [1, 0]],
        }],
      }],
    }));
    scheduler.bindAudio(0, 20, 8);

    scheduler.applyFrame(21, parameters.access);
    assert.equal(parameters.writes.at(-1)?.value, 10.15625);
  });

  test("adds simultaneous curves and clamps once to the safe parameter range", () => {
    const scheduler = new ActionCueScheduler();
    const parameters = createParameters({ ParamAngleX: 0.6, ParamBodyAngleX: -1 });
    scheduler.beginTurn("turn-1", 7);
    scheduler.enqueueSegment(createSegment({
      cues: [
        {
          id: "second",
          at: 0,
          span: 1,
          curves: [{
            parameter: "ParamAngleX",
            minimum: -1,
            maximum: 1,
            keys: [[0, 0], [0.5, 0.7], [1, 0]],
          }],
        },
        {
          id: "first",
          at: 0,
          span: 1,
          curves: [
            {
              parameter: "ParamBodyAngleX",
              minimum: -2,
              maximum: 2,
              keys: [[0, 0], [0.5, 0.5], [1, 0]],
            },
            {
              parameter: "ParamAngleX",
              minimum: -1,
              maximum: 1,
              keys: [[0, 0], [0.5, 0.8], [1, 0]],
            },
          ],
        },
      ],
    }));
    scheduler.bindAudio(0, 0, 2);

    assert.equal(scheduler.applyFrame(1, parameters.access), 2);
    assert.deepEqual(parameters.writes, [
      { parameter: "ParamAngleX", value: 1 },
      { parameter: "ParamBodyAngleX", value: -0.5 },
    ]);
  });

  test("linearly fades the last active offsets after cancellation", () => {
    const scheduler = new ActionCueScheduler();
    const parameters = createParameters({ ParamAngleX: 2 });
    scheduler.beginTurn("turn-1", 7);
    scheduler.enqueueSegment(createSegment({
      cues: [{
        id: "long-cue",
        at: 0,
        span: 1,
        curves: [{
          parameter: "ParamAngleX",
          minimum: -5,
          maximum: 5,
          keys: [[0, 0], [0.5, 1], [1, 0]],
        }],
      }],
    }));
    scheduler.bindAudio(0, 0, 2);
    scheduler.applyFrame(1, parameters.access);
    assert.equal(parameters.writes.at(-1)?.value, 3);

    assert.equal(scheduler.cancelTurn("turn-1"), true);
    assert.equal(scheduler.enqueueSegment(createSegment({ seq: 1 })), false);
    scheduler.applyFrame(1.1, parameters.access);
    assert.ok(Math.abs((parameters.writes.at(-1)?.value ?? 0) - 2.5) < 1e-12);

    const writesBeforeFadeEnd = parameters.writes.length;
    assert.equal(scheduler.applyFrame(1.2, parameters.access), 0);
    assert.equal(parameters.writes.length, writesBeforeFadeEnd);
    assert.equal(scheduler.applyFrame(1.3, parameters.access), 0);
  });

  test("keeps the return-to-zero fade when a replacement turn begins immediately", () => {
    const scheduler = new ActionCueScheduler();
    const parameters = createParameters({ ParamAngleX: 2 });
    scheduler.beginTurn("turn-1", 7);
    scheduler.enqueueSegment(createSegment({
      cues: [{
        id: "interrupted",
        at: 0,
        span: 1,
        curves: [{
          parameter: "ParamAngleX",
          minimum: -5,
          maximum: 5,
          keys: [[0, 0], [0.5, 1], [1, 0]],
        }],
      }],
    }));
    scheduler.bindAudio(0, 0, 2, "turn-1");
    scheduler.applyFrame(1, parameters.access);
    scheduler.cancelTurn("turn-1");
    scheduler.beginTurn("turn-2", 7);

    scheduler.applyFrame(1.1, parameters.access);
    assert.ok(Math.abs((parameters.writes.at(-1)?.value ?? 0) - 2.5) < 1e-12);
    const writesBeforeEnd = parameters.writes.length;
    assert.equal(scheduler.applyFrame(1.2, parameters.access), 0);
    assert.equal(parameters.writes.length, writesBeforeEnd);
  });

  test("reanchors an interrupted fade when the replacement turn changes clock domains", () => {
    const scheduler = new ActionCueScheduler();
    const parameters = createParameters({ ParamAngleX: 2 });
    scheduler.beginTurn("turn-1", 7, "audio");
    scheduler.enqueueSegment(createSegment({
      cues: [{
        id: "audio-cue",
        at: 0,
        span: 1,
        curves: [{
          parameter: "ParamAngleX",
          minimum: -5,
          maximum: 5,
          keys: [[0, 0], [0.5, 1], [1, 0]],
        }],
      }],
    }));
    scheduler.bindAudio(0, 99, 4, "turn-1");
    scheduler.applyFrame(101, parameters.access);
    assert.equal(parameters.writes.at(-1)?.value, 3);

    scheduler.cancelTurn("turn-1", 200);
    scheduler.beginTurn("turn-2", 7, "performance");

    scheduler.applyFrame(5, parameters.access);
    assert.equal(parameters.writes.at(-1)?.value, 3);
    scheduler.applyFrame(5.1, parameters.access);
    assert.ok(Math.abs((parameters.writes.at(-1)?.value ?? 0) - 2.5) < 1e-12);
    const writesBeforeEnd = parameters.writes.length;
    scheduler.applyFrame(5.2, parameters.access);
    assert.equal(parameters.writes.length, writesBeforeEnd + 1);
    assert.equal(parameters.writes.at(-1)?.value, 2);
  });

  test("drops stale turns, model epochs, sequence numbers and late audio", () => {
    const scheduler = new ActionCueScheduler();
    const parameters = createParameters({ ParamAngleX: 0 });
    scheduler.beginTurn("turn-1", 7);

    assert.equal(scheduler.enqueueSegment(createSegment({ turnId: "old-turn" })), false);
    assert.equal(scheduler.enqueueSegment(createSegment({ modelEpoch: 6 })), false);
    assert.equal(scheduler.enqueueSegment(createSegment()), true);
    assert.equal(scheduler.enqueueSegment(createSegment()), false);
    assert.equal(scheduler.enqueueSegment(createSegment({ seq: 2 })), true);
    assert.equal(scheduler.enqueueSegment(createSegment({ seq: 1 })), false);

    scheduler.applyFrame(5, parameters.access);
    assert.equal(scheduler.bindAudio(0, 1, 2), false);
    assert.equal(scheduler.bindAudio(2, 6, 2), true);

    scheduler.beginTurn("turn-2", 8);
    assert.equal(scheduler.cancelTurn("turn-1"), false);
    assert.equal(scheduler.enqueueSegment(createSegment({ seq: 3 })), false);
    assert.equal(scheduler.applyFrame(7, parameters.access), 0);
    assert.deepEqual(parameters.writes, []);
    assert.equal(scheduler.beginTurn("stale-model", 7), false);
  });

  test("requires a matching turn identity when binding tagged TTS audio", () => {
    const scheduler = new ActionCueScheduler();
    scheduler.beginTurn("turn-1", 7);
    scheduler.enqueueSegment(createSegment());
    scheduler.beginTurn("turn-2", 7);
    scheduler.enqueueSegment(createSegment({ turnId: "turn-2" }));

    assert.equal(scheduler.bindAudio(0, 1, 2, "turn-1"), false);
    assert.equal(scheduler.bindAudio(0, 1, 2, "turn-2"), true);
  });

  test("accepts a replacement turn after its audio clock origin resets", () => {
    const scheduler = new ActionCueScheduler();
    const parameters = createParameters({ ParamAngleX: 0 });
    scheduler.beginTurn("turn-1", 7);
    scheduler.enqueueSegment(createSegment());
    scheduler.bindAudio(0, 100, 4, "turn-1");
    scheduler.applyFrame(101, parameters.access);

    scheduler.beginTurn("turn-2", 7);
    scheduler.enqueueSegment(createSegment({ turnId: "turn-2" }));
    assert.equal(scheduler.bindAudio(0, 0, 4, "turn-2"), true);
    assert.equal(scheduler.applyFrame(2, parameters.access), 1);
  });

  test("accepts at most 24 segments in one turn", () => {
    const scheduler = new ActionCueScheduler();
    scheduler.beginTurn("turn-1", 7);
    for (let seq = 0; seq < 24; seq += 1) {
      assert.equal(scheduler.enqueueSegment(createSegment({ seq, cues: [] })), true);
    }
    assert.equal(scheduler.enqueueSegment(createSegment({ seq: 24, cues: [] })), false);
  });

  test("rejects non-finite data and leaves an invalid parameter baseline alone", () => {
    const scheduler = new ActionCueScheduler();
    scheduler.beginTurn("turn-1", 7);
    assert.equal(scheduler.enqueueSegment(createSegment({
      cues: [{
        id: "invalid",
        at: Number.NaN,
        span: 1,
        curves: [],
      }],
    })), false);
    assert.equal(scheduler.enqueueSegment(createSegment({
      cues: [{
        id: "invalid-key",
        at: 0,
        span: 1,
        curves: [{
          parameter: "ParamAngleX",
          minimum: -1,
          maximum: 1,
          keys: [[0, 0], [0.5, Number.POSITIVE_INFINITY], [1, 0]],
        }],
      }],
    })), false);

    assert.equal(scheduler.enqueueSegment(createSegment()), true);
    assert.equal(scheduler.bindAudio(0, 0, 2), true);
    const parameters = createParameters({ ParamAngleX: Number.NaN });
    assert.equal(scheduler.applyFrame(1, parameters.access), 0);
    assert.deepEqual(parameters.writes, []);
    assert.equal(scheduler.applyFrame(Number.NaN, parameters.access), 0);
  });

  test("dispose permanently clears queued work and prevents writes", () => {
    const scheduler = new ActionCueScheduler();
    const parameters = createParameters({ ParamAngleX: 0 });
    scheduler.beginTurn("turn-1", 7);
    scheduler.enqueueSegment(createSegment());
    scheduler.bindAudio(0, 0, 4);
    scheduler.dispose();

    assert.equal(scheduler.beginTurn("turn-2", 8), false);
    assert.equal(scheduler.applyFrame(2, parameters.access), 0);
    assert.deepEqual(parameters.writes, []);
  });
});
