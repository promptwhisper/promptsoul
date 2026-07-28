import assert from "node:assert/strict";
import { createServer } from "node:http";
import { inspect } from "node:util";
import { afterEach, describe, test } from "node:test";

import { POST as postVoice } from "../app/api/voice/route";
import {
  DELETE as deleteVoiceSettings,
  GET as getVoiceSettingsRoute,
  POST as postVoiceSettings,
} from "../app/api/voice/settings/route";
import { synthesizeVoice } from "../lib/server/voice-service";
import {
  getVoiceSettings,
  resetRuntimeVoiceSettings,
  setRuntimeVoiceSettings,
} from "../lib/server/voice-store";

const ENV_NAMES = [
  "NPC_TTS_ENABLED",
  "NPC_TTS_API_KEY",
  "NPC_TTS_API_URL",
  "NPC_TTS_MODEL",
  "NPC_TTS_SPEAKER",
  "NPC_TTS_SPEED",
] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

function clearVoiceEnvironment(): void {
  for (const name of ENV_NAMES) delete process.env[name];
}

function restoreVoiceEnvironment(): void {
  for (const name of ENV_NAMES) {
    const value = ORIGINAL_ENV[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function settingsPayload(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    apiKey: "",
    apiUrl: "http://127.0.0.1:8880/v1/audio/speech",
    model: "kokoro",
    speaker: "af_heart",
    speed: 1,
    ...overrides,
  };
}

function localSettingsRequest(
  method: "POST" | "DELETE",
  body?: unknown,
  origin = "http://127.0.0.1:8765",
) {
  const headers: Record<string, string> = {
    Host: "127.0.0.1:8765",
    Origin: origin,
    "Sec-Fetch-Site": "same-origin",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new Request("http://127.0.0.1:8765/api/voice/settings", {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

afterEach(() => {
  clearVoiceEnvironment();
  resetRuntimeVoiceSettings();
  restoreVoiceEnvironment();
});

describe("in-memory voice settings", () => {
  test("keeps its independent key private and supports keyless local TTS", async () => {
    clearVoiceEnvironment();
    resetRuntimeVoiceSettings();
    const publicSettings = setRuntimeVoiceSettings(settingsPayload({
      apiKey: "voice-test-secret",
      apiUrl: "https://voice.example.test/v1/audio/speech/",
    }));
    const settings = getVoiceSettings();

    assert.equal(settings.apiKey, "voice-test-secret");
    assert.equal(settings.apiUrl, "https://voice.example.test/v1/audio/speech");
    assert.equal(publicSettings.mode, "voice");
    assert.equal(publicSettings.hasApiKey, true);
    assert.equal("apiKey" in publicSettings, false);
    assert.doesNotMatch(JSON.stringify(settings), /voice-test-secret/u);
    assert.doesNotMatch(inspect(settings), /voice-test-secret/u);

    const response = await getVoiceSettingsRoute();
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /voice-test-secret/u);

    const keyless = await postVoiceSettings(localSettingsRequest("POST", settingsPayload()));
    assert.equal(keyless.status, 200);
    assert.equal(getVoiceSettings().apiKey, null);
    assert.equal((await keyless.json() as { mode: string }).mode, "voice");
  });

  test("rejects cross-origin and unsafe remote HTTP settings, then resets to environment", async () => {
    clearVoiceEnvironment();
    process.env.NPC_TTS_ENABLED = "true";
    process.env.NPC_TTS_MODEL = "environment-tts";
    resetRuntimeVoiceSettings();

    const crossOrigin = await postVoiceSettings(localSettingsRequest(
      "POST",
      settingsPayload(),
      "https://evil.test",
    ));
    assert.equal(crossOrigin.status, 403);

    const unsafe = await postVoiceSettings(localSettingsRequest("POST", settingsPayload({
      apiUrl: "http://voice.example.test/v1/audio/speech",
    })));
    assert.equal(unsafe.status, 400);
    assert.equal(
      (await unsafe.json() as { error: { code: string } }).error.code,
      "invalid_voice_settings",
    );

    setRuntimeVoiceSettings(settingsPayload({ model: "runtime-tts" }));
    const reset = await deleteVoiceSettings(localSettingsRequest("DELETE"));
    assert.equal(reset.status, 200);
    assert.equal((await reset.json() as { model: string }).model, "environment-tts");
  });
});

describe("AITuber voice synthesis", () => {
  test("returns generated audio without changing the chat response contract", async () => {
    const wav = new TextEncoder().encode("RIFFxxxxWAVEfmt ");
    let screenplay: { text: string; emotion?: string } | undefined;
    const result = await synthesizeVoice(
      { text: "你好", emotion: "happy" },
      {
        settings: {
          enabled: true,
          apiKey: null,
          apiUrl: "http://127.0.0.1:8880/v1/audio/speech",
          model: "kokoro",
          speaker: "af_heart",
          speed: 1,
          source: "runtime",
        },
        createService: (_settings, onAudio) => ({
          speak: async (nextScreenplay) => {
            screenplay = nextScreenplay;
            await onAudio(wav.buffer);
          },
        }),
      },
    );
    assert.deepEqual(screenplay, { text: "你好", emotion: "happy" });
    assert.equal(result.contentType, "audio/wav");
    assert.equal(result.audio.byteLength, wav.byteLength);
  });

  test("fails closed when voice is disabled or request fields are invalid", async () => {
    clearVoiceEnvironment();
    resetRuntimeVoiceSettings();
    const disabled = await postVoice(new Request("http://127.0.0.1:8765/api/voice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "你好", emotion: "happy" }),
    }));
    assert.equal(disabled.status, 503);
    assert.equal(
      (await disabled.json() as { error: { code: string } }).error.code,
      "voice_disabled",
    );

    const invalid = await postVoice(new Request("http://127.0.0.1:8765/api/voice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "你好", emotion: "invented" }),
    }));
    assert.equal(invalid.status, 400);
    assert.equal(
      (await invalid.json() as { error: { code: string } }).error.code,
      "invalid_voice_emotion",
    );
  });

  test("uses the package's OpenAI-compatible voice engine", async () => {
    let requestBody = "";
    let authorization = "";
    const wav = new TextEncoder().encode("RIFFxxxxWAVEfmt ");
    const server = createServer((request, response) => {
      authorization = String(request.headers.authorization || "");
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        requestBody += chunk;
      });
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "audio/wav" });
        response.end(wav);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const result = await synthesizeVoice(
        { text: "AITuber 语音", emotion: "happy" },
        {
          settings: {
            enabled: true,
            apiKey: "voice-adapter-key",
            apiUrl: `http://127.0.0.1:${address.port}/v1/audio/speech`,
            model: "local-voice",
            speaker: "speaker-a",
            speed: 1.1,
            source: "runtime",
          },
        },
      );
      assert.equal(result.contentType, "audio/wav");
      assert.equal(authorization, "Bearer voice-adapter-key");
      assert.deepEqual(JSON.parse(requestBody), {
        model: "local-voice",
        input: "AITuber 语音",
        speed: 1.1,
        voice: "speaker-a",
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
