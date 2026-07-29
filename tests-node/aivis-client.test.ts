import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import {
  AivisAudioCache,
  createAivisCacheKey,
  isRiffWave,
} from "../lib/server/aivis-cache";
import {
  AivisSpeechClient,
  applyAivisSynthesisOptions,
  validateAivisSynthesisOptions,
} from "../lib/server/aivis-client";
import { loadAivisTtsConfig } from "../lib/server/aivis-service";
import { AivisTtsError, type AivisClientConfig } from "../lib/server/aivis-types";

const SPEAKER_UUID = "5680ac39-43c9-487a-bc3e-018c0d29cc38";
const GLOBAL_STYLE_ID = 987_654_321;
const tempDirectories: string[] = [];

function pcmWave(dataBytes = 4, fill = 0): Uint8Array {
  const paddedDataBytes = dataBytes + (dataBytes % 2);
  const bytes = new Uint8Array(44 + paddedDataBytes);
  const view = new DataView(bytes.buffer);
  bytes.set(Buffer.from("RIFF", "ascii"), 0);
  view.setUint32(4, bytes.byteLength - 8, true);
  bytes.set(Buffer.from("WAVEfmt ", "ascii"), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 48_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(Buffer.from("data", "ascii"), 36);
  view.setUint32(40, dataBytes, true);
  bytes.fill(fill, 44, 44 + dataBytes);
  return bytes;
}

const WAV = pcmWave();

const SPEAKERS = [{
  name: "コハク",
  speaker_uuid: SPEAKER_UUID,
  styles: [
    { id: GLOBAL_STYLE_ID, name: "あまあま", type: "talk" },
    { id: GLOBAL_STYLE_ID + 1, name: "ノーマル", type: "talk" },
  ],
}];

function config(overrides: Partial<AivisClientConfig> = {}): AivisClientConfig {
  return {
    baseUrl: "http://127.0.0.1:10101",
    defaultVoice: {
      speakerUuid: SPEAKER_UUID,
      speakerName: "コハク",
      styleName: "あまあま",
    },
    maxTextLength: 500,
    timeouts: { connectMs: 100, queryMs: 100, synthesisMs: 100 },
    ...overrides,
  };
}

function jsonResponse(document: unknown, status = 200): Response {
  return Response.json(document, { status });
}

function wavResponse(bytes = WAV, contentType = "audio/wav"): Response {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, { headers: { "Content-Type": contentType } });
}

function mockEngine(options: {
  speakers?: unknown;
  onAudioQuery?: (url: URL) => Response | Promise<Response>;
  onSynthesis?: (url: URL, init?: RequestInit) => Response | Promise<Response>;
} = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    if (url.pathname === "/speakers") return jsonResponse(options.speakers ?? SPEAKERS);
    if (url.pathname === "/audio_query") {
      return options.onAudioQuery?.(url) ?? jsonResponse({
        accent_phrases: [{ moras: [] }],
        speedScale: 1,
        pitchScale: 0,
        intonationScale: 1,
        tempoDynamicsScale: 1,
        volumeScale: 1,
        kana: "テスト",
        engineFutureField: { keep: true },
      });
    }
    if (url.pathname === "/synthesis") {
      return options.onSynthesis?.(url, init) ?? wavResponse();
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

async function temporaryCache(enabled = true): Promise<AivisAudioCache> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "promptsoul-aivis-test-"));
  tempDirectories.push(directory);
  return new AivisAudioCache({ enabled, directory, maxBytes: 1024 * 1024 });
}

