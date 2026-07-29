import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { TtsPlaybackManager } from "../lib/shared/browser-tts";

function wavResponse(): Response {
  const header = Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00,
    0x57, 0x41, 0x56, 0x45,
  ]);
  return new Response(header, { headers: { "Content-Type": "audio/wav" } });
}

async function settle(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

class FakeSource {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;

  connect(): void {}
  disconnect(): void {}
  start(): void { this.started = true; }
  stop(): void { this.stopped = true; }
  finish(): void { this.onended?.(); }
}

class FakeAnalyser {
  fftSize = 1024;
  smoothingTimeConstant = 0;
  level = 0;

  connect(): void {}
  disconnect(): void {}
  getFloatTimeDomainData(samples: Float32Array): void { samples.fill(this.level); }
}

class FakeAudioContext {
  state: AudioContextState;
  currentTime = 0;
  destination = {} as AudioDestinationNode;
  analyser = new FakeAnalyser();
  sources: FakeSource[] = [];
  resumeCalls = 0;

  constructor(initialState: AudioContextState = "running") {
    this.state = initialState;
  }

  createAnalyser(): AnalyserNode { return this.analyser as unknown as AnalyserNode; }
  createGain(): GainNode {
    return { connect() {}, disconnect() {} } as unknown as GainNode;
  }
  createMediaStreamDestination(): MediaStreamAudioDestinationNode {
    return {
      connect() {},
      disconnect() {},
      stream: {} as MediaStream,
    } as unknown as MediaStreamAudioDestinationNode;
  }
  createBufferSource(): AudioBufferSourceNode {
    const source = new FakeSource();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }
  async decodeAudioData(): Promise<AudioBuffer> {
    return { duration: 1 } as AudioBuffer;
  }
  async resume(): Promise<void> {
    this.resumeCalls += 1;
    this.state = "running";
  }
  async suspend(): Promise<void> { this.state = "suspended"; }
  async close(): Promise<void> { this.state = "closed"; }
}

class FakeFrames {
  private nextId = 1;
  private callbacks = new Map<number, FrameRequestCallback>();

  request = (callback: FrameRequestCallback): number => {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  };

  cancel = (id: number): void => { this.callbacks.delete(id); };

  run(time = 16): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    callbacks.forEach((callback) => callback(time));
  }
}

function createManager(
  context: FakeAudioContext,
  fetchImpl: typeof fetch,
  frames = new FakeFrames(),
  mouthValues: number[] = [],
): TtsPlaybackManager {
  return new TtsPlaybackManager({
    endpoint: "/api/tts",
    fetchImpl,
    audioContextFactory: () => context as unknown as AudioContext,
    requestAnimationFrameImpl: frames.request,
    cancelAnimationFrameImpl: frames.cancel,
    onMouthOpen: (value) => mouthValues.push(value),
  });
}

