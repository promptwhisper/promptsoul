import { ALLOWED_EMOTIONS, type Emotion } from './chat-service';
import {
  MotionSpecError,
  parseStrictJson,
  type ControlProfile,
  type PartOpacityControl,
  type ModelProfile,
} from './motion-authoring';

export const MAX_REALTIME_LINE_BYTES = 128 * 1024;
export const MAX_REALTIME_SEGMENTS = 24;
export const MAX_REALTIME_SEGMENT_TEXT_CHARS = 500;
export const MAX_REALTIME_TEXT_CHARS = 4_000;
export const MIN_REALTIME_SILHOUETTE_SOURCE_AMPLITUDE = 0.2;
export const MIN_REALTIME_PRIMARY_CUE_SPAN = 0.75;
export const MAX_REALTIME_PRIMARY_CUE_AT = 0.15;

type JsonObject = Record<string, unknown>;
export type RealtimeKey = readonly [phase: number, offset: number];

export interface ResolvedRealtimeCurve {
  readonly parameterId: string;
  readonly minimum: number;
  readonly maximum: number;
  readonly base: number;
  readonly keys: readonly RealtimeKey[];
}

type RealtimeControl = ControlProfile | PartOpacityControl;
export const PART_OPACITY_ADDRESS_PREFIX = 'PartOpacity:';

export function partOpacityAddress(partId: string): string {
  return `${PART_OPACITY_ADDRESS_PREFIX}${partId}`;
}

function isPartOpacityControl(control: RealtimeControl): control is PartOpacityControl {
  return 'partId' in control;
}

export interface ResolvedRealtimeCue {
  readonly id: string;
  readonly at: number;
  readonly span: number;
  readonly curves: readonly ResolvedRealtimeCurve[];
}

export interface ValidatedRealtimeSegment {
  readonly type: 'segment';
  readonly seq: number;
  readonly text: string;
  readonly fallback: Emotion;
  readonly modelRevision: string;
  readonly cuesRejected: boolean;
  readonly cues: ResolvedRealtimeCue[];
}

export interface RealtimeSegmentParseOptions {
  readonly lipSyncParameterIds?: ReadonlySet<string> | readonly string[];
  readonly silhouetteTargetAmplitude?: number;
  readonly headShakeCycles?: number;
}

export class RealtimeCueProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RealtimeCueProtocolError';
    this.code = code;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireExactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new RealtimeCueProtocolError('invalid_segment', `${label} must contain exactly the documented fields`);
  }
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function resolveOffset(value: number, control: RealtimeControl): number {
  const negativeRange = control.base - control.minimum;
  const positiveRange = control.maximum - control.base;
  if (value === 0) return 0;

  // A rig may rest at one end of its observed range. Reflect the dead sign so
  // opaque controls remain effectful without exposing model ranges to DSH.
  if (positiveRange === 0 && negativeRange > 0) {
    return -Math.abs(value) * negativeRange;
  }
  if (negativeRange === 0 && positiveRange > 0) {
    return Math.abs(value) * positiveRange;
  }
  return value >= 0
    ? value * positiveRange
    : value * negativeRange;
}

function isPrimaryMovementControl(control: ControlProfile): boolean {
  const description = `${control.parameterId} ${control.displayName}`.normalize('NFKC');
  if (/hair|mouth|eye|brow|breath|cheek|tongue|髪|发|髮|口|目|眼|眉|呼吸/iu.test(description)) {
    return false;
  }
  return /(?:ParamAngle[XYZ]|ParamBodyAngle[XYZ]|ParamArm|ParamHand|angle\s*[xyz]|head|body|arm|hand|yaw|pitch|roll|turn|tilt|rotate|shoulder|头|頭|首|身体|身體|体|體|腕|手|胴)/iu.test(description);
}

function isHeadYawControl(control: ControlProfile): boolean {
  const description = `${control.parameterId} ${control.displayName}`.normalize('NFKC');
  return /ParamAngleX|head.{0,16}(?:yaw|turn|left|right)|(?:yaw|turn).{0,16}head|头部左右|頭部左右|左右转头|左右轉頭/iu.test(description)
    && !/body|身体|身體|胴/iu.test(description);
}

