import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { POST as postChat } from "../app/api/chat/route";
import { GET as getStatus } from "../app/api/status/route";
import {
  chat,
  DEFAULT_PERSONA,
  parseModelResponse,
  validateChatPayload,
} from "../lib/server/chat-service";
import { resetRuntimeProviderSettings, setRuntimeProviderSettings } from "../lib/server/provider-store";

const ORIGINAL_KEY = process.env.NPC_API_KEY;
const ORIGINAL_OPENAI_KEY = process.env.OPENAI_API_KEY;

function demoEnvironment(): void {
  delete process.env.NPC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  resetRuntimeProviderSettings();
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
      source: "runtime" as const,
    };
    const fetchImpl = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: { reply: "角色回答", emotion: "invented" } } }],
    }), { status: 200 })) as typeof fetch;
    const result = await chat(
      { message: "你好" },
      { settings, persona: DEFAULT_PERSONA, provider: { fetchImpl } },
    );
    assert.deepEqual(result, { reply: "角色回答", emotion: "neutral", mode: "provider" });
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

    setRuntimeProviderSettings({
      apiKey: "status-route-secret",
      apiBase: "https://provider.test/v1",
      model: "gpt-5.6-luna",
    });
    const status = await getStatus();
    const text = await status.text();
    assert.equal(status.status, 200);
    assert.doesNotMatch(text, /status-route-secret/u);
    assert.equal((JSON.parse(text) as Record<string, unknown>).mode, "provider");
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