function hangingFetch(): typeof fetch {
  return ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  })) as typeof fetch;
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("AivisSpeech voice discovery", () => {
  test("parses /speakers, caches it for 60 seconds, and resolves UUID plus style name", async () => {
    let requests = 0;
    let now = 1_000;
    const fetchImpl = (async () => {
      requests += 1;
      return jsonResponse(SPEAKERS);
    }) as typeof fetch;
    const client = new AivisSpeechClient(config(), { fetchImpl, now: () => now });

    const voice = await client.resolveVoice();
    assert.deepEqual(voice, {
      speakerUuid: SPEAKER_UUID,
      speakerName: "コハク",
      styleName: "あまあま",
      styleId: GLOBAL_STYLE_ID,
    });
    await client.getSpeakers();
    assert.equal(requests, 1);
    now += 60_001;
    await client.getSpeakers();
    assert.equal(requests, 2);
  });

  test("uses normalized speaker-name fallback only when UUID is absent", async () => {
    const client = new AivisSpeechClient(config({
      defaultVoice: { speakerName: "  ｺﾊｸ  ", styleName: " あまあま " },
    }), { fetchImpl: mockEngine({
      speakers: [{ ...SPEAKERS[0], name: "コハク" }],
    }) });
    assert.equal((await client.resolveVoice()).styleId, GLOBAL_STYLE_ID);

    const normalized = new AivisSpeechClient(config({
      defaultVoice: { speakerName: "  コハク  ", styleName: " あまあま " },
    }), { fetchImpl: mockEngine() });
    assert.equal((await normalized.resolveVoice()).styleId, GLOBAL_STYLE_ID);
  });

  test("lets an explicit speaker name replace the configured default UUID", async () => {
    const client = new AivisSpeechClient(config(), { fetchImpl: mockEngine({
      speakers: [SPEAKERS[0], {
        name: "別の声",
        speaker_uuid: "another-speaker-uuid",
        styles: [{ id: GLOBAL_STYLE_ID + 20, name: "あまあま" }],
      }],
    }) });
    assert.deepEqual(await client.resolveVoice({
      speakerName: "別の声",
      styleName: "あまあま",
    }), {
      speakerUuid: "another-speaker-uuid",
      speakerName: "別の声",
      styleName: "あまあま",
      styleId: GLOBAL_STYLE_ID + 20,
    });
  });

  test("re-resolves the global Style ID when a request overrides the configured voice", async () => {
    const client = new AivisSpeechClient(config({
      defaultVoice: {
        speakerUuid: SPEAKER_UUID,
        speakerName: "コハク",
        styleName: "あまあま",
        styleId: GLOBAL_STYLE_ID,
      },
    }), { fetchImpl: mockEngine({
      speakers: [SPEAKERS[0], {
        name: "別の声",
        speaker_uuid: "another-speaker-uuid",
        styles: [{ id: GLOBAL_STYLE_ID + 20, name: "あまあま" }],
      }],
    }) });

    assert.equal((await client.resolveVoice({
      speakerName: "別の声",
      styleName: "あまあま",
    })).styleId, GLOBAL_STYLE_ID + 20);
    assert.equal((await client.resolveVoice({
      styleName: "ノーマル",
    })).styleId, GLOBAL_STYLE_ID + 1);
  });

  test("validates an explicit global Style ID against its speaker and style", async () => {
    const exact = new AivisSpeechClient(config({
      defaultVoice: {
        speakerUuid: SPEAKER_UUID,
        styleName: "あまあま",
        styleId: GLOBAL_STYLE_ID,
      },
    }), { fetchImpl: mockEngine() });
    assert.equal((await exact.resolveVoice()).styleId, GLOBAL_STYLE_ID);

    const wrongStyle = new AivisSpeechClient(config({
      defaultVoice: {
        speakerUuid: SPEAKER_UUID,
        styleName: "ノーマル",
        styleId: GLOBAL_STYLE_ID,
      },
    }), { fetchImpl: mockEngine() });
    await assert.rejects(
      wrongStyle.resolveVoice(),
      (error: unknown) => error instanceof AivisTtsError && error.code === "TTS_VOICE_NOT_FOUND",
    );
  });

  test("returns installed candidates when a voice is missing and rejects ambiguity", async () => {
    const missing = new AivisSpeechClient(config({
      defaultVoice: { speakerUuid: "missing", styleName: "あまあま" },
    }), { fetchImpl: mockEngine() });
    await assert.rejects(missing.resolveVoice(), (error: unknown) => {
      assert.ok(error instanceof AivisTtsError);
      assert.equal(error.code, "TTS_VOICE_NOT_FOUND");
      assert.equal(error.details?.availableVoices?.[0]?.speakerName, "コハク");
      return true;
    });

    const ambiguous = new AivisSpeechClient(config({
      defaultVoice: { speakerName: "コハク", styleName: "あまあま" },
    }), { fetchImpl: mockEngine({
      speakers: [SPEAKERS[0], {
        ...SPEAKERS[0],
        speaker_uuid: "another-speaker-uuid",
        styles: [{ id: GLOBAL_STYLE_ID + 20, name: "あまあま" }],
      }],
    }) });
    await assert.rejects(
      ambiguous.resolveVoice(),
      (error: unknown) => error instanceof AivisTtsError && error.code === "TTS_VOICE_AMBIGUOUS",
    );
  });

  test("refreshes a cached speaker catalog once when resolution fails", async () => {
    let requests = 0;
    const fetchImpl = (async () => {
      requests += 1;
      return jsonResponse(requests === 1 ? SPEAKERS : [{
        ...SPEAKERS[0],
        styles: [...SPEAKERS[0].styles, { id: GLOBAL_STYLE_ID + 2, name: "ささやき" }],
      }]);
    }) as typeof fetch;
    const client = new AivisSpeechClient(config(), { fetchImpl });
    await client.resolveVoice();
    const refreshed = await client.resolveVoice({ styleName: "ささやき" });
    assert.equal(refreshed.styleId, GLOBAL_STYLE_ID + 2);
    assert.equal(requests, 2);
  });
});

