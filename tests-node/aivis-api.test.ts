import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { GET as getOverallStatus } from "../app/api/status/route";
import { POST as postTts } from "../app/api/tts/route";
import { GET as getTtsStatus } from "../app/api/tts/status/route";
import { GET as getVoices } from "../app/api/tts/voices/route";
import { DEFAULT_AIVIS_SPEAKER_UUID, resetAivisServiceForTests } from "../lib/server/aivis-service";

const STYLE_ID = 888_753_761;
const ORIGINAL_FETCH = globalThis.fetch;
const ENV_NAMES = [
  "TTS_PROVIDER",
  "AIVIS_BASE_URL",
  "AIVIS_SPEAKER_UUID",
  "AIVIS_SPEAKER_NAME",
  "AIVIS_STYLE_NAME",
  "AIVIS_STYLE_ID",
  "TTS_MAX_TEXT_LENGTH",
  "TTS_CACHE_ENABLED",
] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

function waveBytes(): Uint8Array {
  const bytes = new Uint8Array(48);
  bytes.set(Buffer.from("RIFF", "ascii"), 0);
  new DataView(bytes.buffer).setUint32(4, 40, true);
  bytes.set(Buffer.from("WAVEfmt ", "ascii"), 8);
  new DataView(bytes.buffer).setUint32(16, 16, true);
  new DataView(bytes.buffer).setUint16(20, 1, true);
  new DataView(bytes.buffer).setUint16(22, 1, true);
  new DataView(bytes.buffer).setUint32(24, 24_000, true);
  new DataView(bytes.buffer).setUint32(28, 48_000, true);
  new DataView(bytes.buffer).setUint16(32, 2, true);
  new DataView(bytes.buffer).setUint16(34, 16, true);
  bytes.set(Buffer.from("data", "ascii"), 36);
  new DataView(bytes.buffer).setUint32(40, 4, true);
  return bytes;
}

function speakersDocument() {
  return [{
    name: "コハク",
    speaker_uuid: DEFAULT_AIVIS_SPEAKER_UUID,
    styles: [{ id: STYLE_ID, name: "あまあま", type: "talk" }],
    speaker_info: { portrait: "large-private-base64-must-not-leak" },
  }];
}