function isHeadRollControl(control: ControlProfile): boolean {
  const description = `${control.parameterId} ${control.displayName}`.normalize('NFKC');
  return /ParamAngleZ|head.{0,16}(?:roll|tilt)|(?:roll|tilt).{0,16}head|头部倾斜|頭部傾斜/iu.test(description)
    && !/body|身体|身體|胴/iu.test(description);
}

function isBodyRollControl(control: ControlProfile): boolean {
  const description = `${control.parameterId} ${control.displayName}`.normalize('NFKC');
  return /ParamBodyAngleZ|body.{0,16}(?:roll|tilt)|身体倾斜|身體傾斜|胴体傾斜/iu.test(description);
}

function alternatingDirectionCount(keys: readonly RealtimeKey[]): number {
  const signs: number[] = [];
  for (const [, value] of keys.slice(1, -1)) {
    if (value === 0) continue;
    const sign = Math.sign(value);
    if (signs.at(-1) !== sign) signs.push(sign);
  }
  return signs.length;
}

function requiredRollPeak(target: number): number {
  if (target >= 0.8) return 0.6;
  if (target >= 0.6) return 0.45;
  return 0.3;
}

function sampleNormalizedKeys(keys: readonly RealtimeKey[], phase: number): number {
  for (let index = 1; index < keys.length; index += 1) {
    const left = keys[index - 1];
    const right = keys[index];
    if (phase > right[0]) continue;
    const width = right[0] - left[0];
    if (width <= 0) return right[1];
    const amount = (phase - left[0]) / width;
    return left[1] + ((right[1] - left[1]) * amount);
  }
  return keys.at(-1)?.[1] ?? 0;
}

function opacitySwitchProgress(control: PartOpacityControl, value: number): number {
  return control.base >= 0.5 ? -value : value;
}

