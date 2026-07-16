import assert from "node:assert/strict";
import { inspect } from "node:util";
import { afterEach, describe, test } from "node:test";

import {
  callChatCompletions,
  ProviderRequestError,
} from "../lib/server/provider-client";
import {
  getProviderSettings,
  resetRuntimeProviderSettings,
  setRuntimeProviderSettings,
} from "../lib/server/provider-store";
import {
  DELETE as deleteProvider,
  GET as getProvider,
  POST as postProvider,
} from "../app/api/provider/route";

const ENV_NAMES = ["NPC_API_KEY", "OPENAI_API_KEY", "NPC_API_BASE", "NPC_MODEL"] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

function clearProviderEnvironment(): void {
  for (const name of ENV_NAMES) delete process.env[name];
}

function restoreProviderEnvironment(): void {
  for (const name of ENV_NAMES) {
    const value = ORIGINAL_ENV[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function localRequest(method: "POST" | "DELETE", body?: unknown, origin = "http://127.0.0.1:8765") {
  const headers: Record<string, string> = {
    Host: "127.0.0.1:8765",
    Origin: origin,
    "Sec-Fetch-Site": "same-origin",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new Request("http://127.0.0.1:8765/api/provider", {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

afterEach(() => {
  clearProviderEnvironment();
  resetRuntimeProviderSettings();
  restoreProviderEnvironment();
});

describe("in-memory provider settings", () => {
  test("uses gpt-5.6-luna defaults and never serializes or inspects the key", async () => {
    clearProviderEnvironment();
    resetRuntimeProviderSettings();
    const publicSettings = setRuntimeProviderSettings({
      apiKey: "test-super-secret",
      apiBase: "https://example.test/v1/",
      model: "gpt-5.6-luna",
    });
    const settings = getProviderSettings();

    assert.equal(settings.apiKey, "test-super-secret");
    assert.equal(settings.apiBase, "https://example.test/v1");
    assert.equal(publicSettings.mode, "provider");
    assert.equal(publicSettings.source, "runtime");
    assert.equal("apiKey" in publicSettings, false);
    assert.doesNotMatch(JSON.stringify(settings), /test-super-secret/u);
    assert.doesNotMatch(inspect(settings), /test-super-secret/u);
    assert.deepEqual(Object.keys(settings).sort(), ["apiBase", "model", "source"]);

    const response = await getProvider();
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /test-super-secret/u);
  });

  test("atomically replaces immutable snapshots and DELETE restores environment", async () => {
    clearProviderEnvironment();
    process.env.NPC_API_KEY = "environment-secret";
    process.env.NPC_API_BASE = "https://environment.test/v1";
    process.env.NPC_MODEL = "environment-model";
    resetRuntimeProviderSettings();

    const firstResponse = await postProvider(localRequest("POST", {
      apiKey: "runtime-first",
      apiBase: "https://runtime.test/v1",
      model: "runtime-model-1",
    }));
    assert.equal(firstResponse.status, 200);
    const first = getProviderSettings();

    const secondResponse = await postProvider(localRequest("POST", {
      apiKey: "runtime-second",
      apiBase: "https://runtime.test/v1",
      model: "runtime-model-2",
    }));
    assert.equal(secondResponse.status, 200);
    assert.equal(first.apiKey, "runtime-first");
    assert.equal(first.model, "runtime-model-1");
    assert.equal(getProviderSettings().apiKey, "runtime-second");
    assert.equal(Object.isFrozen(first), true);

    const deleted = await deleteProvider(localRequest("DELETE"));
    assert.equal(deleted.status, 200);
    const publicSettings = await deleted.json() as Record<string, unknown>;
    assert.equal(publicSettings.source, "environment");
    assert.equal(publicSettings.model, "environment-model");
    assert.equal(getProviderSettings().apiKey, "environment-secret");
    assert.doesNotMatch(JSON.stringify(publicSettings), /environment-secret/u);
  });

  test("accepts equivalent localhost and 127.0.0.1 authorities normalized by Next", async () => {
    clearProviderEnvironment();
    resetRuntimeProviderSettings();
    const request = new Request("http://localhost:8765/api/provider", {
      method: "POST",
      headers: {
        Host: "127.0.0.1:8765",
        Origin: "http://127.0.0.1:8765",
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        apiKey: "loopback-alias-key",
        apiBase: "http://127.0.0.1:18765/v1",
        model: "model-1",
      }),
    });
    const response = await postProvider(request);
    assert.equal(response.status, 200);
    assert.equal(getProviderSettings().source, "runtime");
  });

  test("rejects cross-origin, non-loopback, non-JSON, and malformed settings", async () => {
    clearProviderEnvironment();
    resetRuntimeProviderSettings();

    const crossOrigin = await postProvider(localRequest("POST", {
      apiKey: "safe-test-key",
      apiBase: "https://example.test/v1",
      model: "model-1",
    }, "https://evil.test"));
    assert.equal(crossOrigin.status, 403);

    const external = new Request("http://192.0.2.10:8765/api/provider", {
      method: "POST",
      headers: {
        Host: "192.0.2.10:8765",
        Origin: "http://192.0.2.10:8765",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ apiKey: "key", apiBase: "https://example.test/v1", model: "m" }),
    });
    assert.equal((await postProvider(external)).status, 403);

    const plainText = new Request("http://localhost:8765/api/provider", {
      method: "POST",
      headers: { Host: "localhost:8765", Origin: "http://localhost:8765", "Content-Type": "text/plain" },
      body: "{}",
    });
    assert.equal((await postProvider(plainText)).status, 415);

    for (const payload of [
      { apiKey: "contains space", apiBase: "https://example.test/v1", model: "m" },
      { apiKey: "key", apiBase: "https://user:pass@example.test/v1", model: "m" },
      { apiKey: "key", apiBase: "https://example.test/v1?token=x", model: "m" },
      { apiKey: "key", apiBase: "http://example.test/v1", model: "m" },
      { apiKey: "key", apiBase: "http://192.168.1.20/v1", model: "m" },
      { apiKey: "key", apiBase: "https://example.test/v1", model: "bad model" },
      { apiKey: "key", apiBase: "https://example.test/v1", model: "m", extra: true },
    ]) {
      const response = await postProvider(localRequest("POST", payload));
      assert.equal(response.status, 400);
      assert.equal((await response.json() as { error: { code: string } }).error.code, "invalid_provider_settings");
    }
    assert.equal(getProviderSettings().apiKey, null);
  });
});

describe("OpenAI-compatible Chat Completions client", () => {
  const settings = {
    apiKey: "provider-test-secret",
    apiBase: "https://provider.test/v1",
    model: "gpt-5.6-luna",
    source: "runtime" as const,
  };
  const messages = [{ role: "user" as const, content: "你好" }];

  test("sends a bounded non-streaming request and returns message content", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = input.toString();
      requestedInit = init;
      return new Response(JSON.stringify({ choices: [{ message: { content: "{\"reply\":\"嗨\",\"emotion\":\"happy\"}" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const content = await callChatCompletions(settings, messages, { fetchImpl });
    assert.equal(requestedUrl, "https://provider.test/v1/chat/completions");
    assert.equal(new Headers(requestedInit?.headers).get("authorization"), "Bearer provider-test-secret");
    assert.equal(requestedInit?.redirect, "error");
    assert.deepEqual(JSON.parse(String(requestedInit?.body)), {
      model: "gpt-5.6-luna",
      messages,
      stream: false,
    });
    assert.match(String(content), /happy/u);
  });

  test("maps provider authentication and timeout statuses without forwarding bodies", async () => {
    for (const [status, code] of [[401, "provider_auth_error"], [403, "provider_auth_error"], [408, "provider_timeout"], [504, "provider_timeout"]] as const) {
      const fetchImpl = (async () => new Response("upstream secret details", { status })) as typeof fetch;
      await assert.rejects(
        callChatCompletions(settings, messages, { fetchImpl }),
        (error: unknown) => {
          assert.ok(error instanceof ProviderRequestError);
          assert.equal(error.code, code);
          assert.doesNotMatch(error.message, /upstream secret details/u);
          return true;
        },
      );
    }
  });

  test("aborts timed-out calls and rejects oversized responses", async () => {
    const hangingFetch = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    })) as typeof fetch;
    await assert.rejects(
      callChatCompletions(settings, messages, { fetchImpl: hangingFetch, timeoutMs: 10 }),
      (error: unknown) => error instanceof ProviderRequestError && error.code === "provider_timeout",
    );

    const oversized = (async () => new Response("x".repeat(32), {
      status: 200,
      headers: { "Content-Length": "32" },
    })) as typeof fetch;
    await assert.rejects(
      callChatCompletions(settings, messages, { fetchImpl: oversized, maxResponseBytes: 16 }),
      (error: unknown) => error instanceof ProviderRequestError && error.code === "provider_response_invalid",
    );
  });
});
