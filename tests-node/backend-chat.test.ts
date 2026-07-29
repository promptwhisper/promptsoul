import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, describe, test } from "node:test";

import { POST as postChat } from "../app/api/chat/route";
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

const ORIGINAL_KEY = process.env.NPC_API_KEY;
const ORIGINAL_OPENAI_KEY = process.env.OPENAI_API_KEY;

function demoEnvironment(): void {
  delete process.env.NPC_API_KEY;
  delete process.env.OPENAI_API_KEY;
}

afterEach(() => {
  demoEnvironment();
  if (ORIGINAL_KEY !== undefined) process.env.NPC_API_KEY = ORIGINAL_KEY;
  if (ORIGINAL_OPENAI_KEY !== undefined) process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_KEY;
});
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "你是谁？", history: [] }),
    });
    const response = await postChat(request);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const result = await response.json() as Record<string, unknown>;
    assert.equal(result.mode, "demo");
    assert.equal(typeof result.reply, "string");

    process.env.NPC_API_KEY = "status-route-secret";
    const status = await getStatus();
    const text = await status.text();
    assert.equal(status.status, 200);
    assert.doesNotMatch(text, /status-route-secret/u);
    assert.equal((JSON.parse(text) as Record<string, unknown>).mode, "provider");
  });

  test("keeps JSON compatibility while exposing NDJSON completion events", async () => {
    demoEnvironment();
    const response = await postChat(new Request("http://127.0.0.1:8765/api/chat?stream=1", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
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
      headers: { "Content-Type": "text/plain" },
      body: "hello",
    }));
    assert.equal(wrongType.status, 415);
    assert.deepEqual(await wrongType.json(), {
      error: { code: "unsupported_media_type", message: "Content-Type must be application/json." },
    });

    const tooLarge = await postChat(new Request("http://localhost:8765/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "x".repeat(2_001) }),
    }));
    assert.equal(tooLarge.status, 413);
    assert.equal((await tooLarge.json() as { error: { code: string } }).error.code, "message_too_large");
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
