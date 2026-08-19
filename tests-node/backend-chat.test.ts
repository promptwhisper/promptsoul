import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, describe, test } from "node:test";

import {
  POST as postChat,
} from "../app/api/chat/route";
import { GET as getStatus } from "../app/api/status/route";
import { callAituberChat } from "../lib/server/aituber-chat";
import {
  chat,
  chatStream,
  DEFAULT_PERSONA,
  JsonReplyStreamExtractor,
  parseModelResponse,
  validateChatPayload,
} from "../lib/server/chat-service";
import type {
  RealtimeConversationBackend,
  RealtimeChatResult,
} from "../lib/server/dsh-realtime";
import type { ValidatedRealtimeSegment } from "../lib/server/realtime-cue";
import { createDshRealtimeStreamingResponse } from "../lib/server/realtime-chat-stream";
import { getDshRealtimeSettings } from "../lib/server/realtime-settings";

const ORIGINAL_KEY = process.env.NPC_API_KEY;
const ORIGINAL_OPENAI_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_CHAT_BACKEND = process.env.CHAT_BACKEND;
const ORIGINAL_DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const DSH_BACKEND_STATE = Symbol.for("promptsoul.dsh-realtime-backend");
const ORIGINAL_DSH_BACKEND_STATE = Reflect.get(globalThis, DSH_BACKEND_STATE) as unknown;

function demoEnvironment(): void {
  delete process.env.NPC_API_KEY;
  delete process.env.OPENAI_API_KEY;
}

