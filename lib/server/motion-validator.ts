import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { FPS, MOTION_GROUP } from './motion-authoring';

const EPSILON = 1e-6;
const MAX_MOTION_BYTES = 4 * 1024 * 1024;

interface Point {
  readonly time: number;
  readonly value: number;
}

interface CurveInspection {
  readonly points: Point[];
  readonly values: number[];
  readonly segmentCount: number;
  readonly pointCount: number;
  readonly controlErrors: number[];
}

export interface ValidateMotionsOptions {
  readonly root?: string;
  readonly runtime?: string;
}

export interface MotionValidationResult {
  readonly ok: boolean;
  readonly runtime: string;
  readonly checked: readonly string[];
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  readonly summaries: readonly string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(filename: string): unknown {
  if (statSync(filename).size > MAX_MOTION_BYTES) throw new Error(`${path.basename(filename)} is too large`);
  return JSON.parse(readFileSync(filename, 'utf8')) as unknown;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function inspectCurve(curve: Record<string, unknown>, label: string): CurveInspection {
  const segments = curve.Segments;
  if (!Array.isArray(segments) || segments.length < 2) throw new Error(`${label}: invalid Segments`);
  const firstTime = finite(segments[0], label);
  const firstValue = finite(segments[1], label);
  const points: Point[] = [{ time: firstTime, value: firstValue }];
  const values = [firstValue];
  const controlErrors: number[] = [];
  let segmentCount = 0;
  let pointCount = 1;
  let previousTime = firstTime;
  let index = 2;
  while (index < segments.length) {
    const type = finite(segments[index], label);
    if (!Number.isInteger(type)) throw new Error(`${label}: invalid segment type`);
    segmentCount += 1;
    if (type === 1) {
      if (index + 6 >= segments.length) throw new Error(`${label}: truncated bezier segment`);
      const valuesInSegment = segments.slice(index + 1, index + 7).map((value) => finite(value, label));
      const [control1Time, control1Value, control2Time, control2Value, time, value] = valuesInSegment;
      if (!(previousTime - EPSILON <= control1Time && control1Time <= control2Time && control2Time <= time + EPSILON)) {
        controlErrors.push(time);
      }
      values.push(control1Value, control2Value, value);
      points.push({ time, value });
      previousTime = time;
      pointCount += 3;
      index += 7;
    } else if (type === 0 || type === 2 || type === 3) {
      if (index + 2 >= segments.length) throw new Error(`${label}: truncated segment`);
      const time = finite(segments[index + 1], label);
      const value = finite(segments[index + 2], label);
      values.push(value);
      points.push({ time, value });
      previousTime = time;
      pointCount += 1;
      index += 3;
    } else {
      throw new Error(`${label}: unknown segment type ${type}`);
    }
  }
  return { points, values, segmentCount, pointCount, controlErrors };
}

function walkFiles(root: string, suffix: string): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (lstatSync(filename).isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile() && entry.name.endsWith(suffix)) result.push(filename);
    }
  };
  visit(root);
  return result.sort();
}

function configuredRuntime(root: string): string {
  const config = readJson(path.join(root, 'model.config.json'));
  if (!isObject(config) || typeof config.model3 !== 'string') {
    throw new Error('model.config.json has no valid model3 entry');
  }
  return path.resolve(root, path.dirname(config.model3));
}

function pathInsideRuntime(runtime: string, relative: unknown): string | undefined {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || path.isAbsolute(relative)) return undefined;
  const candidate = path.resolve(runtime, relative);
  const fromRuntime = path.relative(path.resolve(runtime), candidate);
  if (fromRuntime === '..' || fromRuntime.startsWith(`..${path.sep}`) || path.isAbsolute(fromRuntime)) return undefined;
  return candidate;
}