describe("AivisSpeech HTTP and AudioQuery handling", () => {
  test("uses the resolved global Style ID for both requests and preserves unknown query fields", async () => {
    const requests: URL[] = [];
    let synthesisBody: Record<string, unknown> | undefined;
    const client = new AivisSpeechClient(config({
      defaultOptions: {
        speedScale: 1.1,
        intonationScale: 1.4,
        tempoDynamicsScale: 0.8,
        volumeScale: 1.2,
      },
    }), { fetchImpl: mockEngine({
      onAudioQuery: (url) => {
        requests.push(url);
        return jsonResponse({
          accent_phrases: [{ moras: [{ text: "オ" }] }],
          speedScale: 1,
          pitchScale: -0.05,
          intonationScale: 1,
          tempoDynamicsScale: 1,
          volumeScale: 1,
          pauseLength: null,
          kana: "オカエリ",
          futureField: { retained: true },
        });
      },
      onSynthesis: (url, init) => {
        requests.push(url);
        synthesisBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return wavResponse();
      },
    }) });
    await client.synthesizeText("おかえりなさい。");

    assert.deepEqual(requests.map((url) => url.searchParams.get("speaker")), [
      String(GLOBAL_STYLE_ID),
      String(GLOBAL_STYLE_ID),
    ]);
    assert.equal(synthesisBody?.speedScale, 1.1);
    assert.equal(synthesisBody?.intonationScale, 1.4);
    assert.equal(synthesisBody?.tempoDynamicsScale, 0.8);
    assert.equal(synthesisBody?.volumeScale, 1.2);
    assert.equal(synthesisBody?.pitchScale, -0.05);
    assert.equal(synthesisBody?.pauseLength, null);
    assert.deepEqual(synthesisBody?.futureField, { retained: true });
    assert.deepEqual(synthesisBody?.accent_phrases, [{ moras: [{ text: "オ" }] }]);
  });

  test("refreshes and retries once when a cached dynamic Style ID becomes stale", async () => {
    let currentStyleId = GLOBAL_STYLE_ID;
    let speakerRequests = 0;
    const queryStyleIds: number[] = [];
    const client = new AivisSpeechClient(config(), { fetchImpl: (async (
      input: string | URL | Request,
    ) => {
      const url = new URL(input.toString());
      if (url.pathname === "/speakers") {
        speakerRequests += 1;
        return jsonResponse([{
          ...SPEAKERS[0],
          styles: [{ id: currentStyleId, name: "あまあま" }],
        }]);
      }
      if (url.pathname === "/audio_query") {
        const requestedStyleId = Number(url.searchParams.get("speaker"));
        queryStyleIds.push(requestedStyleId);
        return requestedStyleId === currentStyleId
          ? jsonResponse({ speedScale: 1, pitchScale: 0 })
          : jsonResponse({ error: "speaker not found" }, 404);
      }
      if (url.pathname === "/synthesis") return wavResponse();
      return new Response(null, { status: 404 });
    }) as typeof fetch });

    await client.synthesizeText("最初の文章です。");
    currentStyleId = GLOBAL_STYLE_ID + 100;
    const refreshed = await client.synthesizeText("次の文章です。");

    assert.equal(refreshed.voice.styleId, GLOBAL_STYLE_ID + 100);
    assert.equal(speakerRequests, 2);
    assert.deepEqual(queryStyleIds, [
      GLOBAL_STYLE_ID,
      GLOBAL_STYLE_ID,
      GLOBAL_STYLE_ID + 100,
    ]);
  });

  test("revalidates but never replaces an explicit stale Style ID", async () => {
    let currentStyleId = GLOBAL_STYLE_ID;
    let speakerRequests = 0;
    const queryStyleIds: number[] = [];
    const client = new AivisSpeechClient(config({
      defaultVoice: {
        speakerUuid: SPEAKER_UUID,
        styleName: "あまあま",
        styleId: GLOBAL_STYLE_ID,
      },
    }), { fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      if (url.pathname === "/speakers") {
        speakerRequests += 1;
        return jsonResponse([{
          ...SPEAKERS[0],
          styles: [{ id: currentStyleId, name: "あまあま" }],
        }]);
      }
      if (url.pathname === "/audio_query") {
        const requestedStyleId = Number(url.searchParams.get("speaker"));
        queryStyleIds.push(requestedStyleId);
        return jsonResponse({ error: "speaker not found" }, 404);
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch });

    await client.resolveVoice();
    currentStyleId = GLOBAL_STYLE_ID + 100;
    await assert.rejects(
      client.synthesizeText("明示 ID は置き換えません。"),
      (error: unknown) => error instanceof AivisTtsError && error.code === "TTS_VOICE_NOT_FOUND",
    );
    assert.equal(speakerRequests, 2);
    assert.deepEqual(queryStyleIds, [GLOBAL_STYLE_ID]);
  });

  test("validates synthesis parameter bounds without changing pitch or pauses", () => {
    assert.deepEqual(applyAivisSynthesisOptions({
      pitchScale: -0.1,
      pauseLength: 0.3,
      pauseLengthScale: 1.1,
      unknown: true,
    }, { intonationScale: 2, tempoDynamicsScale: 0, speedScale: 0.5, volumeScale: 2 }), {
      pitchScale: -0.1,
      pauseLength: 0.3,
      pauseLengthScale: 1.1,
      unknown: true,
      intonationScale: 2,
      tempoDynamicsScale: 0,
      speedScale: 0.5,
      volumeScale: 2,
    });
    for (const options of [
      { speedScale: 0.49 },
      { speedScale: 2.01 },
      { intonationScale: -0.01 },
      { intonationScale: 2.01 },
      { tempoDynamicsScale: Number.NaN },
      { volumeScale: Number.POSITIVE_INFINITY },
    ]) {
      assert.throws(
        () => validateAivisSynthesisOptions(options),
        (error: unknown) => error instanceof AivisTtsError && error.code === "TTS_INVALID_REQUEST",
      );
    }
  });

  test("maps unreachable and independently timed-out engine stages", async () => {
    const unavailable = new AivisSpeechClient(config(), {
      fetchImpl: (async () => { throw new TypeError("connection refused"); }) as typeof fetch,
    });
    await assert.rejects(
      unavailable.getSpeakers(),
      (error: unknown) => error instanceof AivisTtsError && error.code === "TTS_ENGINE_UNAVAILABLE",
    );

    const queryTimeout = new AivisSpeechClient(config({
      timeouts: { connectMs: 100, queryMs: 5, synthesisMs: 100 },
    }), { fetchImpl: mockEngine({ onAudioQuery: () => hangingFetch()(new URL("http://test")) }) });
    await assert.rejects(
      queryTimeout.createAudioQuery("テスト", GLOBAL_STYLE_ID),
      (error: unknown) => error instanceof AivisTtsError
        && error.code === "TTS_ENGINE_TIMEOUT"
        && error.details?.stage === "audio_query",
    );

    const synthesisTimeout = new AivisSpeechClient(config({
      timeouts: { connectMs: 100, queryMs: 100, synthesisMs: 5 },
    }), { fetchImpl: mockEngine({ onSynthesis: (_url, init) => hangingFetch()(new URL("http://test"), init) }) });
    await assert.rejects(
      synthesisTimeout.synthesize({ speedScale: 1 }, GLOBAL_STYLE_ID),
      (error: unknown) => error instanceof AivisTtsError
        && error.code === "TTS_ENGINE_TIMEOUT"
        && error.details?.stage === "synthesis",
    );

    const stalledBody = new AivisSpeechClient(config({
      timeouts: { connectMs: 100, queryMs: 5, synthesisMs: 100 },
    }), { fetchImpl: mockEngine({
      onAudioQuery: () => new Response(new ReadableStream({
        pull: () => new Promise<void>(() => undefined),
      }), { headers: { "Content-Type": "application/json" } }),
    }) });
    await assert.rejects(
      stalledBody.createAudioQuery("テスト", GLOBAL_STYLE_ID),
      (error: unknown) => error instanceof AivisTtsError
        && error.code === "TTS_ENGINE_TIMEOUT"
        && error.details?.stage === "audio_query",
    );
  });

  test("rejects HTML, JSON, empty, and malformed synthesis responses as invalid audio", async () => {
    const headerOnly = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00,
      0x57, 0x41, 0x56, 0x45,
    ]);
    const emptyData = pcmWave(0);
    const truncated = pcmWave();
    new DataView(truncated.buffer).setUint32(40, 100, true);
    for (const createResponse of [
      () => new Response("<html>error</html>", { headers: { "Content-Type": "text/html" } }),
      () => jsonResponse({ error: "failed" }),
      () => wavResponse(new Uint8Array()),
      () => wavResponse(new TextEncoder().encode("not a wave")),
      () => wavResponse(headerOnly),
      () => wavResponse(emptyData),
      () => wavResponse(truncated),
    ]) {
      const client = new AivisSpeechClient(config(), {
        fetchImpl: mockEngine({ onSynthesis: createResponse }),
      });
      await assert.rejects(
        client.synthesize({ speedScale: 1 }, GLOBAL_STYLE_ID),
        (error: unknown) => error instanceof AivisTtsError && error.code === "TTS_INVALID_AUDIO",
      );
    }
    assert.equal(isRiffWave(WAV), true);
  });

  test("health reports engine reachability separately from voice resolution", async () => {
    const client = new AivisSpeechClient(config({
      defaultVoice: { speakerUuid: SPEAKER_UUID, styleName: "missing" },
    }), { fetchImpl: mockEngine() });
    const health = await client.healthCheck();
    assert.equal(health.ready, false);
    assert.equal(health.engineReachable, true);
    assert.equal(health.voiceResolved, false);
    assert.equal(health.error?.code, "TTS_VOICE_NOT_FOUND");
  });
});

