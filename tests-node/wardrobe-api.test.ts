import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { POST as generateWardrobe } from "../app/api/wardrobe/generate/route";
import { POST as selectWardrobe } from "../app/api/wardrobe/select/route";
import {
  parseGenerateWardrobeRequest,
  parseSelectWardrobeRequest,
} from "../lib/server/wardrobe-api";
import { WardrobeError } from "../lib/server/wardrobe-service";

function localRequest(pathname: string, body: unknown, origin = "http://127.0.0.1:8765"): Request {
  return new Request(`http://127.0.0.1:8765${pathname}`, {
    method: "POST",
    headers: {
      Host: "127.0.0.1:8765",
      Origin: origin,
      "Sec-Fetch-Site": origin.includes("127.0.0.1") ? "same-origin" : "cross-site",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("wardrobe mutation contract", () => {
  test("normalizes a bounded prompt and rejects browser-supplied provider settings", () => {
    assert.deepEqual(
      parseGenerateWardrobeRequest({ prompt: "  暗黑   发光 学院风  " }),
      { prompt: "暗黑 发光 学院风" },
    );
    assert.throws(
      () => parseGenerateWardrobeRequest({ prompt: "未来风", provider: "openai" }),
      (error: unknown) => error instanceof WardrobeError && error.code === "invalid_request",
    );
    assert.throws(
      () => parseGenerateWardrobeRequest({ prompt: "x".repeat(1201) }),
      (error: unknown) => error instanceof WardrobeError && error.code === "invalid_prompt",
    );
  });

  test("accepts only original or generated preset IDs with an optimistic revision", () => {
    assert.deepEqual(parseSelectWardrobeRequest({ presetId: "original", revision: 4 }), {
      presetId: "original",
      revision: 4,
    });
    assert.deepEqual(parseSelectWardrobeRequest({ presetId: "outfit_012345abcdef" }), {
      presetId: "outfit_012345abcdef",
      revision: undefined,
    });
    assert.throws(
      () => parseSelectWardrobeRequest({ presetId: "../../models/private" }),
      (error: unknown) => error instanceof WardrobeError && error.code === "invalid_preset_id",
    );
  });

  test("rejects cross-origin generation before contacting PromptSkin", async () => {
    const response = await generateWardrobe(localRequest(
      "/api/wardrobe/generate",
      { prompt: "暗黑发光学院风" },
      "https://evil.test",
    ));
    assert.equal(response.status, 403);
    assert.equal(
      (await response.json() as { error: { code: string } }).error.code,
      "same_origin_required",
    );
  });

  test("rejects invalid preset IDs before touching local model files", async () => {
    const response = await selectWardrobe(localRequest(
      "/api/wardrobe/select",
      { presetId: "../escape", revision: 1 },
    ));
    assert.equal(response.status, 400);
    assert.equal(
      (await response.json() as { error: { code: string } }).error.code,
      "invalid_preset_id",
    );
  });
});

test("browser wardrobe integration reloads Live2D while releasing texture caches", () => {
  const source = readFileSync(path.join(process.cwd(), "assets", "app.js"), "utf8");
  assert.match(source, /const WARDROBE_GENERATE_ENDPOINT = "\/api\/wardrobe\/generate"/u);
  assert.match(source, /body: JSON\.stringify\(\{ prompt \}\)/u);
  assert.match(source, /body: JSON\.stringify\(\{ presetId, revision: state\.wardrobe\.revision \}\)/u);
  assert.match(source, /destroyCurrentLive2D\(\{ releaseTextures: true \}\)/u);
  assert.match(source, /texture: Boolean\(options\.releaseTextures\)/u);
  assert.match(source, /baseTexture: Boolean\(options\.releaseTextures\)/u);
  assert.doesNotMatch(source, /PROMPTSKIN_API_BASE|AI_LIVE2D_OPENAI_API_KEY/u);
});