export function validateMotions(options: ValidateMotionsOptions = {}): MotionValidationResult {
  const root = path.resolve(options.root ?? process.cwd());
  const runtime = path.resolve(options.runtime ?? configuredRuntime(root));
  const warnings: string[] = [];
  const errors: string[] = [];
  const summaries: string[] = [];
  const checked: string[] = [];
  const model3Files = readdirSync(runtime)
    .filter((filename) => filename.endsWith('.model3.json'))
    .map((filename) => path.join(runtime, filename));
  if (model3Files.length !== 1) {
    errors.push(`expected exactly one model3.json in ${runtime}, found ${model3Files.length}`);
    return { ok: false, runtime, checked, warnings, errors, summaries };
  }

  let model3: unknown;
  try {
    model3 = readJson(model3Files[0]);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'could not read model3.json');
    return { ok: false, runtime, checked, warnings, errors, summaries };
  }
  if (!isObject(model3) || !isObject(model3.FileReferences) || !isObject(model3.FileReferences.Motions)) {
    errors.push('model3.json has invalid motion groups');
    return { ok: false, runtime, checked, warnings, errors, summaries };
  }
  const entries = model3.FileReferences.Motions[MOTION_GROUP];
  if (!Array.isArray(entries) || !entries.length) {
    errors.push(`model3.json has no ${MOTION_GROUP} group`);
    return { ok: false, runtime, checked, warnings, errors, summaries };
  }
  const newFiles: string[] = [];
  const seenFiles = new Set<string>();
  for (const entry of entries) {
    const filename = isObject(entry) ? pathInsideRuntime(runtime, entry.File) : undefined;
    if (!filename) {
      errors.push('PromptSoul contains an invalid or escaping motion path');
      continue;
    }
    const normalized = path.normalize(filename);
    if (seenFiles.has(normalized)) errors.push(`${path.basename(filename)}: duplicate PromptSoul registration`);
    seenFiles.add(normalized);
    newFiles.push(filename);
  }
  const generatedSet = new Set(newFiles.map((filename) => path.normalize(filename)));
  const referenceFiles = walkFiles(runtime, '.motion3.json')
    .filter((filename) => !generatedSet.has(path.normalize(filename)) && !path.basename(filename).startsWith('promptsoul_ai_'));

  const physicsOutputs = new Set<string>();
  for (const physicsPath of walkFiles(runtime, '.physics3.json')) {
    try {
      const physics = readJson(physicsPath);
      if (!isObject(physics) || !Array.isArray(physics.PhysicsSettings)) continue;
      for (const setting of physics.PhysicsSettings) {
        if (!isObject(setting) || !Array.isArray(setting.Output)) continue;
        for (const output of setting.Output) {
          if (isObject(output) && isObject(output.Destination) && typeof output.Destination.Id === 'string') {
            physicsOutputs.add(output.Destination.Id);
          }
        }
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'invalid physics file');
    }
  }

  const safeRanges = new Map<string, [number, number]>();
  const firstValues = new Map<string, Map<number, number>>();
  for (const referencePath of referenceFiles) {
    try {
      const reference = readJson(referencePath);
      if (!isObject(reference) || !Array.isArray(reference.Curves)) continue;
      for (const rawCurve of reference.Curves) {
        if (!isObject(rawCurve) || rawCurve.Target !== 'Parameter' || typeof rawCurve.Id !== 'string') continue;
        const inspection = inspectCurve(rawCurve, `${path.basename(referencePath)}:${rawCurve.Id}`);
        const current = safeRanges.get(rawCurve.Id) ?? [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
        current[0] = Math.min(current[0], ...inspection.values);
        current[1] = Math.max(current[1], ...inspection.values);
        safeRanges.set(rawCurve.Id, current);
        const first = Number(inspection.points[0].value.toFixed(3));
        const counts = firstValues.get(rawCurve.Id) ?? new Map<number, number>();
        counts.set(first, (counts.get(first) ?? 0) + 1);
        firstValues.set(rawCurve.Id, counts);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `invalid reference ${referencePath}`);
    }
  }
  const basePose = new Map<string, number>();
  for (const [parameterId, counts] of firstValues) {
    basePose.set(parameterId, [...counts].sort((left, right) => right[1] - left[1])[0][0]);
  }
  const hasReference = referenceFiles.length > 0;
  if (!hasReference) {
    warnings.push('this model has no pre-existing motions; skipping range and base-pose checks');
    warnings.push('verify every generated motion visually in the browser');
  }

  for (const filename of newFiles) {
    const name = path.basename(filename);
    checked.push(name);
    if (!existsSync(filename)) {
      errors.push(`${name}: referenced by model3.json but the file does not exist`);
      continue;
    }
    try {
      const document = readJson(filename);
      if (!isObject(document) || !isObject(document.Meta) || !Array.isArray(document.Curves)) {
        throw new Error(`${name}: invalid motion document`);
      }
      const duration = finite(document.Meta.Duration, `${name}:Duration`);
      let totalSegments = 0;
      let totalPoints = 0;
      const seenParameters = new Set<string>();
      for (const rawCurve of document.Curves) {
        if (!isObject(rawCurve) || typeof rawCurve.Id !== 'string') {
          errors.push(`${name}: curve has no valid ID`);
          continue;
        }
        const parameterId = rawCurve.Id;
        const label = `${name}:${parameterId}`;
        if (rawCurve.Target !== 'Parameter') {
          errors.push(`${label}: generated curves must target Parameter, not ${String(rawCurve.Target)}`);
        }
        if (seenParameters.has(parameterId)) errors.push(`${label}: duplicate parameter curve`);
        seenParameters.add(parameterId);
        const inspection = inspectCurve(rawCurve, label);
        totalSegments += inspection.segmentCount;
        totalPoints += inspection.pointCount;
        for (const time of inspection.controlErrors) {
          errors.push(`${label}: bezier control point outside its segment (t=${time})`);
        }
        const times = inspection.points.map((point) => point.time);
        for (let index = 1; index < times.length; index += 1) {
          if (times[index] <= times[index - 1] + EPSILON) {
            errors.push(`${label}: keyframe times are not strictly increasing`);
            break;
          }
        }
        if (Math.abs(times[0]) > EPSILON) errors.push(`${label}: does not start at t=0`);
        if (Math.abs(times[times.length - 1] - duration) > EPSILON) {
          errors.push(`${label}: last key (${times[times.length - 1]}) != Duration (${duration})`);
        }
        if (physicsOutputs.has(parameterId)) {
          errors.push(`${label}: physics output parameters must not be animated directly`);
        }
        if (!hasReference) continue;
        const range = safeRanges.get(parameterId);
        if (!range) {
          errors.push(`${label}: parameter never used by the existing motions`);
        } else {
          for (const value of inspection.values) {
            if (value < range[0] - EPSILON || value > range[1] + EPSILON) {
              errors.push(`${label}: value ${value} outside the observed range [${range[0]},${range[1]}]`);
            }
          }
        }
        const base = basePose.get(parameterId) ?? 0;
        if (Math.abs(inspection.points[0].value - base) > EPSILON) {
          errors.push(`${label}: first value ${inspection.points[0].value} != base pose ${base}`);
        }
        if (Math.abs(inspection.points[inspection.points.length - 1].value - base) > EPSILON) {
          errors.push(`${label}: last value ${inspection.points[inspection.points.length - 1].value} != base pose ${base}`);
        }
      }
      const expectedMeta: readonly [string, number][] = [
        ['CurveCount', document.Curves.length],
        ['TotalSegmentCount', totalSegments],
        ['TotalPointCount', totalPoints],
      ];
      for (const [key, actual] of expectedMeta) {
        if (document.Meta[key] !== actual) {
          errors.push(`${name}: Meta.${key}=${String(document.Meta[key])} but actual data has ${actual}`);
        }
      }
      if (document.Meta.Loop !== false) errors.push(`${name}: Meta.Loop must be false`);
      if (document.Meta.Fps !== FPS) errors.push(`${name}: Meta.Fps must be ${FPS}`);
      summaries.push(`checked ${name}: curves=${document.Curves.length} segs=${totalSegments} pts=${totalPoints}`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `${name}: invalid motion`);
    }
  }
  return { ok: errors.length === 0, runtime, checked, warnings, errors, summaries };
}