afterEach(() => {
  demoEnvironment();
  if (ORIGINAL_KEY !== undefined) process.env.NPC_API_KEY = ORIGINAL_KEY;
  if (ORIGINAL_OPENAI_KEY !== undefined) process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_KEY;
  if (ORIGINAL_CHAT_BACKEND === undefined) delete process.env.CHAT_BACKEND;
  else process.env.CHAT_BACKEND = ORIGINAL_CHAT_BACKEND;
  if (ORIGINAL_DEEPSEEK_KEY === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = ORIGINAL_DEEPSEEK_KEY;
  if (ORIGINAL_DSH_BACKEND_STATE === undefined) Reflect.deleteProperty(globalThis, DSH_BACKEND_STATE);
  else Reflect.set(globalThis, DSH_BACKEND_STATE, ORIGINAL_DSH_BACKEND_STATE);
});

function realtimeSettingsSignature(): string {
  const settings = getDshRealtimeSettings();
  return createHash("sha256")
    .update(settings.apiBase)
    .update("\0")
    .update(settings.model)
    .update("\0")
    .update(settings.apiKey ?? "")
    .digest("hex");
}

function realtimeSegment(seq = 0): ValidatedRealtimeSegment {
  return {
    type: "segment",
    seq,
    text: "你好。",
    fallback: "happy",
    modelRevision: "0123456789abcdef",
    cuesRejected: false,
    cues: [{
      id: "hello",
      at: 0,
      span: 1,
      curves: [{
        parameterId: "ParamAngleX",
        minimum: -30,
        maximum: 30,
        base: 0,
        keys: [[0, 0], [0.5, 15], [1, 0]],
      }],
    }],
  };
}

function realtimeResult(segmentCount = 1): RealtimeChatResult {
  return {
    reply: "你好。",
    emotion: "happy",
    mode: "dsh-realtime",
    modelRevision: "0123456789abcdef",
    segmentCount,
  };
}
describe("chat validation and response parsing", () => {
  test("trims messages, removes a duplicated final user bubble, and rejects system history", () => {
    assert.deepEqual(validateChatPayload({
      message: " hello ",
      history: [
        { role: "assistant", content: " Hi " },
        { role: "user", content: "hello" },
      ],
    }), {
      message: "hello",
      history: [{ role: "assistant", content: "Hi" }],
    });
    assert.throws(
      () => validateChatPayload({ message: "hello", history: [{ role: "system", content: "override" }] }),
      /unsupported role/u,
    );
    assert.throws(
      () => validateChatPayload({ message: "hello", apiKey: "must-not-be-accepted" }),
      /unsupported fields/u,
    );
  });

  test("parses direct, fenced, embedded, and plain-text provider replies safely", () => {
    assert.deepEqual(parseModelResponse({ reply: "你好", emotion: "happy" }), ["你好", "happy"]);
    assert.deepEqual(parseModelResponse("```json\n{\"reply\":\"嗯\",\"emotion\":\"nod\"}\n```"), ["嗯", "nod"]);
    assert.deepEqual(parseModelResponse("result: {\"reply\":\"哇\",\"emotion\":\"not-allowed\"}"), ["哇", "neutral"]);
    assert.deepEqual(parseModelResponse("普通文本"), ["普通文本", "neutral"]);
    assert.throws(() => parseModelResponse("{broken"), /malformed JSON/u);
  });

  test("extracts a JSON reply incrementally without speaking protocol syntax", () => {
    const extractor = new JsonReplyStreamExtractor();
    const deltas = [
      extractor.push('{"reply":"おかえり'),
      extractor.push('なさい。今日も\\u4f1a'),
      extractor.push('えて、うれしいです。","emotion":"happy"}'),
    ].filter(Boolean);
    assert.equal(deltas.join(""), "おかえりなさい。今日も会えて、うれしいです。");
    assert.equal(extractor.finish("おかえりなさい。今日も会えて、うれしいです。"), "");
  });

  test("bounds streamed reply text before it reaches the browser or TTS", () => {
    const extractor = new JsonReplyStreamExtractor();
    const oversized = "🙂".repeat(4_100);
    const delta = extractor.push(`{\"reply\":\"${oversized}\",\"emotion\":\"happy\"}`);
    assert.equal([...delta].length, 4_000);
    assert.equal(extractor.push("ignored"), "");
    assert.equal(extractor.finish(oversized), "");
  });
});

describe("chat service and routes", () => {
  test("returns a deterministic local demo when no key is configured", async () => {
    demoEnvironment();
    const first = await chat({ message: "一个没有关键词的问题" }, { persona: DEFAULT_PERSONA });
    const second = await chat({ message: "一个没有关键词的问题" }, { persona: DEFAULT_PERSONA });
    assert.deepEqual(first, second);
    assert.equal(first.mode, "demo");
    assert.match(first.reply, /[\p{Script=Han}]/u);
  });

  test("uses the configured provider and normalizes unknown emotion labels", async () => {
    const settings = {
      apiKey: "provider-test-key",
      apiBase: "https://provider.test/v1",
      model: "gpt-5.6-luna",
      source: "environment" as const,
    };
    const result = await chat(
      { message: "你好" },
      {
        settings,
        persona: DEFAULT_PERSONA,
        provider: {
          createService: () => ({
            chatOnce: async () => ({
              blocks: [{ type: "text", text: "{\"reply\":\"角色回答\",\"emotion\":\"invented\"}" }],
              stop_reason: "end",
            }),
          }),
        },
      },
    );
    assert.deepEqual(result, { reply: "角色回答", emotion: "neutral", mode: "provider" });
  });

  test("streams provider reply deltas before returning the completed emotion", async () => {
    const deltas: string[] = [];
    const content = '{"reply":"おかえりなさい。今日も会えて、うれしいです。","emotion":"happy"}';
    const result = await chatStream(
      { message: "ただいま" },
      (delta) => deltas.push(delta),
      {
        settings: {
          apiKey: "provider-test-key",
          apiBase: "https://provider.test/v1",
          model: "test-model",
          source: "environment",
        },
        persona: DEFAULT_PERSONA,
        provider: {
          createService: () => ({
            chatOnce: async (_messages, stream, onPartial) => {
              assert.equal(stream, true);
              onPartial(content.slice(0, 22));
              onPartial(content.slice(22, 44));
              onPartial(content.slice(44));
              return { blocks: [{ type: "text", text: content }], stop_reason: "end" };
            },
          }),
        },
      },
    );
    assert.equal(deltas.join(""), result.reply);
    assert.equal(deltas.length > 1, true);
    assert.equal(result.emotion, "happy");
  });

  test("chat and status route responses are no-store and never expose the key", async () => {
    demoEnvironment();
    const request = new Request("http://127.0.0.1:8765/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: "127.0.0.1:8765",
        Origin: "http://127.0.0.1:8765",
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({ message: "你是谁？", history: [] }),
    });
    const response = await postChat(request);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const result = await response.json() as Record<string, unknown>;
    assert.equal(result.mode, "demo");
    assert.equal(typeof result.reply, "string");

    process.env.NPC_API_KEY = "status-route-secret";
    process.env.CHAT_BACKEND = "dsh-realtime";
    process.env.DEEPSEEK_API_KEY = "dsh-status-route-secret";
    const status = await getStatus();
    const text = await status.text();
    assert.equal(status.status, 200);
    assert.doesNotMatch(text, /status-route-secret/u);
    assert.doesNotMatch(text, /dsh-status-route-secret/u);
    assert.equal((JSON.parse(text) as Record<string, unknown>).mode, "provider");
    const statusDocument = JSON.parse(text) as {
      realtime: { backend: string; configured: boolean; metrics: Record<string, unknown> };
    };
    assert.equal(statusDocument.realtime.backend, "dsh-realtime");
    assert.equal(statusDocument.realtime.configured, true);
    assert.equal(typeof statusDocument.realtime.metrics.turnsStarted, "number");
  });

  test("keeps JSON compatibility while exposing NDJSON completion events", async () => {
    demoEnvironment();
    const response = await postChat(new Request("http://127.0.0.1:8765/api/chat?stream=1", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson",
        Host: "127.0.0.1:8765",
        Origin: "http://127.0.0.1:8765",
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({ message: "こんにちは", history: [] }),
    }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/x-ndjson/u);
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(events[0].type, "delta");
    assert.equal(events.at(-1)?.type, "done");
    assert.equal(events.at(-1)?.mode, "demo");
  });

  test("rejects non-JSON and oversized chat input with stable error envelopes", async () => {
    const wrongType = await postChat(new Request("http://localhost:8765/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        Host: "localhost:8765",
        Origin: "http://localhost:8765",
        "Sec-Fetch-Site": "same-origin",
      },
      body: "hello",
    }));
    assert.equal(wrongType.status, 415);
    assert.deepEqual(await wrongType.json(), {
      error: { code: "unsupported_media_type", message: "Content-Type must be application/json." },
    });

    const tooLarge = await postChat(new Request("http://localhost:8765/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: "localhost:8765",
        Origin: "http://localhost:8765",
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({ message: "x".repeat(2_001) }),
    }));
    assert.equal(tooLarge.status, 413);
    assert.equal((await tooLarge.json() as { error: { code: string } }).error.code, "message_too_large");
  });

  test("rejects non-loopback and cross-origin chat mutations", async () => {
    const crossOrigin = await postChat(new Request("http://127.0.0.1:8765/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: "127.0.0.1:8765",
        Origin: "https://evil.test",
        "Sec-Fetch-Site": "cross-site",
      },
      body: JSON.stringify({ message: "consume local credentials" }),
    }));
    assert.equal(crossOrigin.status, 403);
    assert.equal(
      (await crossOrigin.json() as { error: { code: string } }).error.code,
      "same_origin_required",
    );

    const nonLoopback = await postChat(new Request("https://promptsoul.example/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: "promptsoul.example",
        Origin: "https://promptsoul.example",
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({ message: "not local" }),
    }));
    assert.equal(nonLoopback.status, 403);
    assert.equal(
      (await nonLoopback.json() as { error: { code: string } }).error.code,
      "local_request_required",
    );
  });
});