function localTtsRequest(body: unknown): Request {
  return new Request("http://127.0.0.1:8765/api/tts", {
    method: "POST",
    headers: {
      Host: "127.0.0.1:8765",
      Origin: "http://127.0.0.1:8765",
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function installHealthyEngine() {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push({ url, init });
    if (url.pathname === "/speakers") {
      return Response.json(speakersDocument());
    }
    if (url.pathname === "/audio_query") {
      assert.equal(url.searchParams.get("speaker"), String(STYLE_ID));
      assert.notEqual(url.searchParams.get("speaker"), "1");
      return Response.json({
        accent_phrases: [{ moras: [] }],
        speedScale: 1,
        pitchScale: 0,
        intonationScale: 1,
        tempoDynamicsScale: 1,
        volumeScale: 1,
        kana: "おかえりなさい。",
        futureEngineField: { preserved: true },
      });
    }
    if (url.pathname === "/synthesis") {
      assert.equal(url.searchParams.get("speaker"), String(STYLE_ID));
      const query = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.deepEqual(query.futureEngineField, { preserved: true });
      const audio = waveBytes();
      const body = new ArrayBuffer(audio.byteLength);
      new Uint8Array(body).set(audio);
      return new Response(body, { headers: { "Content-Type": "audio/wav" } });
    }
    throw new Error(`Unexpected Engine URL: ${url}`);
  }) as typeof fetch;
  return calls;
}

beforeEach(() => {
  process.env.TTS_PROVIDER = "aivis";
  process.env.AIVIS_BASE_URL = "http://127.0.0.1:10101";
  process.env.AIVIS_SPEAKER_UUID = DEFAULT_AIVIS_SPEAKER_UUID;
  process.env.AIVIS_SPEAKER_NAME = "コハク";
  process.env.AIVIS_STYLE_NAME = "あまあま";
  delete process.env.AIVIS_STYLE_ID;
  process.env.TTS_CACHE_ENABLED = "false";
  resetAivisServiceForTests();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const name of ENV_NAMES) {
    const value = ORIGINAL_ENV[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetAivisServiceForTests();
});

describe("AivisSpeech API routes", () => {
  test("returns sanitized voices, health, WAV audio, and aggregate status", async () => {
    const calls = installHealthyEngine();

    const voicesResponse = await getVoices();
    assert.equal(voicesResponse.status, 200);
    const voicesText = await voicesResponse.text();
    assert.doesNotMatch(voicesText, /portrait|base64/u);
    assert.deepEqual(JSON.parse(voicesText), {
      voices: [{
        speakerUuid: DEFAULT_AIVIS_SPEAKER_UUID,
        speakerName: "コハク",
        styles: [{ id: STYLE_ID, name: "あまあま" }],
      }],
    });

    const health = await getTtsStatus();
    assert.equal(health.status, 200);
    const healthPayload = await health.json() as Record<string, unknown>;
    assert.equal(typeof healthPayload.latencyMs, "number");
    assert.ok((healthPayload.latencyMs as number) >= 0);
    delete healthPayload.latencyMs;
    assert.deepEqual(healthPayload, {
      provider: "aivis",
      ready: true,
      engineReachable: true,
      voiceResolved: true,
      speakerName: "コハク",
      styleName: "あまあま",
      styleId: STYLE_ID,
      error: null,
    });

    const response = await postTts(localTtsRequest({
      text: "おかえりなさい。",
      options: { speedScale: 1.1, intonationScale: 1.2 },
    }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/wav");
    assert.equal(response.headers.get("x-tts-style-id"), String(STYLE_ID));
    assert.match(response.headers.get("x-tts-request-id") ?? "", /^[0-9a-f-]{36}$/u);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), waveBytes());

    const overall = await getOverallStatus();
    const overallPayload = await overall.json() as { tts: { ready: boolean; styleId: number } };
    assert.equal(overall.status, 200);
    assert.equal(overallPayload.tts.ready, true);
    assert.equal(overallPayload.tts.styleId, STYLE_ID);
    assert.ok(calls.some(({ url }) => url.pathname === "/audio_query"));
    assert.ok(calls.some(({ url }) => url.pathname === "/synthesis"));
  });

  test("rejects empty, oversized, and malformed requests", async () => {
    installHealthyEngine();
    assert.equal((await postTts(localTtsRequest({ text: "   " }))).status, 400);
    process.env.TTS_MAX_TEXT_LENGTH = "4";
    resetAivisServiceForTests();
    assert.equal((await postTts(localTtsRequest({ text: "これは長すぎます。" }))).status, 400);
    assert.equal((await postTts(localTtsRequest({ text: "短い", baseUrl: "http://evil.test" }))).status, 400);
  });

  test("rejects cross-origin browser requests before contacting AivisSpeech", async () => {
    const calls = installHealthyEngine();
    const response = await postTts(new Request("http://127.0.0.1:8765/api/tts", {
      method: "POST",
      headers: {
        Host: "127.0.0.1:8765",
        Origin: "https://evil.example",
        "Sec-Fetch-Site": "cross-site",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "読み上げないでください。" }),
    }));
    assert.equal(response.status, 403);
    const payload = await response.json() as { error: { code: string } };
    assert.equal(payload.error.code, "same_origin_required");
    assert.equal(calls.length, 0);
  });

  test("reports an unavailable Engine without blocking the text application", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("connection refused");
    }) as typeof fetch;
    const health = await getTtsStatus();
    const payload = await health.json() as { ready: boolean; error: { code: string } };
    assert.equal(health.status, 200);
    assert.equal(payload.ready, false);
    assert.equal(payload.error.code, "TTS_ENGINE_UNAVAILABLE");

    const response = await postTts(localTtsRequest({ text: "おかえりなさい。" }));
    assert.equal(response.status, 503);
    const error = await response.json() as { error: { code: string } };
    assert.equal(error.error.code, "TTS_ENGINE_UNAVAILABLE");

    const overall = await getOverallStatus();
    const overallPayload = await overall.json() as { mode: string; tts: { ready: boolean } };
    assert.equal(overall.status, 200);
    assert.equal(overallPayload.tts.ready, false);
    assert.ok(["demo", "provider"].includes(overallPayload.mode));
  });
});
