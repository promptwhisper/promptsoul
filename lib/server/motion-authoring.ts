import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

export const MOTION_GROUP = 'PromptSoul';
export const FPS = 30;
export const MIN_DURATION = 0.5;
export const MAX_DURATION = 8;
export const MIN_FADE = 0.2;
export const MAX_FADE = 0.5;
export const MAX_CURVES = 24;
export const MAX_KEYFRAMES_PER_CURVE = 24;
export const MAX_TOTAL_KEYFRAMES = 256;
export const MAX_AUTHORED_MOTIONS = 24;
export const MAX_SPEC_BYTES = 64 * 1024;

const MAX_MOTION_BYTES = 256 * 1024;
const MAX_MODEL_JSON_BYTES = 16 * 1024 * 1024;
const MAX_REFERENCE_MOTION_BYTES = 4 * 1024 * 1024;
const MAX_REFERENCE_MOTIONS = 512;
const MAX_DESCRIPTION_CHARS = 1_200;
const MAX_NAME_CHARS = 64;
const MAX_REASON_CHARS = 160;
const EPSILON = 1e-6;
const MOTION_ID_RE = /^promptsoul_ai_[a-z0-9][a-z0-9_-]{0,47}$/;
const PUBLIC_MOTION_ID_RE = /^promptsoul_ai_[0-9a-f]{12}$/;
const INTERNAL_REVISION_RE = /^[0-9a-f]{12}$/;
const OPAQUE_REVISION_RE = /^rev_[0-9a-f]{16}$/;
const PARAMETER_ID_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const CONTROL_TOKEN_RE = /^c[0-9]{2,4}$/;
const CONTROL_CHARACTER_RE = /\p{C}/u;

type JsonObject = Record<string, unknown>;

export class MotionAuthoringError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = 'motion_authoring_error', status = 422) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
  }
}

export class MotionSpecError extends MotionAuthoringError {
  constructor(message: string) {
    super(message, 'invalid_motion_spec', 422);
  }
}

export class MotionNotFeasibleError extends MotionAuthoringError {
  constructor() {
    super('该动作无法用当前模型的安全控制项自然实现。', 'motion_not_feasible', 422);
  }
}

export class ModelAnalysisError extends MotionAuthoringError {
  constructor(message: string) {
    super(message, 'model_not_ready', 409);
  }
}

export class MotionConflictError extends MotionAuthoringError {
  constructor(message: string, code = 'motion_conflict') {
    super(message, code, 409);
  }
}

export class MotionLimitError extends MotionAuthoringError {
  constructor(message = `this model already has the maximum of ${MAX_AUTHORED_MOTIONS} AI motions`) {
    super(message, 'motion_limit_reached', 409);
  }
}

export class MotionNotFoundError extends MotionAuthoringError {
  constructor(message = 'the requested AI-authored motion does not exist for the active model') {
    super(message, 'motion_not_found', 404);
  }
}

export interface KeyframeSpec {
  readonly time: number;
  readonly value: number;
}

export interface NormalizedCurveSpec {
  readonly control: string;
  readonly keyframes: readonly KeyframeSpec[];
}

export interface NormalizedMotionSpec {
  readonly id: string;
  readonly name: string;
  readonly duration: number;
  readonly fadeIn: number;
  readonly fadeOut: number;
  readonly curves: readonly NormalizedCurveSpec[];
}

interface CompiledCurveSpec {
  readonly parameter: string;
  readonly keyframes: readonly KeyframeSpec[];
}

interface CompiledMotionSpec {
  readonly id: string;
  readonly name: string;
  readonly duration: number;
  readonly fadeIn: number;
  readonly fadeOut: number;
  readonly curves: readonly CompiledCurveSpec[];
}

export interface ControlProfile {
  readonly token: string;
  readonly parameterId: string;
  readonly displayName: string;
  readonly minimum: number;
  readonly maximum: number;
  readonly base: number;
}

export interface ModelProfile {
  readonly root: string;
  readonly runtime: string;
  readonly model3Path: string;
  readonly modelStem: string;
  readonly controls: readonly ControlProfile[];
  readonly availableIds: ReadonlySet<string>;
  readonly physicsOutputs: ReadonlySet<string>;
  readonly partOpacityIds: ReadonlySet<string>;
  readonly safeRanges: ReadonlyMap<string, readonly [number, number]>;
  readonly basePose: ReadonlyMap<string, number>;
  readonly referenceMotionCount: number;
  readonly revision: string;
}

export interface PublicAuthoredMotion {
  readonly id: string;
  readonly motionId: string;
  readonly name: string;
  readonly label: string;
  readonly displayName: string;
  readonly group: typeof MOTION_GROUP;
  readonly index: number;
  readonly duration: number;
  readonly revision: string;
  readonly replaced: boolean;
}

export interface DeletedAuthoredMotion {
  readonly motion: PublicAuthoredMotion;
  readonly revision: string;
  readonly cleanupPending: boolean;
}

/** A small JSON scanner used before JSON.parse so duplicate object keys fail closed. */
class StrictJsonScanner {
  private index = 0;

  constructor(private readonly text: string) {}

  scan(): void {
    this.skipWhitespace();
    this.value(0);
    this.skipWhitespace();
    if (this.index !== this.text.length) this.fail();
  }

  private value(depth: number): void {
    if (depth > 128) throw new MotionSpecError('JSON nesting is too deep');
    const char = this.text[this.index];
    if (char === '{') this.object(depth + 1);
    else if (char === '[') this.array(depth + 1);
    else if (char === '"') this.string();
    else if (char === 't') this.literal('true');
    else if (char === 'f') this.literal('false');
    else if (char === 'n') this.literal('null');
    else this.number();
  }

  private object(depth: number): void {
    this.index += 1;
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.text[this.index] === '}') {
      this.index += 1;
      return;
    }
    while (true) {
      if (this.text[this.index] !== '"') this.fail();
      const key = this.string();
      if (keys.has(key)) throw new MotionSpecError(`JSON contains a duplicate key: ${key}`);
      keys.add(key);
      this.skipWhitespace();
      if (this.text[this.index] !== ':') this.fail();
      this.index += 1;
      this.skipWhitespace();
      this.value(depth);
      this.skipWhitespace();
      const separator = this.text[this.index];
      this.index += 1;
      if (separator === '}') return;
      if (separator !== ',') this.fail();
      this.skipWhitespace();
    }
  }

  private array(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.text[this.index] === ']') {
      this.index += 1;
      return;
    }
    while (true) {
      this.value(depth);
      this.skipWhitespace();
      const separator = this.text[this.index];
      this.index += 1;
      if (separator === ']') return;
      if (separator !== ',') this.fail();
      this.skipWhitespace();
    }
  }

  private string(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (code === 0x22) {
        this.index += 1;
        try {
          return JSON.parse(this.text.slice(start, this.index)) as string;
        } catch {
          this.fail();
        }
      }
      if (code < 0x20) this.fail();
      if (code === 0x5c) {
        this.index += 1;
        const escaped = this.text[this.index];
        if (escaped === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(this.text.slice(this.index + 1, this.index + 5))) {
            this.fail();
          }
          this.index += 5;
          continue;
        }
        if (!escaped || !'"\\/bfnrt'.includes(escaped)) this.fail();
      }
      this.index += 1;
    }
    this.fail();
  }

  private number(): void {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      this.text.slice(this.index),
    );
    if (!match) this.fail();
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new MotionSpecError('non-finite JSON number is not allowed');
    this.index += match[0].length;
  }

  private literal(literal: string): void {
    if (!this.text.startsWith(literal, this.index)) this.fail();
    this.index += literal.length;
  }

  private skipWhitespace(): void {
    while (' \t\r\n'.includes(this.text[this.index] ?? '\0')) this.index += 1;
  }

  private fail(): never {
    throw new MotionSpecError('document is not strict JSON');
  }
}

