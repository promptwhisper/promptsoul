import { readFileSync, statSync } from "node:fs";

import {
  parseStrictJson,
  type ControlProfile,
  type ModelProfile,
} from "./motion-authoring";

const MAX_MODEL3_BYTES = 16 * 1024 * 1024;
const COMMON_MOUTH_OPEN_IDS = new Set([
  "parammouthopeny",
  "param_mouth_open_y",
  "mouthopeny",
  "parammouthopen",
  "param_mouth_open",
  "mouthopen",
]);

const STANDARD_CONTROL_SEMANTICS = new Map<string, string>([
  ["paramanglex", "Head turn left/right (yaw; primary silhouette)"],
  ["param_angle_x", "Head turn left/right (yaw; primary silhouette)"],
  ["paramangley", "Head look up/down (pitch; primary silhouette)"],
  ["param_angle_y", "Head look up/down (pitch; primary silhouette)"],
  ["paramanglez", "Head tilt left/right (roll; primary silhouette)"],
  ["param_angle_z", "Head tilt left/right (roll; primary silhouette)"],
  ["parambodyanglex", "Torso turn left/right (primary silhouette)"],
  ["param_body_angle_x", "Torso turn left/right (primary silhouette)"],
  ["parambodyangley", "Torso bend forward/back (primary silhouette)"],
  ["param_body_angle_y", "Torso bend forward/back (primary silhouette)"],
  ["parambodyanglez", "Torso tilt left/right (primary silhouette)"],
  ["param_body_angle_z", "Torso tilt left/right (primary silhouette)"],
  ["parameyeballx", "Gaze left/right (facial detail)"],
  ["param_eye_ball_x", "Gaze left/right (facial detail)"],
  ["parameyebally", "Gaze up/down (facial detail)"],
  ["param_eye_ball_y", "Gaze up/down (facial detail)"],
  ["paramhairahoge", "Hair strand sway (secondary detail; not a primary gesture)"],
]);

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeMouthOpen(value: string): boolean {
  return /mouth.*open|open.*mouth|口.*開|開.*口/iu.test(value);
}

export function describeRealtimeControl(
  control: Pick<ControlProfile, "parameterId" | "displayName">,
): string {
  return STANDARD_CONTROL_SEMANTICS.get(control.parameterId.toLocaleLowerCase())
    ?? control.displayName;
}

export function extractRealtimeLipSyncParameterIds(
  document: unknown,
  profile: ModelProfile,
): ReadonlySet<string> {
  const result = new Set<string>();
  const available = profile.availableIds;
  if (isObject(document) && Array.isArray(document.Groups)) {
    for (const rawGroup of document.Groups) {
      if (!isObject(rawGroup)
        || rawGroup.Target !== "Parameter"
        || rawGroup.Name !== "LipSync"
        || !Array.isArray(rawGroup.Ids)) continue;
      for (const parameterId of rawGroup.Ids) {
        if (typeof parameterId === "string" && available.has(parameterId)) {
          result.add(parameterId);
        }
      }
    }
  }

  for (const parameterId of available) {
    if (COMMON_MOUTH_OPEN_IDS.has(parameterId.toLocaleLowerCase())) result.add(parameterId);
  }
  for (const control of profile.controls) {
    if (looksLikeMouthOpen(`${control.parameterId} ${control.displayName}`)) {
      result.add(control.parameterId);
    }
  }
  return result;
}

export function loadRealtimeLipSyncParameterIds(profile: ModelProfile): ReadonlySet<string> {
  try {
    const size = statSync(profile.model3Path).size;
    if (size <= 0 || size > MAX_MODEL3_BYTES) {
      return new Set(profile.controls.map((control) => control.parameterId));
    }
    const document = parseStrictJson(
      readFileSync(profile.model3Path),
      MAX_MODEL3_BYTES,
      "active model3",
    );
    return extractRealtimeLipSyncParameterIds(document, profile);
  } catch {
    return new Set(profile.controls.map((control) => control.parameterId));
  }
}
