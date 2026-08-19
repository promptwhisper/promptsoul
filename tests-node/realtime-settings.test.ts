import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  getDshRealtimeSettings,
  toPublicDshRealtimeSettings,
} from "../lib/server/realtime-settings";

test("keeps the existing provider path unless the exact DSH switch is enabled", () => {
  const settings = getDshRealtimeSettings({
    CHAT_BACKEND: "typo",
    DEEPSEEK_API_KEY: "ignored-key",
    DEEPSEEK_BASE_URL: "not a URL",
    DSH_MODEL: "invalid model name",
  });
  assert.deepEqual(toPublicDshRealtimeSettings(settings), {
    backend: "provider",
    configured: false,
    model: "deepseek-v4-flash",
    apiBase: "https://api.deepseek.com",
  });
  assert.equal(settings.apiKey, null);
});

test("validates DSH-only credentials, HTTPS endpoint, and model when enabled", () => {
  const settings = getDshRealtimeSettings({
    CHAT_BACKEND: " DSH-REALTIME ",
    DEEPSEEK_API_KEY: "server-only-key",
    DEEPSEEK_BASE_URL: "https://gateway.example/v1/",
    DSH_MODEL: "deepseek-v4-flash",
  });
  assert.equal(settings.apiKey, "server-only-key");
  assert.doesNotMatch(JSON.stringify(settings), /server-only-key/u);
  assert.deepEqual(toPublicDshRealtimeSettings(settings), {
    backend: "dsh-realtime",
    configured: true,
    model: "deepseek-v4-flash",
    apiBase: "https://gateway.example/v1",
  });
  assert.throws(
    () => getDshRealtimeSettings({
      CHAT_BACKEND: "dsh-realtime",
      DEEPSEEK_BASE_URL: "http://remote.example/v1",
    }),
    /must use HTTPS/u,
  );
});

test("never exposes the DSH API key through the public status shape", () => {
  const settings = getDshRealtimeSettings({
    CHAT_BACKEND: "dsh-realtime",
    DEEPSEEK_API_KEY: "never-serialize-this",
  });
  assert.doesNotMatch(JSON.stringify(toPublicDshRealtimeSettings(settings)), /never-serialize/u);
});

test("the example environment keeps DSH opt-in", () => {
  const source = readFileSync(path.join(process.cwd(), ".env.example"), "utf8");
  assert.doesNotMatch(source, /^CHAT_BACKEND=dsh-realtime$/mu);
  assert.match(source, /^# CHAT_BACKEND=dsh-realtime$/mu);
});