describe("TtsPlaybackManager", () => {
  test("plays queued WAV audio in order without overlap and advances only on onended", async () => {
    const context = new FakeAudioContext();
    const requested: string[] = [];
    const manager = createManager(context, (async (_url, init) => {
      requested.push((JSON.parse(String(init?.body)) as { text: string }).text);
      return wavResponse();
    }) as typeof fetch);

    manager.enqueue("最初です。");
    manager.enqueue("次です。");
    await settle();
    assert.deepEqual(requested, ["最初です。", "次です。"]);
    assert.equal(context.sources.length, 1);
    assert.equal(context.sources[0].started, true);
    assert.equal(manager.getState().state, "playing");

    context.sources[0].finish();
    await settle();
    assert.equal(context.sources.length, 2);
    assert.equal(context.sources[1].started, true);
    assert.equal(context.sources[0].stopped, false);

    context.sources[1].finish();
    await settle();
    assert.equal(manager.getState().state, "idle");
    assert.equal(manager.getState().queueLength, 0);
    await manager.destroy();
  });

  test("stop aborts synthesis, clears the queue and returns to idle", async () => {
    const context = new FakeAudioContext();
    let aborted = false;
    const manager = createManager(context, ((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("aborted", "AbortError"));
      });
    })) as typeof fetch);
    manager.enqueue("生成中です。");
    manager.enqueue("再生しません。");
    await settle(1);
    manager.stop();
    await settle();
    assert.equal(aborted, true);
    assert.equal(manager.getState().state, "idle");
    assert.equal(manager.getState().queueLength, 0);
    assert.equal(context.sources.length, 0);
    await manager.destroy();
  });

  test("a replacement queued immediately after stop starts with a fresh pump generation", async () => {
    const context = new FakeAudioContext();
    let calls = 0;
    const manager = createManager(context, ((_url, init) => {
      calls += 1;
      if (calls > 1) return Promise.resolve(wavResponse());
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          queueMicrotask(() => reject(new DOMException("aborted", "AbortError")));
        });
      });
    }) as typeof fetch);

    manager.enqueue("停止される文です。");
    await settle(1);
    manager.stop();
    manager.enqueue("すぐに置き換える文です。");
    await settle();
    assert.equal(calls, 2);
    assert.equal(context.sources.length, 1);
    assert.equal(manager.getState().state, "playing");
    context.sources[0].finish();
    await settle();
    await manager.destroy();
  });

  test("a failed request does not block the next queued sentence", async () => {
    const context = new FakeAudioContext();
    let calls = 0;
    const manager = createManager(context, (async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ error: { code: "TTS_ENGINE_UNAVAILABLE" } }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        })
        : wavResponse();
    }) as typeof fetch);
    manager.enqueue("失敗します。");
    manager.enqueue("続けます。");
    await settle();
    assert.equal(calls, 2);
    assert.equal(context.sources.length, 1);
    assert.equal(manager.getState().state, "playing");
    assert.equal(manager.getState().lastError, null);
    context.sources[0].finish();
    await settle();
    await manager.destroy();
  });

  test("unlocks one reusable AudioContext on the first user gesture", async () => {
    const context = new FakeAudioContext("suspended");
    const manager = createManager(context, (async () => wavResponse()) as typeof fetch);
    assert.equal(await manager.unlock(), true);
    assert.equal(context.resumeCalls, 1);
    assert.equal(manager.getState().audioContextState, "running");
    assert.equal(await manager.unlock(), true);
    assert.equal(context.resumeCalls, 1);
    await manager.destroy();
  });

  test("does not claim playback when AudioContext remains suspended", async () => {
    const context = new FakeAudioContext("suspended");
    context.resume = async () => { context.resumeCalls += 1; };
    const manager = createManager(context, (async () => wavResponse()) as typeof fetch);
    manager.enqueue("再生できません。");
    await settle();
    assert.equal(context.sources.length, 0);
    assert.equal(manager.getState().state, "idle");
    assert.match(manager.getState().lastError ?? "", /AUDIO_CONTEXT_SUSPENDED/u);
    await manager.destroy();
  });

  test("destroyed managers cannot recreate an AudioContext", async () => {
    const context = new FakeAudioContext();
    const frames = new FakeFrames();
    let factoryCalls = 0;
    const manager = new TtsPlaybackManager({
      fetchImpl: (async () => wavResponse()) as typeof fetch,
      audioContextFactory: () => {
        factoryCalls += 1;
        return context as unknown as AudioContext;
      },
      requestAnimationFrameImpl: frames.request,
      cancelAnimationFrameImpl: frames.cancel,
    });
    assert.equal(await manager.unlock(), true);
    assert.equal(factoryCalls, 1);
    await manager.destroy();
    assert.equal(await manager.unlock(), false);
    assert.equal(factoryCalls, 1);
    assert.equal(manager.getState().audioContextState, "unavailable");
  });

  test("pauses and resumes the active source through the same AudioContext", async () => {
    const context = new FakeAudioContext();
    const manager = createManager(context, (async () => wavResponse()) as typeof fetch);
    manager.enqueue("一時停止を確認します。");
    await settle();
    assert.equal(manager.getState().state, "playing");
    assert.equal(context.sources.length, 1);

    await manager.pause();
    assert.equal(context.state, "suspended");
    assert.equal(manager.getState().state, "paused");
    assert.equal(context.sources[0].stopped, false);

    await manager.resume();
    assert.equal(context.state, "running");
    assert.equal(manager.getState().state, "playing");
    assert.equal(context.sources.length, 1);
    context.sources[0].finish();
    await settle();
    await manager.destroy();
  });

  test("stop wins over an in-flight pause transition", async () => {
    const context = new FakeAudioContext();
    const suspension = deferredVoid();
    context.suspend = async () => {
      await suspension.promise;
      context.state = "suspended";
    };
    const manager = createManager(context, (async () => wavResponse()) as typeof fetch);
    manager.enqueue("競合を確認します。");
    await settle();

    const pausing = manager.pause();
    manager.stop();
    suspension.resolve();
    await pausing;
    assert.equal(manager.getState().state, "idle");
    assert.equal(manager.getState().queueLength, 0);
    await manager.destroy();
  });

  test("stop wins over an in-flight resume transition", async () => {
    const context = new FakeAudioContext();
    const manager = createManager(context, (async () => wavResponse()) as typeof fetch);
    manager.enqueue("再開競合を確認します。");
    await settle();
    await manager.pause();
    const resumption = deferredVoid();
    context.resume = async () => {
      await resumption.promise;
      context.state = "running";
    };

    const resuming = manager.resume();
    manager.stop();
    resumption.resolve();
    await resuming;
    assert.equal(manager.getState().state, "idle");
    assert.equal(manager.getState().queueLength, 0);
    await manager.destroy();
  });

  test("destroy stops playback, clears work and closes the AudioContext", async () => {
    const context = new FakeAudioContext();
    const frames = new FakeFrames();
    const mouthValues: number[] = [];
    const manager = createManager(
      context,
      (async () => wavResponse()) as typeof fetch,
      frames,
      mouthValues,
    );
    manager.enqueue("破棄処理を確認します。");
    await settle();
    assert.equal(manager.getState().state, "playing");
    context.analyser.level = 0.1;
    frames.run();
    assert.ok(manager.getState().mouthOpen > 0);

    await manager.destroy();
    assert.equal(context.sources[0].stopped, true);
    assert.equal(context.state, "closed");
    assert.equal(manager.getState().state, "idle");
    assert.equal(manager.getState().queueLength, 0);
    assert.equal(manager.getState().audioContextState, "unavailable");
    assert.equal(manager.getState().mouthOpen, 0);
    assert.equal(mouthValues.at(-1), 0);
  });

  test("drives mouth opening only while a real source is playing and releases to zero", async () => {
    const context = new FakeAudioContext();
    const frames = new FakeFrames();
    const mouthValues: number[] = [];
    const manager = createManager(
      context,
      (async () => wavResponse()) as typeof fetch,
      frames,
      mouthValues,
    );

    context.analyser.level = 0.1;
    frames.run();
    assert.equal(mouthValues.length, 0);
    manager.enqueue("口型を確認します。");
    await settle();
    frames.run();
    assert.ok((mouthValues.at(-1) || 0) > 0);
    assert.ok(manager.getState().currentRms > 0);

    context.sources[0].finish();
    context.analyser.level = 0;
    await settle();
    for (let index = 0; index < 40; index += 1) frames.run(index * 16);
    assert.equal(mouthValues.at(-1), 0);
    assert.equal(manager.getState().state, "idle");
    await manager.destroy();
  });
});

test("legacy runtime wires preview and stop UI events with pagehide cleanup", () => {
  const source = readFileSync(path.join(process.cwd(), "assets", "app.js"), "utf8");
  assert.match(source, /addEventListener\("promptsoul:tts-preview",\s*handlePreview\)/u);
  assert.match(source, /addEventListener\("promptsoul:tts-stop",\s*handleStop\)/u);
  assert.match(source, /removeEventListener\("promptsoul:tts-preview",\s*handlePreview\)/u);
  assert.match(source, /removeEventListener\("promptsoul:tts-stop",\s*handleStop\)/u);
  assert.match(source, /event\?\.persisted/u);
  assert.match(source, /addEventListener\("pageshow",\s*handlePageShow\)/u);
  assert.match(source, /delete window\.PromptSoulTTS/u);
  assert.match(source, /await manager\.unlock\(\);[\s\S]*?manager\.appendStreamingText\(text/u);
  assert.match(source, /chatTtsRevision === state\.ttsPlaybackRevision/u);
  assert.match(source, /getUnstreamedReplyTail\(streamedTtsText, streamResult\.reply\)/u);
});
