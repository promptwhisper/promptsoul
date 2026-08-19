import assert from "node:assert/strict";
import { test } from "node:test";

import { RealtimeMetrics } from "../lib/server/realtime-metrics";

test("records bounded realtime counters and TTFC percentiles without content", () => {
  let now = 100;
  const metrics = new RealtimeMetrics(() => now);
  for (let index = 0; index < 20; index += 1) {
    const turnId = `turn-${index}`;
    metrics.beginTurn(turnId);
    now += index + 1;
    metrics.recordSegment(turnId, index % 4 === 0);
    metrics.recordSegment(turnId, false);
    metrics.completeTurn(turnId);
  }
  metrics.beginTurn("failed");
  metrics.failTurn("failed");
  metrics.beginTurn("cancelled");
  metrics.cancelTurn("cancelled");
  metrics.recordRuntimeRestart();

  assert.deepEqual(metrics.snapshot(), {
    turnsStarted: 22,
    turnsCompleted: 20,
    turnsFailed: 1,
    turnsCancelled: 1,
    segments: 40,
    invalidCues: 5,
    runtimeRestarts: 1,
    lastTtfcMs: 20,
    ttfcP95Ms: 19,
  });
  assert.doesNotMatch(JSON.stringify(metrics.snapshot()), /turn-|failed|cancelled/u);
});
