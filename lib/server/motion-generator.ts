import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { atomicWrite, FPS, MOTION_GROUP, reapplySavedMotions } from './motion-authoring';

export interface MotionCurveDocument {
  readonly Target: 'Parameter';
  readonly Id: string;
  readonly Segments: number[];
}

export interface MotionDocument {
  readonly Version: 3;
  readonly Meta: {
    readonly Duration: number;
    readonly Fps: number;
    readonly Loop: false;
    readonly AreBeziersRestricted: true;
    readonly CurveCount: number;
    readonly TotalSegmentCount: number;
    readonly TotalPointCount: number;
    readonly UserDataCount: 0;
    readonly TotalUserDataSize: 0;
  };
  readonly Curves: readonly MotionCurveDocument[];
}

export type CurveBuilder = (
  parameterId: string,
  keyframes: readonly (readonly [number, number])[],
) => MotionCurveDocument;

export type MotionBuilder = (
  duration: number,
  curves: readonly MotionCurveDocument[],
) => MotionDocument;

export type MotionManifestEntry = readonly [
  id: string,
  displayName: string,
  fadeIn: number,
  fadeOut: number,
];

export interface MotionDefinitions {
  readonly motions: Readonly<Record<string, MotionDocument>>;
  readonly manifest: readonly MotionManifestEntry[];
}

export interface MotionDefinitionModule {
  readonly define: (curve: CurveBuilder, motion: MotionBuilder) => MotionDefinitions;
}

export interface GenerateMotionsOptions {
  readonly root?: string;
  readonly runtime?: string;
  readonly log?: (line: string) => void;
}

export interface GenerateMotionsResult {
  readonly runtime: string;
  readonly model3Path: string;
  readonly definitionsPath: string;
  readonly generated: readonly string[];
  readonly restored: number;
}

function snap(time: number): number {
  return Number((Math.round(time * FPS) / FPS).toFixed(3));
}

export const buildCurve: CurveBuilder = (parameterId, keyframes) => {
  if (!parameterId || !keyframes.length) throw new Error('A curve needs an ID and keyframes.');
  const normalized = keyframes.map(([time, value]) => [snap(time), Number(value.toFixed(3))] as const);
  const segments: number[] = [normalized[0][0], normalized[0][1]];
  for (let index = 1; index < normalized.length; index += 1) {
    const [leftTime, leftValue] = normalized[index - 1];
    const [rightTime, rightValue] = normalized[index];
    if (rightTime <= leftTime) throw new Error(`Curve ${parameterId} keyframe times must increase.`);
    const delta = (rightTime - leftTime) / 3;
    segments.push(
      1,
      Number((leftTime + delta).toFixed(3)), leftValue,
      Number((rightTime - delta).toFixed(3)), rightValue,
      rightTime, rightValue,
    );
  }
  return { Target: 'Parameter', Id: parameterId, Segments: segments };
};

export const buildMotion: MotionBuilder = (duration, curves) => {
  let totalSegments = 0;
  let totalPoints = 0;
  for (const curve of curves) {
    totalPoints += 1;
    let index = 2;
    while (index < curve.Segments.length) {
      totalSegments += 1;
      if (curve.Segments[index] === 1) {
        totalPoints += 3;
        index += 7;
      } else {
        totalPoints += 1;
        index += 3;
      }
    }
  }
  return {
    Version: 3,
    Meta: {
      Duration: snap(duration),
      Fps: FPS,
      Loop: false,
      AreBeziersRestricted: true,
      CurveCount: curves.length,
      TotalSegmentCount: totalSegments,
      TotalPointCount: totalPoints,
      UserDataCount: 0,
      TotalUserDataSize: 0,
    },
    Curves: curves,
  };
};

function jsonBytes(document: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
}