function compileCues(
  raw: unknown,
  profile: ModelProfile,
  lipSyncParameterIds: ReadonlySet<string>,
  silhouetteTargetAmplitude: number | undefined,
  headShakeCycles: number | undefined,
): ResolvedRealtimeCue[] {
  if (!Array.isArray(raw) || raw.length > 3) throw new Error('invalid cues');
  if (silhouetteTargetAmplitude !== undefined
    && (!finiteNumber(silhouetteTargetAmplitude)
      || silhouetteTargetAmplitude < MIN_REALTIME_SILHOUETTE_SOURCE_AMPLITUDE
      || silhouetteTargetAmplitude > 1)) {
    throw new Error('invalid silhouette target');
  }
  if (headShakeCycles !== undefined
    && (!Number.isSafeInteger(headShakeCycles) || headShakeCycles < 1 || headShakeCycles > 3)) {
    throw new Error('invalid head shake cycles');
  }
  const controls = new Map<string, RealtimeControl>([
    ...profile.controls.map((control) => [control.token, control] as const),
    ...(profile.partOpacityControls ?? []).map((control) => [control.token, control] as const),
  ]);
  const cueIds = new Set<string>();
  let strongestPrimaryPeak = 0;
  let hasReadablePrimaryTiming = false;
  let strongestHeadYawPeak = 0;
  let strongestHeadYawAlternations = 0;
  let strongestRollPeak = 0;
  const cues = raw.map((rawCue) => {
    if (!isObject(rawCue)) throw new Error('invalid cue');
    requireExactKeys(rawCue, ['id', 'at', 'span', 'curves'], 'cue');
    if (typeof rawCue.id !== 'string'
      || !rawCue.id.trim()
      || rawCue.id.startsWith('trusted_reference:')
      || cueIds.has(rawCue.id)
      || !finiteNumber(rawCue.at)
      || rawCue.at < 0
      || rawCue.at > 1
      || !finiteNumber(rawCue.span)
      || rawCue.span <= 0
      || rawCue.span > 1
      || rawCue.at + rawCue.span > 1) {
      throw new Error('invalid cue');
    }
    cueIds.add(rawCue.id);
    const cueAt = rawCue.at;
    const cueSpan = rawCue.span;
    if (!Array.isArray(rawCue.curves) || rawCue.curves.length < 1 || rawCue.curves.length > 40) {
      throw new Error('invalid curves');
    }
    const seenControls = new Set<string>();
    let cueHasPartOpacity = false;
    let cueHasPrimaryMovement = false;
    const opacityCurves = new Map<string, {
      control: PartOpacityControl;
      keys: readonly RealtimeKey[];
    }>();
    const curves = rawCue.curves.map((rawCurve) => {
      if (!isObject(rawCurve)) throw new Error('invalid curve');
      requireExactKeys(rawCurve, ['control', 'keys'], 'curve');
      if (typeof rawCurve.control !== 'string' || !Array.isArray(rawCurve.keys)) throw new Error('invalid curve');
      const control = controls.get(rawCurve.control);
      const unsafeParameter = control && !isPartOpacityControl(control) && (
        !profile.availableIds.has(control.parameterId)
        || profile.physicsOutputs.has(control.parameterId)
        || profile.partOpacityIds.has(control.parameterId)
        || /opacity|不透明|透明度/iu.test(`${control.parameterId} ${control.displayName}`)
        || lipSyncParameterIds.has(control.parameterId)
      );
      if (!control) throw new Error('unknown control');
      if (unsafeParameter) throw new Error('unsafe control');
      if (seenControls.has(rawCurve.control)) throw new Error('duplicate control');
      seenControls.add(rawCurve.control);
      if (rawCurve.keys.length < 3 || rawCurve.keys.length > 64) throw new Error('invalid keys');
      let previousPhase = -1;
      const normalizedKeys = rawCurve.keys.map((rawKey): RealtimeKey => {
        if (!Array.isArray(rawKey) || rawKey.length !== 2 || !finiteNumber(rawKey[0]) || !finiteNumber(rawKey[1])) {
          throw new Error('invalid key');
        }
        if (rawKey[0] < 0 || rawKey[0] > 1 || rawKey[0] <= previousPhase || rawKey[1] < -1 || rawKey[1] > 1) {
          throw new Error('invalid key');
        }
        previousPhase = rawKey[0];
        return [rawKey[0], rawKey[1]];
      });
      const first = rawCurve.keys[0];
      const last = rawCurve.keys[rawCurve.keys.length - 1];
      if (first[0] !== 0 || first[1] !== 0 || last[0] !== 1 || last[1] !== 0) {
        throw new Error('invalid key endpoints');
      }
      if (!normalizedKeys.some(([, value]) => value !== 0)) throw new Error('curve has no effect');
      const keys = normalizedKeys.map(([phase, value]): RealtimeKey => [phase, resolveOffset(value, control)]);
      if (!keys.some(([, offset]) => offset !== 0)) throw new Error('curve has no effect');
      const normalizedPeak = normalizedKeys.reduce((peak, key) => Math.max(peak, Math.abs(key[1])), 0);
      // Part opacity can support a coordinated pose, but never substitutes
      // for a real silhouette-control curve in movement validation.
      const primary = !isPartOpacityControl(control) && isPrimaryMovementControl(control);
      if (isPartOpacityControl(control)) {
        cueHasPartOpacity = true;
        opacityCurves.set(control.partId, { control, keys: normalizedKeys });
      }
      if (primary) {
        cueHasPrimaryMovement = true;
        strongestPrimaryPeak = Math.max(strongestPrimaryPeak, normalizedPeak);
        if (normalizedPeak >= (silhouetteTargetAmplitude ?? 0)
          && cueAt <= MAX_REALTIME_PRIMARY_CUE_AT
          && cueSpan >= MIN_REALTIME_PRIMARY_CUE_SPAN) {
          hasReadablePrimaryTiming = true;
        }
      }
      if (!isPartOpacityControl(control) && isHeadYawControl(control)) {
        strongestHeadYawPeak = Math.max(strongestHeadYawPeak, normalizedPeak);
        strongestHeadYawAlternations = Math.max(
          strongestHeadYawAlternations,
          alternatingDirectionCount(normalizedKeys),
        );
      }
      if (!isPartOpacityControl(control) && (isHeadRollControl(control) || isBodyRollControl(control))) {
        strongestRollPeak = Math.max(strongestRollPeak, normalizedPeak);
      }
      return {
        parameterId: isPartOpacityControl(control)
          ? partOpacityAddress(control.partId)
          : control.parameterId,
        minimum: control.minimum,
        maximum: control.maximum,
        base: control.base,
        keys,
      };
    });
    if (cueHasPartOpacity && !cueHasPrimaryMovement) {
      throw new Error('PartOpacity must be coordinated with a primary movement curve');
    }
    for (const { control, keys } of opacityCurves.values()) {
      const peak = keys.reduce((strongest, [, value]) => (
        Math.max(strongest, opacitySwitchProgress(control, value))
      ), 0);
      if (peak < 0.95) throw new Error('PartOpacity switch is too translucent');
    }
    for (const group of profile.partOpacityGroups ?? []) {
      const selected = group.filter((partId) => opacityCurves.has(partId));
      if (!selected.length) continue;
      if (selected.length !== group.length) throw new Error('PartOpacity pose group is incomplete');
      const decisiveSharedPoseSamples = Array.from({ length: 101 }, (_, index) => index / 100)
        .filter((phase) => group.every((partId) => {
          const curve = opacityCurves.get(partId)!;
          return opacitySwitchProgress(curve.control, sampleNormalizedKeys(curve.keys, phase)) >= 0.9;
        })).length;
      if (decisiveSharedPoseSamples < 35) {
        throw new Error('PartOpacity pose group does not hold the switched pose');
      }
      const progressesStayTogether = Array.from({ length: 101 }, (_, index) => index / 100)
        .every((phase) => {
          const progresses = group.map((partId) => {
            const curve = opacityCurves.get(partId)!;
            return opacitySwitchProgress(curve.control, sampleNormalizedKeys(curve.keys, phase));
          });
          return Math.max(...progresses) - Math.min(...progresses) <= 0.05;
        });
      if (!progressesStayTogether) throw new Error('PartOpacity pose group crossfades out of sync');
    }
    return { id: rawCue.id, at: cueAt, span: cueSpan, curves };
  });
  if (silhouetteTargetAmplitude !== undefined
    && strongestPrimaryPeak < silhouetteTargetAmplitude) {
    throw new Error('explicit movement cue is below the requested amplitude');
  }
  if (silhouetteTargetAmplitude !== undefined && !hasReadablePrimaryTiming) {
    throw new Error('explicit movement cue starts too late or is too short');
  }
  if (headShakeCycles !== undefined && strongestHeadYawPeak < (silhouetteTargetAmplitude ?? 0)) {
    throw new Error('head shake cue does not use the head yaw control');
  }
  if (headShakeCycles !== undefined && strongestHeadYawAlternations < headShakeCycles * 2) {
    throw new Error('head shake cue does not contain the requested left-right cycles');
  }
  const modelHasRollControl = profile.controls.some(
    (control) => isHeadRollControl(control) || isBodyRollControl(control),
  );
  if (headShakeCycles !== undefined
    && modelHasRollControl
    && strongestRollPeak < requiredRollPeak(silhouetteTargetAmplitude ?? 0)) {
    throw new Error('head shake cue is missing a readable DSH-authored roll curve');
  }
  return cues;
}