describe("AivisSpeech bounded audio cache", () => {
  test("hits disk cache and coalesces concurrent requests for the same key", async () => {
    const cache = await temporaryCache();
    let queryCount = 0;
    let synthesisCount = 0;
    const client = new AivisSpeechClient(config(), {
      cache,
      fetchImpl: mockEngine({
        onAudioQuery: () => {
          queryCount += 1;
          return jsonResponse({ speedScale: 1, pitchScale: 0, futureField: true });
        },
        onSynthesis: async () => {
          synthesisCount += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return wavResponse();
        },
      }),
    });
    await client.resolveVoice();
    const [first, joined] = await Promise.all([
      client.synthesizeText("同じ文章です。"),
      client.synthesizeText("同じ文章です。"),
    ]);
    const hit = await client.synthesizeText("同じ文章です。");

    assert.equal(first.cache, "miss");
    assert.equal(joined.cache, "miss");
    assert.equal(hit.cache, "hit");
    assert.equal(queryCount, 1);
    assert.equal(synthesisCount, 1);
    assert.deepEqual(first.audio, WAV);
  });

  test("re-prunes concurrent different keys and removes stale temporary files", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "promptsoul-aivis-cache-prune-"));
    tempDirectories.push(directory);
    const maxBytes = 70_000;
    const cache = new AivisAudioCache({ enabled: true, directory, maxBytes });
    const audio = pcmWave(65_492, 0x2a);
    const staleTemporary = path.join(
      directory,
      `.${"a".repeat(64)}.${process.pid}.00000000-0000-4000-8000-000000000000.tmp`,
    );
    await writeFile(staleTemporary, audio);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    await utimes(staleTemporary, old, old);

    await Promise.all(Array.from({ length: 20 }, (_, index) => cache.getOrCreate(
      createAivisCacheKey({ index }),
      async () => audio,
    )));

    const names = await readdir(directory);
    const cacheFiles = names.filter((name) => /^[a-f0-9]{64}\.wav$/u.test(name));
    const totalBytes = (await Promise.all(cacheFiles.map(async (name) => (
      (await stat(path.join(directory, name))).size
    )))).reduce((sum, size) => sum + size, 0);
    assert.ok(totalBytes <= maxBytes, `${totalBytes} cache bytes exceed ${maxBytes}`);
    assert.equal(names.includes(path.basename(staleTemporary)), false);
  });

  test("uses environment defaults without accepting a client-provided base URL", () => {
    const loaded = loadAivisTtsConfig({
      TTS_PROVIDER: "aivis",
      AIVIS_BASE_URL: "http://127.0.0.1:10101",
      AIVIS_SPEAKER_UUID: SPEAKER_UUID,
      AIVIS_SPEAKER_NAME: "コハク",
      AIVIS_STYLE_NAME: "あまあま",
      AIVIS_STYLE_ID: String(GLOBAL_STYLE_ID),
      AIVIS_SPEED_SCALE: "1.1",
      TTS_CACHE_ENABLED: "false",
    }, "/tmp/promptsoul-test");
    assert.equal(loaded.defaultVoice.styleId, GLOBAL_STYLE_ID);
    assert.equal(loaded.defaultOptions?.speedScale, 1.1);
    assert.equal(loaded.cache.enabled, false);
    assert.equal(loaded.cache.directory, "/tmp/promptsoul-test/.cache/aivis-tts");

    const nameFallback = loadAivisTtsConfig({ AIVIS_SPEAKER_UUID: "" });
    assert.equal(nameFallback.defaultVoice.speakerUuid, undefined);
    assert.equal(nameFallback.defaultVoice.speakerName, "コハク");

    assert.throws(
      () => new AivisSpeechClient(config({ baseUrl: "http://example.test:10101" })),
      (error: unknown) => error instanceof AivisTtsError && error.code === "TTS_INVALID_REQUEST",
    );
  });
});