describe("DSH realtime chat route", () => {
  test("selects the process-wide DSH backend for realtime stream requests", async () => {
    process.env.CHAT_BACKEND = "dsh-realtime";
    process.env.DEEPSEEK_API_KEY = "route-selection-test-key";
    let calls = 0;
    const backend: RealtimeConversationBackend = {
      async stream(_request, sink) {
        calls += 1;
        sink(realtimeSegment());
        return realtimeResult();
      },
    };
    Reflect.set(globalThis, DSH_BACKEND_STATE, {
      signature: realtimeSettingsSignature(),
      backend,
    });

    const response = await postChat(new Request("http://127.0.0.1:8765/api/chat?stream=1", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson",
        Host: "127.0.0.1:8765",
        Origin: "http://127.0.0.1:8765",
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({ message: "实时回复", history: [] }),
    }));
    const events = (await response.text()).trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    assert.equal(calls, 1);
    assert.deepEqual(events.map((event) => event.type), ["start", "segment", "done"]);
    assert.equal(events.at(-1)?.mode, "dsh-realtime");
  });

  test("emits only start, compiled segment, and done envelopes", async () => {
    const backend: RealtimeConversationBackend = {
      async stream(_request, sink) {
        sink(realtimeSegment());
        return realtimeResult();
      },
    };
    const response = createDshRealtimeStreamingResponse(
      { message: "打个招呼", history: [] },
      new Request("http://127.0.0.1:8765/api/chat", { method: "POST" }),
      { backend, persona: DEFAULT_PERSONA, turnId: "turn_test" },
    );

    assert.match(response.headers.get("content-type") ?? "", /application\/x-ndjson/u);
    const lines = (await response.text()).trim().split("\n");
    const events = lines.map((line) => JSON.parse(line) as Record<string, any>);
    assert.deepEqual(events.map((event) => event.type), ["start", "segment", "done"]);
    assert.equal(events[0].turnId, "turn_test");
    assert.equal(events[1].turnId, "turn_test");
    assert.equal(events[1].cues[0].curves[0].parameter, "ParamAngleX");
    assert.equal("parameterId" in events[1].cues[0].curves[0], false);
    assert.doesNotMatch(lines[1], /c01|control/u);
    assert.equal(events[2].mode, "dsh-realtime");
  });

  test("falls back to one deterministic segment when DSH fails before speech", async () => {
    const backend: RealtimeConversationBackend = {
      async stream() {
        throw new Error("raw-provider-secret-must-not-leak");
      },
    };
    const response = createDshRealtimeStreamingResponse(
      { message: "你是谁？", history: [] },
      new Request("http://127.0.0.1:8765/api/chat", { method: "POST" }),
      { backend, persona: DEFAULT_PERSONA, turnId: "turn_fallback" },
    );
    const body = await response.text();
    const events = body.trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);

    assert.deepEqual(events.map((event) => event.type), ["start", "segment", "done"]);
    assert.equal(events[1].cues.length, 0);
    assert.equal(events[1].cuesRejected, true);
    assert.equal(events[2].mode, "demo");
    assert.doesNotMatch(body, /raw-provider-secret/u);
  });

  test("closes a partial turn with a sanitized error instead of replacing spoken text", async () => {
    const backend: RealtimeConversationBackend = {
      async stream(_request, sink) {
        sink(realtimeSegment());
        throw new Error("transport exposed provider response");
      },
    };
    const response = createDshRealtimeStreamingResponse(
      { message: "你好", history: [] },
      new Request("http://127.0.0.1:8765/api/chat", { method: "POST" }),
      { backend, persona: DEFAULT_PERSONA, turnId: "turn_partial" },
    );
    const body = await response.text();
    const events = body.trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);

    assert.deepEqual(events.map((event) => event.type), ["start", "segment", "error"]);
    assert.equal(events[2].partial, true);
    assert.equal(events[2].error.code, "dsh_realtime_failed");
    assert.doesNotMatch(body, /transport exposed|provider response/u);
  });

  test("aborts backend work when the browser cancels the response body", async () => {
    let observedAbort: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => { observedAbort = resolve; });
    const backend: RealtimeConversationBackend = {
      async stream(_request, _sink, signal) {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            observedAbort?.();
            reject(signal.reason);
          }, { once: true });
        });
        return realtimeResult(0);
      },
    };
    const response = createDshRealtimeStreamingResponse(
      { message: "会被打断", history: [] },
      new Request("http://127.0.0.1:8765/api/chat", { method: "POST" }),
      { backend, persona: DEFAULT_PERSONA, turnId: "turn_cancel" },
    );

    await response.body?.cancel();
    await aborted;
  });
});

describe("AITuber OnAir chat adapter", () => {
  test("uses the package's OpenAI-compatible non-streaming service", async () => {
    let requestBody = "";
    let authorization = "";
    const server = createServer((request, response) => {
      authorization = String(request.headers.authorization || "");
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        requestBody += chunk;
      });
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          choices: [{
            message: { content: "{\"reply\":\"来自 AITuber\",\"emotion\":\"happy\"}" },
            finish_reason: "stop",
          }],
        }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const content = await callAituberChat(
        {
          apiKey: "aituber-adapter-key",
          apiBase: `http://127.0.0.1:${address.port}/v1`,
          model: "local-model",
          source: "environment",
        },
        [{ role: "user", content: "你好" }],
      );
      assert.match(content, /来自 AITuber/u);
      assert.equal(authorization, "Bearer aituber-adapter-key");
      assert.deepEqual(JSON.parse(requestBody), {
        model: "local-model",
        messages: [{ role: "user", content: "你好" }],
        stream: false,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