export function parseStrictJson(raw: string | Uint8Array, limit = MAX_SPEC_BYTES, label = 'document'): unknown {
  let text: string;
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw, 'utf8') > limit) {
      throw new MotionSpecError(`${label} exceeds the ${limit}-byte limit`);
    }
    text = raw;
  } else if (raw instanceof Uint8Array) {
    if (raw.byteLength > limit) throw new MotionSpecError(`${label} exceeds the ${limit}-byte limit`);
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      throw new MotionSpecError(`${label} is not valid UTF-8`);
    }
  } else {
    throw new MotionSpecError(`${label} must be a JSON string`);
  }
  try {
    new StrictJsonScanner(text).scan();
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof MotionSpecError) {
      if (error.message === 'document is not strict JSON') {
        throw new MotionSpecError(`${label} is not strict JSON`);
      }
      throw error;
    }
    throw new MotionSpecError(`${label} is not strict JSON`);
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, keys: readonly string[], jsonPath: string): JsonObject {
  if (!isObject(value)) throw new MotionSpecError(`${jsonPath} must be an object`);
  const expected = new Set(keys);
  const actual = Object.keys(value);
  const missing = keys.filter((key) => !(key in value));
  const extra = actual.filter((key) => !expected.has(key));
  if (missing.length || extra.length) {
    const detail = [
      missing.length ? `missing ${missing.join(', ')}` : '',
      extra.length ? `unexpected ${extra.sort().join(', ')}` : '',
    ].filter(Boolean);
    throw new MotionSpecError(`${jsonPath} has invalid fields (${detail.join('; ')})`);
  }
  return value;
}

function finiteNumber(value: unknown, jsonPath: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MotionSpecError(`${jsonPath} must be a finite number`);
  }
  return value;
}

function safeText(value: unknown, jsonPath: string, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new MotionSpecError(`${jsonPath} must be 1-${maximum} characters`);
  }
  if (value !== value.trim() || CONTROL_CHARACTER_RE.test(value)) {
    throw new MotionSpecError(`${jsonPath} contains unsafe whitespace or control characters`);
  }
  return value;
}

function validateMotionId(value: unknown, jsonPath = '$.id'): string {
  if (typeof value !== 'string' || !MOTION_ID_RE.test(value)) {
    throw new MotionSpecError(`${jsonPath} is not a valid PromptSoul AI motion id`);
  }
  return value;
}

function snap(value: number): number {
  return Number((Math.round(value * FPS) / FPS).toFixed(3));
}

export function normalizeMotionPrompt(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

export function motionIdForDescription(description: string): string {
  if (typeof description !== 'string') throw new MotionSpecError('description must be text');
  const cleaned = normalizeMotionPrompt(description);
  if (!cleaned || cleaned.length > MAX_DESCRIPTION_CHARS) {
    throw new MotionSpecError(`description must be 1-${MAX_DESCRIPTION_CHARS} characters`);
  }
  if (CONTROL_CHARACTER_RE.test(cleaned)) {
    throw new MotionSpecError('description contains control characters');
  }
  return `promptsoul_ai_${createHash('sha256').update(cleaned, 'utf8').digest('hex').slice(0, 12)}`;
}

function normalizedSpecDocument(spec: NormalizedMotionSpec): JsonObject {
  return {
    status: 'ok',
    id: spec.id,
    name: spec.name,
    duration: spec.duration,
    fade_in: spec.fadeIn,
    fade_out: spec.fadeOut,
    curves: spec.curves.map((curve) => ({
      control: curve.control,
      keyframes: curve.keyframes.map((keyframe) => ({ ...keyframe })),
    })),
  };
}

export function parseMotionSpec(
  raw: string | Uint8Array | NormalizedMotionSpec,
): NormalizedMotionSpec {
  let parsed: unknown;
  if (typeof raw === 'string' || raw instanceof Uint8Array) {
    parsed = parseStrictJson(raw, MAX_SPEC_BYTES, 'motion spec');
  } else {
    try {
      parsed = parseStrictJson(JSON.stringify(normalizedSpecDocument(raw)), MAX_SPEC_BYTES, 'motion spec');
    } catch (error) {
      if (error instanceof MotionAuthoringError) throw error;
      throw new MotionSpecError('motion spec object contains invalid values');
    }
  }
  if (!isObject(parsed)) throw new MotionSpecError('$ must be an object');
  if (parsed.status === 'unsupported') {
    const keys = Object.prototype.hasOwnProperty.call(parsed, 'reason') ? ['status', 'reason'] : ['status'];
    const unsupported = requireObject(parsed, keys, '$');
    if ('reason' in unsupported) safeText(unsupported.reason, '$.reason', MAX_REASON_CHARS);
    throw new MotionNotFeasibleError();
  }
  const object = requireObject(
    parsed,
    ['status', 'id', 'name', 'duration', 'fade_in', 'fade_out', 'curves'],
    '$',
  );
  if (object.status !== 'ok') throw new MotionSpecError("$.status must be 'ok' or 'unsupported'");
  const id = validateMotionId(object.id);
  const name = safeText(object.name, '$.name', MAX_NAME_CHARS);
  const duration = finiteNumber(object.duration, '$.duration');
  const fadeIn = finiteNumber(object.fade_in, '$.fade_in');
  const fadeOut = finiteNumber(object.fade_out, '$.fade_out');
  if (duration < MIN_DURATION || duration > MAX_DURATION) {
    throw new MotionSpecError(`$.duration must be in [${MIN_DURATION}, ${MAX_DURATION}]`);
  }
  if (fadeIn < MIN_FADE || fadeIn > MAX_FADE || fadeOut < MIN_FADE || fadeOut > MAX_FADE) {
    throw new MotionSpecError(`fade values must be in [${MIN_FADE}, ${MAX_FADE}]`);
  }
  if (!Array.isArray(object.curves) || object.curves.length < 1 || object.curves.length > MAX_CURVES) {
    throw new MotionSpecError(`$.curves must contain 1-${MAX_CURVES} curves`);
  }

  const seenControls = new Set<string>();
  let totalKeyframes = 0;
  const curves = object.curves.map((rawCurve, curveIndex): NormalizedCurveSpec => {
    const prefix = `$.curves[${curveIndex}]`;
    const curve = requireObject(rawCurve, ['control', 'keyframes'], prefix);
    if (typeof curve.control !== 'string' || !CONTROL_TOKEN_RE.test(curve.control)) {
      throw new MotionSpecError(`${prefix}.control is invalid`);
    }
    if (seenControls.has(curve.control)) throw new MotionSpecError(`${prefix}.control is duplicated`);
    seenControls.add(curve.control);
    if (
      !Array.isArray(curve.keyframes)
      || curve.keyframes.length < 3
      || curve.keyframes.length > MAX_KEYFRAMES_PER_CURVE
    ) {
      throw new MotionSpecError(
        `${prefix}.keyframes must contain 3-${MAX_KEYFRAMES_PER_CURVE} items`,
      );
    }
    totalKeyframes += curve.keyframes.length;
    if (totalKeyframes > MAX_TOTAL_KEYFRAMES) {
      throw new MotionSpecError(`motion exceeds the ${MAX_TOTAL_KEYFRAMES}-keyframe total limit`);
    }
    const keyframes = curve.keyframes.map((rawKey, keyIndex): KeyframeSpec => {
      const keyPrefix = `${prefix}.keyframes[${keyIndex}]`;
      const key = requireObject(rawKey, ['time', 'value'], keyPrefix);
      const time = finiteNumber(key.time, `${keyPrefix}.time`);
      const value = finiteNumber(key.value, `${keyPrefix}.value`);
      if (value < -1 || value > 1) {
        throw new MotionSpecError(`${keyPrefix}.value must be normalized to [-1, 1]`);
      }
      return { time, value };
    });
    if (Math.abs(keyframes[0].time) > EPSILON || Math.abs(keyframes[0].value) > EPSILON) {
      throw new MotionSpecError(`${prefix} must start at time 0 with value 0`);
    }
    const last = keyframes[keyframes.length - 1];
    if (Math.abs(last.time - duration) > EPSILON || Math.abs(last.value) > EPSILON) {
      throw new MotionSpecError(`${prefix} must end at duration with value 0`);
    }
    for (let index = 1; index < keyframes.length; index += 1) {
      if (keyframes[index].time <= keyframes[index - 1].time + EPSILON) {
        throw new MotionSpecError(`${prefix} keyframe times must be strictly increasing`);
      }
    }
    if (!keyframes.slice(1, -1).some((key) => Math.abs(key.value) > EPSILON)) {
      throw new MotionSpecError(`${prefix} is a no-op curve`);
    }
    return { control: curve.control, keyframes };
  });
  return { id, name, duration, fadeIn, fadeOut, curves };
}

function pathIsInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveInside(runtime: string, relative: unknown, label: string): string {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || path.isAbsolute(relative)) {
    throw new ModelAnalysisError(`invalid ${label} path`);
  }
  const candidate = path.resolve(runtime, relative);
  if (!pathIsInside(candidate, path.resolve(runtime))) {
    throw new ModelAnalysisError(`${label} path escapes the active model`);
  }
  if (existsSync(candidate)) {
    const resolved = realpathSync(candidate);
    if (!pathIsInside(resolved, realpathSync(runtime))) {
      throw new ModelAnalysisError(`${label} path escapes the active model`);
    }
    return resolved;
  }
  return candidate;
}

function modelNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ModelAnalysisError(`non-finite curve data in ${label}`);
  }
  return value;
}

function curvePoints(curve: JsonObject, label: string): { points: KeyframeSpec[]; values: number[] } {
  const segments = curve.Segments;
  if (!Array.isArray(segments) || segments.length < 2) {
    throw new ModelAnalysisError(`invalid curve segments in ${label}`);
  }
  const firstTime = modelNumber(segments[0], label);
  const firstValue = modelNumber(segments[1], label);
  const points: KeyframeSpec[] = [{ time: firstTime, value: firstValue }];
  const values = [firstValue];
  let index = 2;
  while (index < segments.length) {
    const segmentType = modelNumber(segments[index], label);
    if (!Number.isInteger(segmentType)) throw new ModelAnalysisError(`invalid segment type in ${label}`);
    if (segmentType === 1) {
      if (index + 6 >= segments.length) throw new ModelAnalysisError(`truncated bezier segment in ${label}`);
      const tuple = segments.slice(index + 1, index + 7).map((value) => modelNumber(value, label));
      points.push({ time: tuple[4], value: tuple[5] });
      values.push(tuple[1], tuple[3], tuple[5]);
      index += 7;
    } else if (segmentType === 0 || segmentType === 2 || segmentType === 3) {
      if (index + 2 >= segments.length) throw new ModelAnalysisError(`truncated segment in ${label}`);
      const time = modelNumber(segments[index + 1], label);
      const value = modelNumber(segments[index + 2], label);
      points.push({ time, value });
      values.push(value);
      index += 3;
    } else {
      throw new ModelAnalysisError(`unknown segment type in ${label}`);
    }
  }
  return { points, values };
}

function readJson(pathname: string, limit: number, label: string): unknown {
  try {
    if (statSync(pathname).size > limit) throw new ModelAnalysisError(`${label} is too large`);
    return parseStrictJson(readFileSync(pathname), limit, label);
  } catch (error) {
    if (error instanceof ModelAnalysisError) throw error;
    if (error instanceof MotionSpecError) {
      throw new ModelAnalysisError(`invalid ${label}: ${error.message}`);
    }
    throw new ModelAnalysisError(`could not read ${label}`);
  }
}

function walkFiles(root: string, suffix: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const stats = lstatSync(entryPath);
      if (stats.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(entryPath);
    }
  };
  visit(root);
  return files.sort();
}

function semanticName(rawName: unknown, parameterId: string, ordinal: number): string {
  if (typeof rawName !== 'string') return `Model control ${String(ordinal).padStart(2, '0')}`;
  const cleaned = rawName.trim().replace(/\s+/gu, ' ').slice(0, 48);
  if (!cleaned || cleaned.toLocaleLowerCase().includes(parameterId.toLocaleLowerCase()) || CONTROL_CHARACTER_RE.test(cleaned)) {
    return `Model control ${String(ordinal).padStart(2, '0')}`;
  }
  return cleaned;
}

function looksLikeOpacity(parameterId: string, displayName: string): boolean {
  const combined = `${parameterId} ${displayName}`.toLocaleLowerCase();
  return combined.includes('opacity') || combined.includes('不透明') || combined.includes('透明度');
}

function updateDigestWithFiles(hash: ReturnType<typeof createHash>, files: readonly string[]): void {
  for (const filename of [...new Set(files)].sort()) {
    hash.update('\0');
    hash.update(path.basename(filename), 'utf8');
    try {
      hash.update(readFileSync(filename));
    } catch {
      throw new ModelAnalysisError('model changed while it was being analyzed');
    }
  }
}

