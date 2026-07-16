import { dirname, join, resolve } from "node:path";

import {
  DEFAULT_PROJECT_ROOT,
  expandHome,
  findFilesBySuffix,
  isPathWithin,
  readJsonFile,
} from "./model-files.ts";

type JsonObject = Record<string, unknown>;

export interface ParameterAnalysis {
  id: string;
  name: string;
  minimum: number | null;
  maximum: number | null;
  base: number | null;
  physicsOutput: boolean;
}

export interface ModelAnalysis {
  runtime: string;
  motionCount: number;
  parameters: ParameterAnalysis[];
}

interface ParameterStats {
  minimum: number;
  maximum: number;
  samples: number;
  bases: Map<number, { count: number; order: number }>;
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function curveValues(curve: JsonObject): Array<[number, number]> {
  const segments = array(curve.Segments);
  if (segments.length < 2) throw new Error("motion curve does not contain an initial point");
  const points: Array<[number, number]> = [
    [finiteNumber(segments[0], "curve time"), finiteNumber(segments[1], "curve value")],
  ];
  let cursor = 2;
  while (cursor < segments.length) {
    const segmentType = finiteNumber(segments[cursor], "curve segment type");
    if (segmentType === 1) {
      if (cursor + 6 >= segments.length) throw new Error("bezier curve segment is truncated");
      points.push([
        finiteNumber(segments[cursor + 5], "curve time"),
        finiteNumber(segments[cursor + 6], "curve value"),
      ]);
      cursor += 7;
    } else {
      if (cursor + 2 >= segments.length) throw new Error("linear curve segment is truncated");
      points.push([
        finiteNumber(segments[cursor + 1], "curve time"),
        finiteNumber(segments[cursor + 2], "curve value"),
      ]);
      cursor += 3;
    }
  }
  return points;
}

function roundedBase(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

async function firstFile(runtime: string, suffix: string): Promise<string | null> {
  return (await findFilesBySuffix(runtime, suffix))[0] ?? null;
}

export async function resolveModelRuntime(
  rootPath = DEFAULT_PROJECT_ROOT,
  runtimePath?: string,
): Promise<string> {
  const root = resolve(rootPath);
  if (runtimePath) return resolve(expandHome(runtimePath));
  const configPath = join(root, "model.config.json");
  let config: JsonObject;
  try {
    config = object(await readJsonFile(configPath)) ?? {};
  } catch (error) {
    throw new Error("model.config.json was not found or is invalid; run setup-model first", {
      cause: error,
    });
  }
  if (typeof config.model3 !== "string" || !config.model3.trim()) {
    throw new Error("model.config.json does not contain a valid model3 path");
  }
  const model3 = resolve(root, config.model3);
  if (!isPathWithin(root, model3)) {
    throw new Error("model.config.json points outside the project");
  }
  return dirname(model3);
}

function generatedMotionPaths(modelDocument: JsonObject, runtime: string): Set<string> {
  const fileReferences = object(modelDocument.FileReferences);
  const motions = object(fileReferences?.Motions);
  const promptSoul = array(motions?.PromptSoul);
  const generated = new Set<string>();
  for (const rawEntry of promptSoul) {
    const entry = object(rawEntry);
    if (typeof entry?.File !== "string" || !entry.File) continue;
    const candidate = resolve(runtime, entry.File);
    if (isPathWithin(runtime, candidate)) generated.add(candidate);
  }
  return generated;
}

export async function analyzeModel(
  rootPath = DEFAULT_PROJECT_ROOT,
  runtimePath?: string,
): Promise<ModelAnalysis> {
  const runtime = await resolveModelRuntime(rootPath, runtimePath);
  const cdiPath = await firstFile(runtime, ".cdi3.json");
  const physicsPath = await firstFile(runtime, ".physics3.json");
  const model3Path = await firstFile(runtime, ".model3.json");
  let motionPaths = await findFilesBySuffix(runtime, ".motion3.json");

  if (model3Path) {
    const modelDocument = object(await readJsonFile(model3Path));
    if (modelDocument) {
      const generated = generatedMotionPaths(modelDocument, runtime);
      motionPaths = motionPaths.filter((motionPath) => !generated.has(resolve(motionPath)));
    }
  }

  const names = new Map<string, string>();
  if (cdiPath) {
    const cdi = object(await readJsonFile(cdiPath));
    for (const rawParameter of array(cdi?.Parameters)) {
      const parameter = object(rawParameter);
      if (typeof parameter?.Id !== "string") continue;
      names.set(parameter.Id, typeof parameter.Name === "string" ? parameter.Name : "");
    }
  }

  const physicsOutputs = new Set<string>();
  if (physicsPath) {
    const physics = object(await readJsonFile(physicsPath));
    for (const rawSetting of array(physics?.PhysicsSettings)) {
      const setting = object(rawSetting);
      for (const rawOutput of array(setting?.Output)) {
        const output = object(rawOutput);
        const destination = object(output?.Destination);
        if (typeof destination?.Id === "string") physicsOutputs.add(destination.Id);
      }
    }
  }

  const stats = new Map<string, ParameterStats>();
  let baseOrder = 0;
  for (const motionPath of motionPaths) {
    const motion = object(await readJsonFile(motionPath));
    for (const rawCurve of array(motion?.Curves)) {
      const curve = object(rawCurve);
      if (!curve || curve.Target !== "Parameter" || typeof curve.Id !== "string") continue;
      const points = curveValues(curve);
      const values = points.map((point) => point[1]);
      let current = stats.get(curve.Id);
      if (!current) {
        current = {
          minimum: Number.POSITIVE_INFINITY,
          maximum: Number.NEGATIVE_INFINITY,
          samples: 0,
          bases: new Map(),
        };
        stats.set(curve.Id, current);
      }
      current.minimum = Math.min(current.minimum, ...values);
      current.maximum = Math.max(current.maximum, ...values);
      current.samples += 1;
      const base = roundedBase(points[0][1]);
      const count = current.bases.get(base);
      if (count) {
        count.count += 1;
      } else {
        current.bases.set(base, { count: 1, order: baseOrder });
        baseOrder += 1;
      }
    }
  }

  const parameterIds = new Set([...names.keys(), ...stats.keys()]);
  const parameters = [...parameterIds]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((id): ParameterAnalysis => {
      const current = stats.get(id);
      let base: number | null = null;
      if (current) {
        const ranked = [...current.bases.entries()].sort(
          (left, right) => right[1].count - left[1].count || left[1].order - right[1].order,
        );
        base = ranked[0]?.[0] ?? null;
      }
      return {
        id,
        name: names.get(id) ?? "",
        minimum: current?.minimum ?? null,
        maximum: current?.maximum ?? null,
        base,
        physicsOutput: physicsOutputs.has(id),
      };
    });
  return { runtime, motionCount: motionPaths.length, parameters };
}

function padded(value: string, width: number, align: "left" | "right" = "right"): string {
  return align === "left" ? value.padEnd(width) : value.padStart(width);
}

export function formatModelAnalysis(analysis: ModelAnalysis): string {
  const lines = [
    `# runtime: ${analysis.runtime}`,
    `# aggregated from ${analysis.motionCount} existing motions`,
    "",
  ];
  const header = `${padded("ParamId", 32, "left")} ${padded("min", 8)} ${padded(
    "max",
    8,
  )} ${padded("base(est)", 10)}  physics  display name`;
  lines.push(header, "-".repeat(header.length));
  for (const parameter of analysis.parameters) {
    const ranges =
      parameter.minimum === null || parameter.maximum === null || parameter.base === null
        ? `${padded("-", 8)} ${padded("-", 8)} ${padded("-", 10)}`
        : `${padded(parameter.minimum.toFixed(2), 8)} ${padded(
            parameter.maximum.toFixed(2),
            8,
          )} ${padded(parameter.base.toFixed(2), 10)}`;
    const physics = parameter.physicsOutput ? "  ★phys  " : "         ";
    lines.push(`${padded(parameter.id, 32, "left")} ${ranges} ${physics} ${parameter.name}`);
  }
  lines.push(
    "",
    "★phys = destination of a physics3.json output. Never animate these directly " +
      "(move the head/body angles and they sway naturally).",
  );
  return `${lines.join("\n")}\n`;
}