function readJson(filename: string): unknown {
  return JSON.parse(readFileSync(filename, 'utf8')) as unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolveConfiguredRuntime(root = process.cwd()): string {
  const configPath = path.join(path.resolve(root), 'model.config.json');
  if (!existsSync(configPath)) {
    throw new Error('model.config.json not found. Run the model setup script first.');
  }
  const config = readJson(configPath);
  if (!isObject(config) || typeof config.model3 !== 'string') {
    throw new Error('model.config.json has no valid model3 entry.');
  }
  return path.resolve(root, path.dirname(config.model3));
}

function oneModel3(runtime: string): string {
  const files = readdirSync(runtime)
    .filter((filename) => filename.endsWith('.model3.json'))
    .map((filename) => path.join(runtime, filename));
  if (files.length !== 1) {
    throw new Error(`found ${files.length} model3.json files in ${runtime}; exactly one is required.`);
  }
  return files[0];
}

async function loadDefinitions(root: string, stem: string): Promise<MotionDefinitions & { path: string }> {
  const definitionsPath = path.join(root, 'motion-defs', `${stem}.ts`);
  if (!existsSync(definitionsPath)) {
    throw new Error(
      `no TypeScript motion definitions for this model: ${definitionsPath}. `
      + 'Analyze the model first, then create a model-specific definition.',
    );
  }
  const imported = await import(`${pathToFileURL(definitionsPath).href}?mtime=${Date.now()}`) as Partial<MotionDefinitionModule>;
  if (typeof imported.define !== 'function') throw new Error(`${definitionsPath} must export define().`);
  const definitions = imported.define(buildCurve, buildMotion);
  if (!isObject(definitions) || !isObject(definitions.motions) || !Array.isArray(definitions.manifest)) {
    throw new Error(`${definitionsPath} returned invalid definitions.`);
  }
  const manifestIds = new Set(definitions.manifest.map((entry) => entry[0]));
  const motionIds = new Set(Object.keys(definitions.motions));
  if (
    manifestIds.size !== motionIds.size
    || [...manifestIds].some((motionId) => !motionIds.has(motionId))
  ) {
    throw new Error(`MANIFEST and MOTIONS keys do not match in ${definitionsPath}.`);
  }
  return { ...definitions, path: definitionsPath };
}

function availableParameterIds(runtime: string): Set<string> | undefined {
  const cdi = readdirSync(runtime).find((filename) => filename.endsWith('.cdi3.json'));
  if (!cdi) return undefined;
  const document = readJson(path.join(runtime, cdi));
  if (!isObject(document) || !Array.isArray(document.Parameters)) {
    throw new Error('The active cdi3.json has an invalid Parameters catalog.');
  }
  return new Set(
    document.Parameters
      .filter((parameter): parameter is Record<string, unknown> => isObject(parameter))
      .map((parameter) => parameter.Id)
      .filter((parameterId): parameterId is string => typeof parameterId === 'string'),
  );
}

function safeGeneratedFile(runtime: string, relative: unknown): string | undefined {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\')) return undefined;
  const motionDirectory = path.resolve(runtime, 'motion');
  const candidate = path.resolve(runtime, relative);
  const relativeToMotion = path.relative(motionDirectory, candidate);
  if (relativeToMotion.startsWith('..') || path.isAbsolute(relativeToMotion)) return undefined;
  return candidate;
}

export async function generateMotions(options: GenerateMotionsOptions = {}): Promise<GenerateMotionsResult> {
  const root = path.resolve(options.root ?? process.cwd());
  const runtime = path.resolve(options.runtime ?? resolveConfiguredRuntime(root));
  const log = options.log ?? (() => undefined);
  const model3Path = oneModel3(runtime);
  const stem = path.basename(model3Path, '.model3.json');
  const definitions = await loadDefinitions(root, stem);
  log(`definitions: ${definitions.path} (${Object.keys(definitions.motions).length} motions)`);

  const available = availableParameterIds(runtime);
  if (available) {
    const missing = new Set<string>();
    for (const motion of Object.values(definitions.motions)) {
      for (const curve of motion.Curves) {
        if (curve.Target === 'Parameter' && !available.has(curve.Id)) missing.add(curve.Id);
      }
    }
    if (missing.size) {
      throw new Error(`the following parameters do not exist in this model: ${[...missing].sort().join(', ')}`);
    }
  }

  const motionDirectory = path.join(runtime, 'motion');
  const generated: string[] = [];
  for (const [motionId, document] of Object.entries(definitions.motions)) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(motionId)) {
      throw new Error(`invalid generated motion ID: ${motionId}`);
    }
    const output = path.join(motionDirectory, `${motionId}.motion3.json`);
    atomicWrite(output, jsonBytes(document));
    generated.push(output);
    log(
      `wrote ${output}: dur=${document.Meta.Duration} curves=${document.Meta.CurveCount} `
      + `segs=${document.Meta.TotalSegmentCount} pts=${document.Meta.TotalPointCount}`,
    );
  }

  const model3 = readJson(model3Path);
  if (!isObject(model3)) throw new Error('model3.json must contain an object.');
  if (model3.FileReferences === undefined) model3.FileReferences = {};
  if (!isObject(model3.FileReferences)) throw new Error('model3.json FileReferences must be an object.');
  if (model3.FileReferences.Motions === undefined) model3.FileReferences.Motions = {};
  if (!isObject(model3.FileReferences.Motions)) throw new Error('model3.json Motions must be an object.');
  const groups = model3.FileReferences.Motions;
  const previous = Array.isArray(groups[MOTION_GROUP]) ? groups[MOTION_GROUP] : [];
  const previousFiles = previous
    .map((entry) => (isObject(entry) ? safeGeneratedFile(runtime, entry.File) : undefined))
    .filter((filename): filename is string => Boolean(filename));
  groups[MOTION_GROUP] = definitions.manifest.map(([motionId, displayName, fadeIn, fadeOut]) => ({
    File: `motion/${motionId}.motion3.json`,
    Name: displayName,
    FadeInTime: fadeIn,
    FadeOutTime: fadeOut,
  }));
  atomicWrite(model3Path, jsonBytes(model3));
  const currentFiles = new Set(
    (groups[MOTION_GROUP] as Record<string, unknown>[])
      .map((entry) => safeGeneratedFile(runtime, entry.File))
      .filter((filename): filename is string => Boolean(filename)),
  );
  for (const stale of previousFiles.sort()) {
    if (!currentFiles.has(stale) && existsSync(stale)) {
      rmSync(stale);
      log(`removed stale generated motion: ${stale}`);
    }
  }
  log(`registered ${definitions.manifest.length} motions to ${model3Path} [${MOTION_GROUP}]`);

  let restored = 0;
  const configuredRuntime = existsSync(path.join(root, 'model.config.json'))
    ? path.resolve(resolveConfiguredRuntime(root))
    : undefined;
  if (configuredRuntime === runtime) {
    restored = reapplySavedMotions(root).length;
    if (restored) log(`restored ${restored} AI-authored motions to ${model3Path} [${MOTION_GROUP}]`);
  } else if (options.runtime) {
    log('skipped AI-authored motion restore: explicit runtime is not the configured model');
  }
  return { runtime, model3Path, definitionsPath: definitions.path, generated, restored };
}