export function loadModelProfile(root = process.cwd()): ModelProfile {
  const rootPath = path.resolve(root);
  const config = readJson(path.join(rootPath, 'model.config.json'), MAX_SPEC_BYTES, 'model.config.json');
  if (!isObject(config) || typeof config.model3 !== 'string') {
    throw new ModelAnalysisError('model.config.json has no valid model3 entry');
  }
  const modelsRootPath = path.join(rootPath, 'models');
  let modelsRoot: string;
  let model3Path: string;
  try {
    modelsRoot = realpathSync(modelsRootPath);
    model3Path = realpathSync(path.resolve(rootPath, config.model3));
  } catch {
    throw new ModelAnalysisError('the active model could not be resolved');
  }
  if (!pathIsInside(model3Path, modelsRoot)) {
    throw new ModelAnalysisError('the active model must be under models/');
  }
  const runtime = path.dirname(model3Path);
  if (path.dirname(runtime) !== modelsRoot || !model3Path.endsWith('.model3.json')) {
    throw new ModelAnalysisError('the active model path is not a direct models/<name> runtime');
  }
  const model3Bytes = readFileSync(model3Path);
  const model3 = readJson(model3Path, MAX_MODEL_JSON_BYTES, 'model3.json');
  if (!isObject(model3)) throw new ModelAnalysisError('model3.json must be an object');
  const references = model3.FileReferences ?? {};
  if (!isObject(references)) throw new ModelAnalysisError('model3.json FileReferences must be an object');
  const groups = references.Motions ?? {};
  if (!isObject(groups)) throw new ModelAnalysisError('model3.json motion groups must be an object');

  const generatedPaths = new Set<string>();
  const promptEntries = groups[MOTION_GROUP] ?? [];
  if (!Array.isArray(promptEntries)) throw new ModelAnalysisError(`${MOTION_GROUP} motion group must be a list`);
  for (const entry of promptEntries) {
    if (isObject(entry) && typeof entry.File === 'string') {
      generatedPaths.add(path.resolve(resolveInside(runtime, entry.File, 'motion')));
    }
  }
  const referenceFiles = walkFiles(runtime, '.motion3.json').filter(
    (filename) => !generatedPaths.has(path.resolve(filename)) && !path.basename(filename).startsWith('promptsoul_ai_'),
  );
  if (referenceFiles.length > MAX_REFERENCE_MOTIONS) {
    throw new ModelAnalysisError('the model contains too many reference motions');
  }

  const cdiFiles = walkFiles(runtime, '.cdi3.json');
  const names = new Map<string, string>();
  for (const cdiPath of cdiFiles) {
    const cdi = readJson(cdiPath, MAX_REFERENCE_MOTION_BYTES, 'cdi3.json');
    if (!isObject(cdi) || !Array.isArray(cdi.Parameters)) {
      throw new ModelAnalysisError('invalid cdi3.json parameter catalog');
    }
    for (const parameter of cdi.Parameters) {
      if (isObject(parameter) && typeof parameter.Id === 'string' && !names.has(parameter.Id)) {
        names.set(parameter.Id, typeof parameter.Name === 'string' ? parameter.Name : '');
      }
    }
  }

  const physicsFiles = walkFiles(runtime, '.physics3.json');
  const physicsOutputs = new Set<string>();
  for (const physicsPath of physicsFiles) {
    const physics = readJson(physicsPath, MAX_REFERENCE_MOTION_BYTES, 'physics3.json');
    if (!isObject(physics)) throw new ModelAnalysisError('invalid physics3.json');
    const settings = physics.PhysicsSettings ?? [];
    if (!Array.isArray(settings)) throw new ModelAnalysisError('invalid physics3.json settings');
    for (const setting of settings) {
      if (!isObject(setting) || !Array.isArray(setting.Output)) continue;
      for (const output of setting.Output) {
        if (!isObject(output) || !isObject(output.Destination)) continue;
        if (typeof output.Destination.Id === 'string') physicsOutputs.add(output.Destination.Id);
      }
    }
  }

  const ranges = new Map<string, [number, number]>();
  const firstValues = new Map<string, Map<number, number>>();
  const inferredIds = new Set<string>();
  const partOpacityIds = new Set<string>();
  for (const motionPath of referenceFiles) {
    const motion = readJson(motionPath, MAX_REFERENCE_MOTION_BYTES, 'reference motion');
    if (!isObject(motion) || !Array.isArray(motion.Curves)) {
      throw new ModelAnalysisError('invalid reference motion');
    }
    for (const rawCurve of motion.Curves) {
      if (!isObject(rawCurve) || typeof rawCurve.Id !== 'string') continue;
      if (rawCurve.Target === 'PartOpacity') {
        partOpacityIds.add(rawCurve.Id);
        continue;
      }
      if (rawCurve.Target !== 'Parameter') continue;
      const parameterId = rawCurve.Id;
      inferredIds.add(parameterId);
      const { points, values } = curvePoints(rawCurve, path.basename(motionPath));
      if (!points.length) continue;
      const current = ranges.get(parameterId) ?? [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
      current[0] = Math.min(current[0], ...values);
      current[1] = Math.max(current[1], ...values);
      ranges.set(parameterId, current);
      const rounded = Number(points[0].value.toFixed(3));
      const counts = firstValues.get(parameterId) ?? new Map<number, number>();
      counts.set(rounded, (counts.get(rounded) ?? 0) + 1);
      firstValues.set(parameterId, counts);
    }
  }

  const availableIds = new Set(names.size ? names.keys() : inferredIds);
  const safeRanges = new Map<string, readonly [number, number]>();
  const basePose = new Map<string, number>();
  for (const [parameterId, range] of ranges) {
    if (availableIds.has(parameterId)) safeRanges.set(parameterId, range);
  }
  for (const [parameterId, counts] of firstValues) {
    if (!availableIds.has(parameterId) || !counts.size) continue;
    const base = [...counts.entries()].sort((left, right) => right[1] - left[1])[0][0];
    basePose.set(parameterId, base);
  }
  const authorableIds = [...availableIds]
    .filter((parameterId) => {
      const range = safeRanges.get(parameterId);
      return Boolean(
        range
        && basePose.has(parameterId)
        && !physicsOutputs.has(parameterId)
        && !partOpacityIds.has(parameterId)
        && !looksLikeOpacity(parameterId, names.get(parameterId) ?? '')
        && range[1] - range[0] > EPSILON,
      );
    })
    .sort();
  const controls = authorableIds.map((parameterId, offset): ControlProfile => {
    const ordinal = offset + 1;
    const range = safeRanges.get(parameterId)!;
    return {
      token: `c${String(ordinal).padStart(2, '0')}`,
      parameterId,
      displayName: semanticName(names.get(parameterId) ?? '', parameterId, ordinal),
      minimum: range[0],
      maximum: range[1],
      base: basePose.get(parameterId)!,
    };
  });
  const revisionHash = createHash('sha256').update(model3Bytes);
  updateDigestWithFiles(revisionHash, [...referenceFiles, ...cdiFiles, ...physicsFiles]);
  return {
    root: rootPath,
    runtime,
    model3Path,
    modelStem: path.basename(model3Path, '.model3.json'),
    controls,
    availableIds,
    physicsOutputs,
    partOpacityIds,
    safeRanges,
    basePose,
    referenceMotionCount: referenceFiles.length,
    revision: revisionHash.digest('hex').slice(0, 16),
  };
}

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export function buildAuthoringMessages(
  description: string,
  profile: ModelProfile = loadModelProfile(),
  motionId: string = motionIdForDescription(description),
): ChatMessage[] {
  const generatedId = motionIdForDescription(description);
  const validatedId = validateMotionId(motionId, 'motion_id');
  if (!profile.controls.length) {
    throw new ModelAnalysisError('the active model has no safely authorable controls');
  }
  const catalog = profile.controls.map((control) => ({
    control: control.token,
    name: control.displayName,
  }));
  const schema = {
    status: 'ok',
    id: validatedId,
    name: 'short display label',
    duration: '0.5..8.0',
    fade_in: '0.2..0.5',
    fade_out: '0.2..0.5',
    curves: [{
      control: 'one catalog token',
      keyframes: [
        { time: 0, value: 0 },
        { time: 'strictly increasing', value: '-1..1' },
        { time: 'duration', value: 0 },
      ],
    }],
  };
  const system = [
    'You design one safe, readable Live2D action using only the opaque controls listed below.',
    'Return one JSON object and no markdown. Use each control at most once.',
    'Values are normalized: -1 and 1 mean the observed safe extremes, 0 means the resting pose.',
    'Match the requested intensity. For large, strong, exaggerated, or clearly visible actions, drive the primary head/body controls to about 0.65..0.9 of their normalized safe range, coordinate several relevant face/body controls, and reserve exactly -1 or 1 for brief intentional peaks only.',
    'For ordinary requests, prefer moderate 0.3..0.65 values. Keep subtle values below 0.3 only when the description explicitly asks for a small or gentle action.',
    'Make the main silhouette change readable at full-body scale; do not rely only on eyes, brows, mouth, or values below 0.2 for a strong action.',
    'Every curve needs 3-24 keyframes, starts at time/value 0/0, ends exactly at duration/value 0, and has a non-zero middle value.',
    'Use 1-24 curves and at most 256 keyframes total. Do not invent controls.',
    'If the requested action cannot be expressed naturally with this catalog, return exactly {"status":"unsupported"}; an optional short reason is allowed.',
    `Public control catalog:\n${JSON.stringify(catalog)}`,
    `Required success schema:\n${JSON.stringify(schema)}`,
  ].join(' ');
  const user = JSON.stringify({
    required_id: validatedId,
    action_description: normalizeMotionPrompt(description),
  });
  // Keep the generated value referenced so a caller cannot bypass description validation
  // by supplying a valid-looking ID with an invalid description.
  void generatedId;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

function validateCompiledSpec(spec: CompiledMotionSpec, profile: ModelProfile, expectedId: string): void {
  if (spec.id !== expectedId) throw new MotionSpecError('saved motion id does not match its expected id');
  if (spec.duration < MIN_DURATION || spec.duration > MAX_DURATION) {
    throw new MotionSpecError('compiled duration is outside the allowed range');
  }
  if (spec.fadeIn < MIN_FADE || spec.fadeIn > MAX_FADE || spec.fadeOut < MIN_FADE || spec.fadeOut > MAX_FADE) {
    throw new MotionSpecError('compiled fade is outside the allowed range');
  }
  if (spec.curves.length < 1 || spec.curves.length > MAX_CURVES) {
    throw new MotionSpecError('compiled motion has an invalid curve count');
  }
  const authorable = new Set(profile.controls.map((control) => control.parameterId));
  const seen = new Set<string>();
  let total = 0;
  for (const curve of spec.curves) {
    if (seen.has(curve.parameter)) throw new MotionSpecError('compiled motion contains a duplicate parameter');
    seen.add(curve.parameter);
    if (profile.partOpacityIds.has(curve.parameter) || looksLikeOpacity(curve.parameter, '')) {
      throw new MotionSpecError('PartOpacity controls cannot be authored');
    }
    if (profile.physicsOutputs.has(curve.parameter)) {
      throw new MotionSpecError('physics output controls cannot be authored');
    }
    if (!profile.availableIds.has(curve.parameter)) throw new MotionSpecError('compiled motion contains an unknown parameter');
    if (!authorable.has(curve.parameter)) throw new MotionSpecError('compiled parameter is not an authorable control');
    const range = profile.safeRanges.get(curve.parameter);
    const base = profile.basePose.get(curve.parameter);
    if (!range || base === undefined) {
      throw new MotionSpecError('compiled parameter has no observed safe range/base pose');
    }
    if (curve.keyframes.length < 3 || curve.keyframes.length > MAX_KEYFRAMES_PER_CURVE) {
      throw new MotionSpecError('compiled curve has an invalid keyframe count');
    }
    total += curve.keyframes.length;
    if (total > MAX_TOTAL_KEYFRAMES) throw new MotionSpecError('compiled motion has too many keyframes');
    const first = curve.keyframes[0];
    const last = curve.keyframes[curve.keyframes.length - 1];
    if (Math.abs(first.time) > EPSILON || Math.abs(last.time - spec.duration) > EPSILON) {
      throw new MotionSpecError('compiled curve has invalid endpoints');
    }
    for (let index = 0; index < curve.keyframes.length; index += 1) {
      const keyframe = curve.keyframes[index];
      if (!Number.isFinite(keyframe.time) || !Number.isFinite(keyframe.value)) {
        throw new MotionSpecError('compiled curve contains a non-finite number');
      }
      if (keyframe.value < range[0] - EPSILON || keyframe.value > range[1] + EPSILON) {
        throw new MotionSpecError('compiled curve value is outside the observed range');
      }
      if (index && keyframe.time <= curve.keyframes[index - 1].time + EPSILON) {
        throw new MotionSpecError('compiled curve times are not strictly increasing');
      }
    }
    if (Math.abs(first.value - base) > EPSILON || Math.abs(last.value - base) > EPSILON) {
      throw new MotionSpecError('compiled curve must start and end at the base pose');
    }
    if (!curve.keyframes.slice(1, -1).some((key) => Math.abs(key.value - base) > EPSILON)) {
      throw new MotionSpecError('compiled curve is a no-op');
    }
  }
}

function compileSpec(spec: NormalizedMotionSpec, profile: ModelProfile, expectedId: string): CompiledMotionSpec {
  const validatedId = validateMotionId(expectedId, 'expected_id');
  if (spec.id !== validatedId) throw new MotionSpecError('motion id does not match the server-assigned id');
  const controls = new Map(profile.controls.map((control) => [control.token, control]));
  const duration = snap(spec.duration);
  const curves = spec.curves.map((curve, curveIndex): CompiledCurveSpec => {
    const control = controls.get(curve.control);
    if (!control) throw new MotionSpecError(`$.curves[${curveIndex}].control is not in the catalog`);
    const keyframes = curve.keyframes.map((keyframe): KeyframeSpec => {
      const normalized = Number(keyframe.value.toFixed(6));
      const value = normalized >= 0
        ? control.base + normalized * (control.maximum - control.base)
        : control.base + -normalized * (control.minimum - control.base);
      return { time: snap(keyframe.time), value: Number(value.toFixed(3)) };
    });
    for (let index = 1; index < keyframes.length; index += 1) {
      if (keyframes[index].time <= keyframes[index - 1].time + EPSILON) {
        throw new MotionSpecError(`$.curves[${curveIndex}] times collide after snapping to 30 fps`);
      }
    }
    if (Math.abs(keyframes[keyframes.length - 1].time - duration) > EPSILON) {
      throw new MotionSpecError(`$.curves[${curveIndex}] does not end at snapped duration`);
    }
    return { parameter: control.parameterId, keyframes };
  });
  const compiled = {
    id: spec.id,
    name: spec.name,
    duration,
    fadeIn: Number(spec.fadeIn.toFixed(3)),
    fadeOut: Number(spec.fadeOut.toFixed(3)),
    curves,
  } satisfies CompiledMotionSpec;
  validateCompiledSpec(compiled, profile, validatedId);
  return compiled;
}

function compiledDocument(spec: CompiledMotionSpec): JsonObject {
  return {
    version: 1,
    id: spec.id,
    name: spec.name,
    duration: spec.duration,
    fade_in: spec.fadeIn,
    fade_out: spec.fadeOut,
    curves: spec.curves.map((curve) => ({
      parameter: curve.parameter,
      keyframes: curve.keyframes.map((keyframe) => ({ ...keyframe })),
    })),
  };
}

function parseCompiledSpec(raw: string | Uint8Array): CompiledMotionSpec {
  const parsed = parseStrictJson(raw, MAX_SPEC_BYTES, 'saved motion spec');
  const object = requireObject(
    parsed,
    ['version', 'id', 'name', 'duration', 'fade_in', 'fade_out', 'curves'],
    '$',
  );
  if (object.version !== 1) throw new MotionSpecError('unsupported saved motion spec version');
  const id = validateMotionId(object.id);
  const name = safeText(object.name, '$.name', MAX_NAME_CHARS);
  const duration = finiteNumber(object.duration, '$.duration');
  const fadeIn = finiteNumber(object.fade_in, '$.fade_in');
  const fadeOut = finiteNumber(object.fade_out, '$.fade_out');
  if (!Array.isArray(object.curves)) throw new MotionSpecError('$.curves must be a list');
  const curves = object.curves.map((rawCurve, curveIndex): CompiledCurveSpec => {
    const prefix = `$.curves[${curveIndex}]`;
    const curve = requireObject(rawCurve, ['parameter', 'keyframes'], prefix);
    if (typeof curve.parameter !== 'string' || !PARAMETER_ID_RE.test(curve.parameter)) {
      throw new MotionSpecError(`${prefix}.parameter is invalid`);
    }
    if (!Array.isArray(curve.keyframes)) throw new MotionSpecError(`${prefix}.keyframes must be a list`);
    return {
      parameter: curve.parameter,
      keyframes: curve.keyframes.map((rawKey, keyIndex) => {
        const key = requireObject(rawKey, ['time', 'value'], `${prefix}.keyframes[${keyIndex}]`);
        return {
          time: finiteNumber(key.time, 'saved key time'),
          value: finiteNumber(key.value, 'saved key value'),
        };
      }),
    };
  });
  return { id, name, duration, fadeIn, fadeOut, curves };
}

function motionDocument(spec: CompiledMotionSpec): JsonObject {
  let totalSegments = 0;
  let totalPoints = 0;
  const curves = spec.curves.map((curve) => {
    const segments: number[] = [curve.keyframes[0].time, curve.keyframes[0].value];
    for (let index = 1; index < curve.keyframes.length; index += 1) {
      const left = curve.keyframes[index - 1];
      const right = curve.keyframes[index];
      const delta = (right.time - left.time) / 3;
      segments.push(
        1,
        Number((left.time + delta).toFixed(3)), left.value,
        Number((right.time - delta).toFixed(3)), right.value,
        right.time, right.value,
      );
      totalSegments += 1;
      totalPoints += 3;
    }
    totalPoints += 1;
    return { Target: 'Parameter', Id: curve.parameter, Segments: segments };
  });
  return {
    Version: 3,
    Meta: {
      Duration: spec.duration,
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
}

function jsonBytes(document: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
}

function authoredRevision(
  profile: ModelProfile,
  modelPayload: Uint8Array,
  motionPayload: Uint8Array,
): string {
  const activeModel = path.relative(profile.root, profile.model3Path);
  return createHash('sha256')
    .update(activeModel, 'utf8')
    .update('\0')
    .update(modelPayload)
    .update('\0')
    .update(motionPayload)
    .digest('hex')
    .slice(0, 12);
}

export function opaqueMotionRevision(revision: string): string {
  if (!INTERNAL_REVISION_RE.test(revision)) {
    throw new MotionConflictError('internal motion revision is invalid');
  }
  return `rev_${createHash('sha256').update(revision, 'utf8').digest('hex').slice(0, 16)}`;
}

export function atomicWrite(filename: string, payload: Uint8Array): void {
  mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, payload);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, filename);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

function savedDirectoryPath(profile: ModelProfile): string {
  const base = path.join(profile.root, 'motion-defs', 'generated');
  const directory = path.join(base, profile.modelStem);
  if (!pathIsInside(path.resolve(directory), path.resolve(base))) {
    throw new MotionConflictError('saved motion directory escapes motion-defs/generated');
  }
  return directory;
}

function savedDirectory(profile: ModelProfile): string {
  const directory = savedDirectoryPath(profile);
  const base = path.dirname(directory);
  mkdirSync(directory, { recursive: true });
  try {
    const root = realpathSync(profile.root);
    const realBase = realpathSync(base);
    const realDirectory = realpathSync(directory);
    if (!pathIsInside(realBase, root) || !pathIsInside(realDirectory, realBase)) {
      throw new MotionConflictError('saved motion directory escapes motion-defs/generated');
    }
  } catch (error) {
    if (error instanceof MotionAuthoringError) throw error;
    throw new MotionConflictError('saved motion directory could not be verified');
  }
  return directory;
}

function savedPath(profile: ModelProfile, motionId: string): string {
  validateMotionId(motionId);
  return path.join(savedDirectory(profile), `${motionId}.json`);
}

function withExclusiveLock<T>(root: string, callback: () => T): T {
  // Python's legacy implementation keeps a persistent flock file with the
  // `.lock` name. Node uses an atomic lock directory so acquisition itself is
  // portable and non-blocking without deleting that legacy file.
  const lockPath = path.join(path.resolve(root), 'models', '.promptsoul-motion-authoring.lockdir');
  mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    mkdirSync(lockPath);
  } catch (error) {
    const code = isObject(error) && typeof error.code === 'string' ? error.code : '';
    if (code === 'EEXIST') throw new MotionConflictError('another motion write is in progress');
    throw error;
  }
  try {
    atomicWrite(path.join(lockPath, 'owner'), Buffer.from(`${process.pid}\n`, 'utf8'));
    return callback();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function checkCapacity(profile: ModelProfile, motionId: string): void {
  const directory = savedDirectory(profile);
  const saved = readdirSync(directory).filter((filename) => filename.endsWith('.json'));
  if (!existsSync(path.join(directory, `${motionId}.json`)) && saved.length >= MAX_AUTHORED_MOTIONS) {
    throw new MotionLimitError();
  }
}

interface PreparedRegistration {
  readonly model3Payload: Buffer;
  readonly index: number;
  readonly replaced: boolean;
  readonly revision: string;
}

function prepareRegistration(
  profile: ModelProfile,
  spec: CompiledMotionSpec,
  motionPayload: Buffer,
): PreparedRegistration {
  if (motionPayload.byteLength > MAX_MOTION_BYTES) {
    throw new MotionSpecError('generated motion file exceeds the size limit');
  }
  const motionDirectory = path.join(profile.runtime, 'motion');
  mkdirSync(motionDirectory, { recursive: true });
  if (!pathIsInside(path.resolve(motionDirectory), path.resolve(profile.runtime))) {
    throw new MotionConflictError('motion directory escapes the active model');
  }
  const relativeFile = `motion/${spec.id}.motion3.json`;
  const outputPath = path.join(motionDirectory, `${spec.id}.motion3.json`);
  const model3 = readJson(profile.model3Path, MAX_MODEL_JSON_BYTES, 'model3.json');
  if (!isObject(model3)) throw new ModelAnalysisError('model3.json must be an object');
  if (model3.FileReferences === undefined) model3.FileReferences = {};
  if (!isObject(model3.FileReferences)) throw new ModelAnalysisError('model3.json FileReferences must be an object');
  if (model3.FileReferences.Motions === undefined) model3.FileReferences.Motions = {};
  if (!isObject(model3.FileReferences.Motions)) throw new ModelAnalysisError('model3.json motion groups must be an object');
  const groups = model3.FileReferences.Motions;
  for (const [groupName, entries] of Object.entries(groups)) {
    if (groupName === MOTION_GROUP || !Array.isArray(entries)) continue;
    if (entries.some((entry) => isObject(entry) && entry.File === relativeFile)) {
      throw new MotionConflictError('the generated path is referenced by a model-owned group');
    }
  }
  if (groups[MOTION_GROUP] === undefined) groups[MOTION_GROUP] = [];
  const entries = groups[MOTION_GROUP];
  if (!Array.isArray(entries)) throw new ModelAnalysisError(`${MOTION_GROUP} motion group must be a list`);
  const matches = entries
    .map((entry, index) => (isObject(entry) && entry.File === relativeFile ? index : -1))
    .filter((index) => index >= 0);
  if (matches.length > 1) throw new MotionConflictError('the PromptSoul group contains duplicate AI motion entries');
  const savedExists = existsSync(savedPath(profile, spec.id));
  if (existsSync(outputPath) && !matches.length && !savedExists) {
    throw new MotionConflictError('the generated motion filename is already occupied');
  }
  const entry = {
    File: relativeFile,
    Name: spec.name,
    FadeInTime: spec.fadeIn,
    FadeOutTime: spec.fadeOut,
  };
  const replaced = matches.length === 1;
  const index = replaced ? matches[0] : entries.length;
  if (replaced) entries[index] = entry;
  else entries.push(entry);
  const model3Payload = jsonBytes(model3);
  if (model3Payload.byteLength > MAX_MODEL_JSON_BYTES) {
    throw new MotionConflictError('updated model3.json would exceed the size limit');
  }
  const revision = authoredRevision(profile, model3Payload, motionPayload);
  return { model3Payload, index, replaced, revision };
}

function installCompiled(profile: ModelProfile, spec: CompiledMotionSpec, persist: boolean): PublicAuthoredMotion {
  checkCapacity(profile, spec.id);
  const specPayload = jsonBytes(compiledDocument(spec));
  if (specPayload.byteLength > MAX_SPEC_BYTES) throw new MotionSpecError('compiled motion spec exceeds the size limit');
  const motionPayload = jsonBytes(motionDocument(spec));
  const registration = prepareRegistration(profile, spec, motionPayload);
  if (persist) atomicWrite(savedPath(profile, spec.id), specPayload);
  atomicWrite(path.join(profile.runtime, 'motion', `${spec.id}.motion3.json`), motionPayload);
  atomicWrite(profile.model3Path, registration.model3Payload);
  return {
    id: spec.id,
    motionId: spec.id,
    name: spec.id,
    label: spec.name,
    displayName: spec.name,
    group: MOTION_GROUP,
    index: registration.index,
    duration: spec.duration,
    revision: registration.revision,
    replaced: registration.replaced,
  };
}

export interface AuthorMotionOptions {
  readonly root?: string;
  readonly expectedRevision?: string;
}

export function authorMotion(
  specOrJson: string | Uint8Array | NormalizedMotionSpec,
  expectedId: string,
  options: AuthorMotionOptions = {},
): PublicAuthoredMotion {
  const parsed = parseMotionSpec(specOrJson);
  const root = path.resolve(options.root ?? process.cwd());
  return withExclusiveLock(root, () => {
    const profile = loadModelProfile(root);
    if (options.expectedRevision !== undefined && profile.revision !== options.expectedRevision) {
      throw new MotionConflictError('the active model changed while the motion was being designed', 'model_changed');
    }
    return installCompiled(profile, compileSpec(parsed, profile, expectedId), true);
  });
}

function verifiedRegularFile(
  filename: string,
  parent: string,
  maximumBytes: number,
  label: string,
): Buffer {
  try {
    const parentStats = lstatSync(parent);
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
      throw new MotionConflictError(`${label} directory is not a regular directory`);
    }
    const stats = lstatSync(filename);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new MotionConflictError(`${label} is not a regular file`);
    }
    if (stats.size > maximumBytes) throw new MotionConflictError(`${label} exceeds its size limit`);
    const realParent = realpathSync(parent);
    const realFilename = realpathSync(filename);
    if (!pathIsInside(realFilename, realParent)) {
      throw new MotionConflictError(`${label} escapes its expected directory`);
    }
    return readFileSync(realFilename);
  } catch (error) {
    if (error instanceof MotionAuthoringError) throw error;
    throw new MotionConflictError(`${label} could not be verified`);
  }
}

export interface DeleteAuthoredMotionOptions {
  readonly root?: string;
  readonly expectedRevision: string;
}

/**
 * Removes one server-authored action from the active model only.
 *
 * The saved spec, generated runtime file, and PromptSoul registration must all
 * match the bytes this compiler would produce. This deliberately fails closed
 * instead of treating an arbitrary promptsoul_ai-looking path as owned data.
 */
export function deleteAuthoredMotion(
  motionId: string,
  options: DeleteAuthoredMotionOptions,
): DeletedAuthoredMotion {
  if (!isPublicMotionId(motionId)) {
    throw new MotionSpecError('motion id is not a public PromptSoul AI motion id');
  }
  if (!OPAQUE_REVISION_RE.test(options.expectedRevision)) {
    throw new MotionConflictError('expected motion revision is invalid', 'model_changed');
  }
  const root = path.resolve(options.root ?? process.cwd());
  return withExclusiveLock(root, () => {
    const profile = loadModelProfile(root);
    const directory = savedDirectoryPath(profile);
    const specPath = path.join(directory, `${motionId}.json`);
    if (!existsSync(specPath)) throw new MotionNotFoundError();

    const specPayload = verifiedRegularFile(specPath, directory, MAX_SPEC_BYTES, 'saved motion spec');
    const spec = parseCompiledSpec(specPayload);
    if (spec.id !== motionId || path.basename(specPath) !== `${spec.id}.json`) {
      throw new MotionConflictError('saved motion identity does not match the requested id');
    }
    validateCompiledSpec(spec, profile, motionId);

    const motionDirectory = path.join(profile.runtime, 'motion');
    const motionPath = path.join(motionDirectory, `${motionId}.motion3.json`);
    if (!existsSync(motionPath)) {
      throw new MotionConflictError('the persisted AI motion has no runtime file');
    }
    const motionPayload = verifiedRegularFile(
      motionPath,
      motionDirectory,
      MAX_MOTION_BYTES,
      'generated motion',
    );
    const expectedMotionPayload = jsonBytes(motionDocument(spec));
    if (!motionPayload.equals(expectedMotionPayload)) {
      throw new MotionConflictError('the generated motion does not match its persisted specification');
    }

    const originalModelPayload = verifiedRegularFile(
      profile.model3Path,
      profile.runtime,
      MAX_MODEL_JSON_BYTES,
      'model3.json',
    );
    const model3 = parseStrictJson(originalModelPayload, MAX_MODEL_JSON_BYTES, 'model3.json');
    if (!isObject(model3) || !isObject(model3.FileReferences) || !isObject(model3.FileReferences.Motions)) {
      throw new ModelAnalysisError('model3.json motion groups must be an object');
    }
    const groups = model3.FileReferences.Motions;
    const relativeFile = `motion/${motionId}.motion3.json`;
    const realMotionPath = realpathSync(motionPath);
    const referencesTarget = (entry: unknown): boolean => {
      if (!isObject(entry) || typeof entry.File !== 'string') return false;
      return path.resolve(resolveInside(profile.runtime, entry.File, 'motion')) === realMotionPath;
    };
    for (const [groupName, rawEntries] of Object.entries(groups)) {
      if (groupName === MOTION_GROUP || !Array.isArray(rawEntries)) continue;
      if (rawEntries.some((entry) => referencesTarget(entry))) {
        throw new MotionConflictError('the AI motion path is referenced by a model-owned group');
      }
    }
    const entries = groups[MOTION_GROUP];
    if (!Array.isArray(entries)) {
      throw new MotionConflictError('the persisted AI motion has no PromptSoul registration');
    }
    const matches = entries
      .map((entry, index) => (referencesTarget(entry) ? index : -1))
      .filter((index) => index >= 0);
    if (matches.length !== 1) {
      throw new MotionConflictError('the persisted AI motion must have exactly one PromptSoul registration');
    }
    const index = matches[0];
    const entry = entries[index];
    if (
      !isObject(entry)
      || entry.File !== relativeFile
      || entry.Name !== spec.name
      || entry.FadeInTime !== spec.fadeIn
      || entry.FadeOutTime !== spec.fadeOut
    ) {
      throw new MotionConflictError('the PromptSoul registration does not match its persisted specification');
    }
    const currentRevision = authoredRevision(profile, jsonBytes(model3), motionPayload);
    if (opaqueMotionRevision(currentRevision) !== options.expectedRevision) {
      throw new MotionConflictError('the active model changed before deletion', 'model_changed');
    }
    entries.splice(index, 1);
    const updatedModelPayload = jsonBytes(model3);
    if (updatedModelPayload.byteLength > MAX_MODEL_JSON_BYTES) {
      throw new MotionConflictError('updated model3.json would exceed the size limit');
    }
    const revision = authoredRevision(profile, updatedModelPayload, Buffer.alloc(0));
    const deletedMotion: PublicAuthoredMotion = {
      id: spec.id,
      motionId: spec.id,
      name: spec.id,
      label: spec.name,
      displayName: spec.name,
      group: MOTION_GROUP,
      index,
      duration: spec.duration,
      revision: currentRevision,
      replaced: true,
    };

    // Move the durable spec out of the replay namespace before committing the
    // model3 change. A crash after the commit can leave only unreachable
    // tombstones/runtime bytes; `motions:generate` cannot resurrect the action.
    const specTombstone = path.join(
      directory,
      `.${motionId}.${process.pid}.${randomBytes(8).toString('hex')}.delete`,
    );
    try {
      renameSync(specPath, specTombstone);
    } catch {
      throw new MotionConflictError('saved motion spec could not be prepared for deletion');
    }
    try {
      atomicWrite(profile.model3Path, updatedModelPayload);
    } catch {
      try {
        renameSync(specTombstone, specPath);
      } catch {
        throw new MotionConflictError('motion deletion could not be rolled back safely');
      }
      throw new MotionConflictError('model3.json could not be updated for deletion');
    }

    // The logical deletion is committed. Cleanup is deliberately best-effort:
    // restoring the spec now would allow a later generator run to revive it.
    let cleanupPending = false;
    try {
      rmSync(motionPath, { force: true });
    } catch {
      const motionTombstone = path.join(
        motionDirectory,
        `.${motionId}.${process.pid}.${randomBytes(8).toString('hex')}.delete`,
      );
      try {
        renameSync(motionPath, motionTombstone);
        try {
          rmSync(motionTombstone, { force: true });
        } catch {
          cleanupPending = true;
        }
      } catch {
        // The unregistered file remains unreachable from every model group.
        cleanupPending = true;
      }
    }
    try {
      rmSync(specTombstone, { force: true });
    } catch {
      // Hidden tombstones do not end in .json and are never replayed.
      cleanupPending = true;
    }
    return { motion: deletedMotion, revision, cleanupPending };
  });
}

function savedSpecs(profile: ModelProfile): CompiledMotionSpec[] {
  const directory = savedDirectory(profile);
  const files = readdirSync(directory).filter((filename) => filename.endsWith('.json')).sort();
  if (files.length > MAX_AUTHORED_MOTIONS) {
    throw new MotionLimitError('saved AI motion count exceeds the configured limit');
  }
  return files.map((filename) => {
    const spec = parseCompiledSpec(readFileSync(path.join(directory, filename)));
    if (filename !== `${spec.id}.json`) {
      throw new MotionConflictError('saved motion filename does not match its id');
    }
    validateCompiledSpec(spec, profile, spec.id);
    return spec;
  });
}

export function listAuthoredMotions(root = process.cwd()): PublicAuthoredMotion[] {
  const rootPath = path.resolve(root);
  return withExclusiveLock(rootPath, () => {
    const profile = loadModelProfile(rootPath);
    const model3 = readJson(profile.model3Path, MAX_MODEL_JSON_BYTES, 'model3.json');
    if (!isObject(model3) || !isObject(model3.FileReferences) || !isObject(model3.FileReferences.Motions)) {
      throw new ModelAnalysisError('model3.json motion groups must be an object');
    }
    const entries = model3.FileReferences.Motions[MOTION_GROUP] ?? [];
    if (!Array.isArray(entries)) throw new ModelAnalysisError(`${MOTION_GROUP} motion group must be a list`);
    const modelPayload = jsonBytes(model3);
    return savedSpecs(profile).map((spec): PublicAuthoredMotion => {
      const relative = `motion/${spec.id}.motion3.json`;
      const matches = entries
        .map((entry, index) => (isObject(entry) && entry.File === relative ? index : -1))
        .filter((index) => index >= 0);
      const motionPath = path.join(profile.runtime, 'motion', `${spec.id}.motion3.json`);
      const motionPayload = existsSync(motionPath) ? readFileSync(motionPath) : Buffer.alloc(0);
      const revision = authoredRevision(profile, modelPayload, motionPayload);
      return {
        id: spec.id,
        motionId: spec.id,
        name: spec.id,
        label: spec.name,
        displayName: spec.name,
        group: MOTION_GROUP,
        index: matches.length === 1 ? matches[0] : -1,
        duration: spec.duration,
        revision,
        replaced: true,
      };
    });
  });
}

export function reapplySavedMotions(root = process.cwd()): PublicAuthoredMotion[] {
  const rootPath = path.resolve(root);
  return withExclusiveLock(rootPath, () => {
    const profile = loadModelProfile(rootPath);
    const specs = savedSpecs(profile); // Validate every saved spec before the first write.
    return specs.map((spec) => installCompiled(profile, spec, false));
  });
}

export function isPublicMotionId(value: string): boolean {
  return PUBLIC_MOTION_ID_RE.test(value);
}
