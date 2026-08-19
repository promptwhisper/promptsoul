import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { playFallbackWithRetry } from "../lib/shared/fallback-playback";

function createState() {
  return {
    inFlight: new Set<number>(),
    played: new Set<number>(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("playFallbackWithRetry", () => {
  test("deduplicates an in-flight segment and records only confirmed playback", async () => {
    const state = createState();
    const pending = deferred<boolean>();
    let attempts = 0;
    const options = {
      canAttempt: () => true,
      play: () => {
        attempts += 1;
        return pending.promise;
      },
      wait: async () => {},
    };

    const first = playFallbackWithRetry(4, state, options);
    assert.equal(state.inFlight.has(4), true);
    assert.equal(await playFallbackWithRetry(4, state, options), false);
    assert.equal(attempts, 1);
    assert.equal(state.played.has(4), false);

    pending.resolve(true);
    assert.equal(await first, true);
    assert.equal(state.inFlight.has(4), false);
    assert.equal(state.played.has(4), true);
  });

  test("retries FORCE rejection and transient errors with bounded backoff", async () => {
    const state = createState();
    const delays: number[] = [];
    let attempts = 0;
    const started = await playFallbackWithRetry(0, state, {
      canAttempt: () => true,
      play: () => {
        attempts += 1;
        if (attempts === 1) return false;
        if (attempts === 2) throw new Error("reserved motion was replaced");
        return true;
      },
      retryDelayMs: 25,
      wait: async (delayMs) => { delays.push(delayMs); },
    });

    assert.equal(started, true);
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [25, 50]);
    assert.deepEqual([...state.played], [0]);
    assert.equal(state.inFlight.size, 0);
  });

  test("stops retrying when the owning turn becomes stale", async () => {
    const state = createState();
    let current = true;
    let attempts = 0;
    let waits = 0;
    const started = await playFallbackWithRetry(1, state, {
      canAttempt: () => current,
      play: () => {
        attempts += 1;
        current = false;
        return false;
      },
      wait: async () => { waits += 1; },
    });

    assert.equal(started, false);
    assert.equal(attempts, 1);
    assert.equal(waits, 0);
    assert.equal(state.played.size, 0);
    assert.equal(state.inFlight.size, 0);
  });

  test("does not record a late success after model ownership changes", async () => {
    const state = createState();
    const pending = deferred<boolean>();
    let current = true;
    const playback = playFallbackWithRetry(2, state, {
      canAttempt: () => current,
      play: () => pending.promise,
      wait: async () => {},
    });

    current = false;
    pending.resolve(true);
    assert.equal(await playback, false);
    assert.equal(state.played.size, 0);
    assert.equal(state.inFlight.size, 0);
  });

  test("stops after the configured finite attempt count", async () => {
    const state = createState();
    const delays: number[] = [];
    let attempts = 0;
    const started = await playFallbackWithRetry(3, state, {
      canAttempt: () => true,
      play: () => {
        attempts += 1;
        return false;
      },
      maxAttempts: 3,
      retryDelayMs: 10,
      wait: async (delayMs) => { delays.push(delayMs); },
    });

    assert.equal(started, false);
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [10, 20]);
    assert.equal(state.played.size, 0);
    assert.equal(state.inFlight.size, 0);
  });
});