export function parseRealtimeSegmentLine(
  line: string | Uint8Array,
  profile: ModelProfile,
  options: RealtimeSegmentParseOptions = {},
): ValidatedRealtimeSegment {
  let parsed: unknown;
  try {
    parsed = parseStrictJson(line, MAX_REALTIME_LINE_BYTES, 'realtime segment');
  } catch (error) {
    if (error instanceof MotionSpecError) {
      throw new RealtimeCueProtocolError('invalid_ndjson', error.message);
    }
    throw error;
  }
  if (!isObject(parsed)) throw new RealtimeCueProtocolError('invalid_segment', 'segment must be an object');
  requireExactKeys(parsed, ['type', 'seq', 'text', 'fallback', 'cues'], 'segment');
  if (parsed.type !== 'segment'
    || !Number.isSafeInteger(parsed.seq)
    || (parsed.seq as number) < 0
    || typeof parsed.text !== 'string'
    || !parsed.text.trim()
    || [...parsed.text.trim().normalize('NFKC')].length > MAX_REALTIME_SEGMENT_TEXT_CHARS
    || !ALLOWED_EMOTIONS.includes(parsed.fallback as Emotion)) {
    throw new RealtimeCueProtocolError('invalid_segment', 'segment envelope is invalid');
  }

  let cues: ResolvedRealtimeCue[];
  let cuesRejected = false;
  try {
    const lipSyncParameterIds = options.lipSyncParameterIds instanceof Set
      ? options.lipSyncParameterIds
      : new Set(options.lipSyncParameterIds ?? []);
    cues = compileCues(
      parsed.cues,
      profile,
      lipSyncParameterIds,
      options.silhouetteTargetAmplitude,
      options.headShakeCycles,
    );
  } catch {
    cues = [];
    cuesRejected = true;
  }
  return {
    type: 'segment',
    seq: parsed.seq as number,
    text: parsed.text,
    fallback: parsed.fallback as Emotion,
    modelRevision: profile.revision,
    cuesRejected,
    cues,
  };
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (!left.byteLength) return right.slice();
  if (!right.byteLength) return left;
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

export class RealtimeSegmentAssembler {
  private pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private expectedSeq = 0;
  private segmentCount = 0;
  private totalTextChars = 0;
  private state: 'open' | 'closed' | 'failed' = 'open';
  private readonly options: RealtimeSegmentParseOptions;

  constructor(
    private readonly profile: ModelProfile,
    options: RealtimeSegmentParseOptions = {},
  ) {
    this.options = {
      lipSyncParameterIds: new Set(options.lipSyncParameterIds ?? []),
      silhouetteTargetAmplitude: options.silhouetteTargetAmplitude,
      headShakeCycles: options.headShakeCycles,
    };
  }

  push(
    chunk: string | Uint8Array,
    onSegment?: (segment: ValidatedRealtimeSegment) => void,
  ): ValidatedRealtimeSegment[] {
    if (this.state !== 'open') {
      throw new RealtimeCueProtocolError('stream_closed', 'realtime segment stream is not open');
    }
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
    const completed: ValidatedRealtimeSegment[] = [];
    let start = 0;
    try {
      for (let index = 0; index < bytes.byteLength; index += 1) {
        if (bytes[index] !== 0x0a) continue;
        const line = appendBytes(this.pending, bytes.subarray(start, index));
        this.pending = new Uint8Array();
        const segment = this.consumeLine(stripCarriageReturn(line));
        completed.push(segment);
        onSegment?.(segment);
        start = index + 1;
      }
      this.pending = appendBytes(this.pending, bytes.subarray(start));
      if (this.pending.byteLength > MAX_REALTIME_LINE_BYTES + 1) {
        throw new RealtimeCueProtocolError('line_too_large', 'realtime segment exceeds the 131072-byte limit');
      }
      return completed;
    } catch (error) {
      this.state = 'failed';
      throw error;
    }
  }

  finish(onSegment?: (segment: ValidatedRealtimeSegment) => void): ValidatedRealtimeSegment[] {
    if (this.state === 'closed') return [];
    if (this.state === 'failed') {
      throw new RealtimeCueProtocolError('stream_closed', 'realtime segment stream is not open');
    }
    this.state = 'closed';
    if (!this.pending.byteLength) return [];
    try {
      const segment = this.consumeLine(stripCarriageReturn(this.pending));
      this.pending = new Uint8Array();
      onSegment?.(segment);
      return [segment];
    } catch (error) {
      this.state = 'failed';
      throw error;
    }
  }

  private consumeLine(line: Uint8Array): ValidatedRealtimeSegment {
    const segment = parseRealtimeSegmentLine(line, this.profile, this.options);
    if (segment.seq !== this.expectedSeq) {
      throw new RealtimeCueProtocolError(
        'sequence_error',
        `expected realtime segment ${this.expectedSeq}, received ${segment.seq}`,
      );
    }
    if (this.segmentCount >= MAX_REALTIME_SEGMENTS) {
      throw new RealtimeCueProtocolError('segment_limit', 'realtime response exceeds 24 segments');
    }
    const textChars = [...segment.text].length;
    if (this.totalTextChars + textChars > MAX_REALTIME_TEXT_CHARS) {
      throw new RealtimeCueProtocolError('text_limit', 'realtime response exceeds 4000 Unicode characters');
    }
    this.expectedSeq += 1;
    this.segmentCount += 1;
    this.totalTextChars += textChars;
    return segment;
  }
}

function stripCarriageReturn(line: Uint8Array): Uint8Array {
  return line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
}
