import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { ModelProfile } from "../lib/server/motion-authoring";
import {
  extractRealtimeLipSyncParameterIds,
  loadRealtimeLipSyncParameterIds,
} from "../lib/server/realtime-model";

function profile(): ModelProfile {
  const controls = [
    {
      token: "c01",
      parameterId: "ParamAngleX",
      displayName: "Head angle X",
      minimum: -30,
      maximum: 30,
      base: 0,
    },
    {
      token: "c02",
      parameterId: "CustomLipValue",
      displayName: "口の開閉",
      minimum: 0,
      maximum: 1,
      base: 0,
    },
    {
      token: "c03",
      parameterId: "ParamMouthOpenY",
      displayName: "Model control 03",
      minimum: 0,
      maximum: 1,
      base: 0,
    },
  ];
  return {
    root: "/tmp/model",
    runtime: "/tmp/model/runtime",
    model3Path: "/tmp/model/runtime/test.model3.json",
    modelStem: "test",
    controls,
    availableIds: new Set(controls.map((control) => control.parameterId)),
    physicsOutputs: new Set(),
    partOpacityIds: new Set(),
    safeRanges: new Map(controls.map((control) => [
      control.parameterId,
      [control.minimum, control.maximum] as const,
    ])),
    basePose: new Map(controls.map((control) => [control.parameterId, control.base])),
    referenceMotionCount: 1,
    revision: "0123456789abcdef",
  };
}

test("extracts model3 LipSync groups and conservative mouth-open fallbacks", () => {
  const current = profile();
  const ids = extractRealtimeLipSyncParameterIds({
    Groups: [
      { Target: "Parameter", Name: "EyeBlink", Ids: ["ParamAngleX"] },
      { Target: "Parameter", Name: "LipSync", Ids: ["CustomLipValue", "UnknownId"] },
    ],
  }, current);

  assert.deepEqual([...ids].sort(), ["CustomLipValue", "ParamMouthOpenY"]);
  assert.equal(ids.has("ParamAngleX"), false);
});

test("does not trust malformed or non-parameter model groups", () => {
  const current = profile();
  const ids = extractRealtimeLipSyncParameterIds({
    Groups: [
      { Target: "PartOpacity", Name: "LipSync", Ids: ["ParamAngleX"] },
      { Target: "Parameter", Name: "LipSync", Ids: "ParamAngleX" },
    ],
  }, current);

  assert.equal(ids.has("ParamAngleX"), false);
  assert.equal(ids.has("CustomLipValue"), true);
  assert.equal(ids.has("ParamMouthOpenY"), true);
});

test("loads custom LipSync groups from model3 files larger than four MiB", (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "promptsoul-realtime-model-"));
  context.after(() => rmSync(directory, { force: true, recursive: true }));
  const model3Path = path.join(directory, "large.model3.json");
  writeFileSync(model3Path, JSON.stringify({
    Groups: [{ Target: "Parameter", Name: "LipSync", Ids: ["ParamAngleX"] }],
    Padding: "x".repeat((4 * 1024 * 1024) + 1),
  }));
  const current = { ...profile(), model3Path };

  assert.equal(loadRealtimeLipSyncParameterIds(current).has("ParamAngleX"), true);
});

test("fails closed when the active model3 catalog cannot be read", (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "promptsoul-realtime-model-"));
  context.after(() => rmSync(directory, { force: true, recursive: true }));
  const current = {
    ...profile(),
    model3Path: path.join(directory, "missing.model3.json"),
  };

  assert.deepEqual(
    [...loadRealtimeLipSyncParameterIds(current)].sort(),
    current.controls.map((control) => control.parameterId).sort(),
  );
});
