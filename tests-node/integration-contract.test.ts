import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { POST as postMotion } from "../app/api/motions/generate/route";
import { DELETE as deleteMotionRoute } from "../app/api/motions/[motionId]/route";
import { deleteMotion, generateMotion, motionCapabilities } from "../lib/server/motion-api";

const ORIGINAL_NPC_KEY = process.env.NPC_API_KEY;
const ORIGINAL_OPENAI_KEY = process.env.OPENAI_API_KEY;

function clearKeys(): void {
  delete process.env.NPC_API_KEY;
  delete process.env.OPENAI_API_KEY;
}

afterEach(() => {
  clearKeys();
  if (ORIGINAL_NPC_KEY !== undefined) process.env.NPC_API_KEY = ORIGINAL_NPC_KEY;
  if (ORIGINAL_OPENAI_KEY !== undefined) process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_KEY;
});

test("the browser chat request stays aligned with the strict server contract", () => {
  const source = readFileSync(path.join(process.cwd(), "assets", "app.js"), "utf8");
  assert.match(
    source,
    /body:\s*JSON\.stringify\(\{\s*message,\s*history,\s*\}\),\s*signal:/u,
  );
  const requestBlock = source.match(
    /fetch\(state\.config\.apiEndpoint[\s\S]*?signal:\s*controller\.signal/u,
  )?.[0] ?? "";
  assert.doesNotMatch(requestBlock, /\bnpc\s*:/u);
});

test("the browser Aivis request stays same-origin and drives only runtime mouth parameters", () => {
  const source = readFileSync(path.join(process.cwd(), "assets", "app.js"), "utf8");
  const playback = readFileSync(
    path.join(process.cwd(), "lib", "shared", "browser-tts.ts"),
    "utf8",
  );
  assert.match(source, /const TTS_SYNTHESIS_ENDPOINT = "\/api\/tts"/u);
  assert.match(
    playback,
    /this\.fetchImpl\(this\.endpoint,[\s\S]*?body:\s*JSON\.stringify\(\{ text: item\.text/u,
  );
  assert.match(playback, /context\.createBufferSource\(\)/u);
  assert.match(playback, /source\.connect\(this\.analyser\)/u);
  assert.match(playback, /source\.onended\s*=\s*\(\)\s*=>\s*resolve\(\)/u);
  assert.match(playback, /getFloatTimeDomainData\(this\.samples\)/u);
  assert.match(playback, /calculateRms\(this\.samples\)/u);
  assert.match(source, /settings\?\.getLipSyncParameters\?\.\(\)/u);
  assert.match(source, /internalModel\.on\("beforeModelUpdate",\s*updateMouth\)/u);
  assert.match(source, /index\s*>=\s*count/u);
  assert.match(source, /setParameterValueByIndex\(index,\s*normalized\)/u);
  assert.match(source, /getParameterValueByIndex\(index\)/u);
  assert.match(source, /mouthOpen:\s*state\.appliedLipSyncValue/u);
  assert.match(source, /lipSyncParameterIds:\s*\[\.\.\.state\.lipSyncParameterIds\]/u);
  assert.match(source, /mouthEvidence:\s*state\.lipSyncParameterReadbackVerified/u);
  assert.match(source, /artMeshDeformationVerified:\s*false/u);
  assert.match(source, /const revision = \+\+state\.ttsStatusRevision/u);
  assert.match(source, /const streamTtsEnabled = state\.ttsEnabled/u);
  assert.doesNotMatch(`${source}\n${playback}`, /speechSynthesis|SpeechSynthesisUtterance/u);
  assert.doesNotMatch(playback, /localStorage|sessionStorage|document\.cookie|127\.0\.0\.1:10101/u);
});

test("build configuration never bundles licensed local models into standalone output", () => {
  const config = readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8");
  assert.doesNotMatch(config, /output\s*:\s*["']standalone["']/u);
  for (const protectedPath of [
    "./models/**/*",
    "./local-assets/**/*",
    "./model.config.json",
    "./motion-defs/generated/**/*",
  ]) {
    assert.match(config, new RegExp(protectedPath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  const runtime = readFileSync(
    path.join(process.cwd(), "components", "legacy-runtime.tsx"),
    "utf8",
  );
  assert.equal(runtime.match(/integrity:\s*["']sha384-/gu)?.length, 3);
});

test("motion mutation route rejects cross-origin requests and no-provider generation", async () => {
  clearKeys();
  const payload = JSON.stringify({ prompt: "轻轻点头再回到原位" });
  const crossOrigin = await postMotion(new Request("http://127.0.0.1:8765/api/motions/generate", {
    method: "POST",
    headers: {
      Host: "127.0.0.1:8765",
      Origin: "https://evil.test",
      "Sec-Fetch-Site": "cross-site",
      "Content-Type": "application/json",
    },
    body: payload,
  }));
  assert.equal(crossOrigin.status, 403);
  assert.equal((await crossOrigin.json() as { error: { code: string } }).error.code, "same_origin_required");

  const noProvider = await postMotion(new Request("http://127.0.0.1:8765/api/motions/generate", {
    method: "POST",
    headers: {
      Host: "127.0.0.1:8765",
      Origin: "http://127.0.0.1:8765",
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
    },
    body: payload,
  }));
  assert.equal(noProvider.status, 503);
  assert.equal(
    (await noProvider.json() as { error: { code: string } }).error.code,
    "motion_generation_unavailable",
  );
});

test("motion deletion route rejects cross-origin and invalid generated ids", async () => {
  const context = { params: Promise.resolve({ motionId: "promptsoul_ai_000000000000" }) };
  const crossOrigin = await deleteMotionRoute(new Request(
    "http://127.0.0.1:8765/api/motions/promptsoul_ai_000000000000",
    {
      method: "DELETE",
      headers: {
        Host: "127.0.0.1:8765",
        Origin: "https://evil.test",
        "Sec-Fetch-Site": "cross-site",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ revision: "rev_0000000000000000" }),
    },
  ), context);
  assert.equal(crossOrigin.status, 403);
  assert.equal(
    (await crossOrigin.json() as { error: { code: string } }).error.code,
    "same_origin_required",
  );

  const invalidId = await deleteMotionRoute(new Request(
    "http://127.0.0.1:8765/api/motions/Action",
    {
      method: "DELETE",
      headers: {
        Host: "127.0.0.1:8765",
        Origin: "http://127.0.0.1:8765",
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ revision: "rev_0000000000000000" }),
    },
  ), { params: Promise.resolve({ motionId: "Action" }) });
  assert.equal(invalidId.status, 400);
  assert.equal(
    (await invalidId.json() as { error: { code: string } }).error.code,
    "invalid_motion_id",
  );

  const extraPayload = await deleteMotionRoute(new Request(
    "http://127.0.0.1:8765/api/motions/promptsoul_ai_000000000000",
    {
      method: "DELETE",
      headers: {
        Host: "127.0.0.1:8765",
        Origin: "http://127.0.0.1:8765",
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ revision: "rev_0000000000000000", extra: true }),
    },
  ), context);
  assert.equal(extraPayload.status, 400);
  assert.equal(
    (await extraPayload.json() as { error: { code: string } }).error.code,
    "invalid_request",
  );
});

function referenceCurve(parameter: string): Record<string, unknown> {
  return {
    Target: "Parameter",
    Id: parameter,
    Segments: [0, 0, 0, 0.5, -10, 0, 1, 10, 0, 1.5, 0],
  };
}

test("motion API compiles provider data into PromptSoul without changing original groups", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "promptsoul-motion-api-"));
  try {
    const runtime = path.join(root, "models", "avatar");
    const motionDirectory = path.join(runtime, "motion");
    mkdirSync(motionDirectory, { recursive: true });
    mkdirSync(path.join(root, "motion-defs"));
    writeFileSync(path.join(root, "model.config.json"), JSON.stringify({
      name: "avatar",
      model3: "models/avatar/avatar.model3.json",
    }));
    const idleEntry = { File: "motion/idle.motion3.json", Name: "Original idle" };
    writeFileSync(path.join(runtime, "avatar.model3.json"), JSON.stringify({
      Version: 3,
      FileReferences: { Motions: { Idle: [idleEntry] } },
    }));
    writeFileSync(path.join(runtime, "avatar.cdi3.json"), JSON.stringify({
      Parameters: [{ Id: "ParamAngleX", Name: "Angle X" }],
    }));
    writeFileSync(path.join(motionDirectory, "idle.motion3.json"), JSON.stringify({
      Curves: [referenceCurve("ParamAngleX")],
    }));

    const result = await generateMotion(
      { prompt: "轻轻侧头再回到原位" },
      {
        root,
        settings: {
          apiKey: "test-only-key",
          apiBase: "https://provider.test/v1",
          model: "test-model",
          source: "environment",
        },
        callProvider: async (_settings, messages) => {
          const request = JSON.parse(messages.at(-1)?.content ?? "{}") as { required_id: string };
          return {
            status: "ok",
            id: request.required_id,
            name: "安全侧头",
            duration: 1.2,
            fade_in: 0.3,
            fade_out: 0.3,
            curves: [{
              control: "c01",
              keyframes: [
                { time: 0, value: 0 },
                { time: 0.6, value: 0.25 },
                { time: 1.2, value: 0 },
              ],
            }],
          };
        },
      },
    );
    assert.equal(result.motion.group, "PromptSoul");
    assert.match(result.motion.name, /^promptsoul_ai_[0-9a-f]{12}$/u);
    assert.match(result.motion.revision, /^rev_[0-9a-f]{16}$/u);
    assert.match(result.modelRevision, /^rev_[0-9a-f]{16}$/u);

    const model = JSON.parse(
      readFileSync(path.join(runtime, "avatar.model3.json"), "utf8"),
    ) as { FileReferences: { Motions: Record<string, unknown> } };
    assert.deepEqual(model.FileReferences.Motions.Idle, [idleEntry]);
    const promptSoul = model.FileReferences.Motions.PromptSoul as Array<Record<string, unknown>>;
    assert.equal(promptSoul.length, 1);
    assert.match(String(promptSoul[0].File), /^motion\/promptsoul_ai_[0-9a-f]{12}\.motion3\.json$/u);
    const capabilities = motionCapabilities({
      root,
      settings: {
        apiKey: "test-only-key",
        apiBase: "https://provider.test/v1",
        model: "test-model",
        source: "environment",
      },
    });
    assert.equal(capabilities.motions.length, 1);
    assert.equal(capabilities.motions[0].name, result.motion.name);
    assert.equal(capabilities.motions[0].revision, result.motion.revision);

    let markProviderStarted: () => void = () => undefined;
    let releaseProvider: () => void = () => undefined;
    const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve; });
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const pendingGeneration = generateMotion(
      { prompt: "并发生成测试动作" },
      {
        root,
        settings: {
          apiKey: "test-only-key",
          apiBase: "https://provider.test/v1",
          model: "test-model",
          source: "environment",
        },
        callProvider: async () => {
          markProviderStarted();
          await providerGate;
          return { status: "unsupported" };
        },
      },
    );
    const expectedGenerationFailure = assert.rejects(
      pendingGeneration,
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "motion_not_feasible"
      ),
    );
    await providerStarted;
    assert.throws(
      () => deleteMotion(
        result.motion.name,
        { revision: result.motion.revision },
        { root },
      ),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "generation_in_progress"
      ),
    );
    releaseProvider();
    await expectedGenerationFailure;

    assert.throws(
      () => deleteMotion(
        result.motion.name,
        { revision: "rev_0000000000000000" },
        { root },
      ),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "model_changed"
      ),
    );
    const deleted = deleteMotion(
      result.motion.name,
      { revision: result.motion.revision },
      { root },
    );
    assert.deepEqual(deleted.motion, result.motion);
    assert.equal(deleted.message, "动作已删除。");
    assert.equal(deleted.cleanupPending, false);
    assert.match(deleted.modelRevision, /^rev_[0-9a-f]{16}$/u);
    const deletedModel = JSON.parse(
      readFileSync(path.join(runtime, "avatar.model3.json"), "utf8"),
    ) as { FileReferences: { Motions: Record<string, unknown> } };
    assert.deepEqual(deletedModel.FileReferences.Motions.Idle, [idleEntry]);
    assert.deepEqual(deletedModel.FileReferences.Motions.PromptSoul, []);
    assert.equal(
      existsSync(path.join(motionDirectory, `${result.motion.name}.motion3.json`)),
      false,
    );
    assert.equal(
      existsSync(path.join(root, "motion-defs", "generated", "avatar", `${result.motion.name}.json`)),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
