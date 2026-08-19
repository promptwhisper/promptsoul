import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { Emotion, HistoryMessage, Persona } from "./chat-service";
import { loadModelProfile, parseStrictJson, type ModelProfile } from "./motion-authoring";
import {
  partOpacityAddress,
  RealtimeSegmentAssembler,
  type ValidatedRealtimeSegment,
} from "./realtime-cue";
import { describeRealtimeControl } from "./realtime-model";

export interface RealtimeChatRequest {
  readonly message: string;
  readonly history: readonly HistoryMessage[];
  readonly persona: Pick<Persona, "name" | "systemPrompt">;
}

export interface RealtimeChatResult {
  readonly reply: string;
  readonly emotion: Emotion;
  readonly mode: "dsh-realtime";
  readonly modelRevision: string;
  readonly segmentCount: number;
}

export interface DshTurnRunnerOptions {
  readonly signal: AbortSignal;
  readonly onTextDelta: (text: string) => void;
}

export interface DshTurnRunner {
  run(
    input: string,
    options: DshTurnRunnerOptions,
  ): Promise<{ reason: string }>;
  close(): Promise<void>;
}

export interface DshRealtimeBackendOptions {
  readonly createRunner: () => DshTurnRunner;
  readonly loadProfile?: () => ModelProfile;
  readonly lipSyncParameterIds?: (profile: ModelProfile) => readonly string[] | ReadonlySet<string>;
  readonly loadReferenceActions?: (profile: ModelProfile, message: string) => readonly DshReferenceAction[];
  readonly onRunnerReset?: () => void;
  readonly maxTurnsPerRunner?: number;
}

export interface RealtimeConversationBackend {
  stream(
    request: RealtimeChatRequest,
    sink: (segment: ValidatedRealtimeSegment) => void,
    signal: AbortSignal,
  ): Promise<RealtimeChatResult>;
}

export class DshRealtimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DshRealtimeError";
    this.code = code;
  }
}

const CJK_WAVE = String.raw`挥(?:挥)?手|揮(?:揮)?手|招(?:招)?手`;
const CJK_GREETING_WAVE = String.raw`(?:和|跟|向)我打(?:个|個|一下)?招呼`;
const CJK_MOVEMENT = String.raw`跳(?:个|一段)?舞|舞蹈|摇头|搖頭|点头|點頭|${CJK_WAVE}|${CJK_GREETING_WAVE}|转圈|轉圈|转身|轉身|鞠躬|后仰|後仰|歪头|歪頭|侧头|側頭|低头|低頭|抬头|抬頭|仰头|仰頭|摆动|擺動|晃动|晃動`;
const CJK_GROSS_MOVEMENT = new RegExp(CJK_MOVEMENT, 'iu');
const CJK_MOVEMENT_COMMAND = new RegExp(String.raw`(?:请|請|给我|給我|和我|跟我|向我|来|來|做|生成|制作|製作|表演|展示|开始|開始|让我看|讓我看|想看|能不能|可以).{0,20}(?:${CJK_MOVEMENT})`, 'iu');
const CJK_MOVEMENT_SUFFIX = new RegExp(String.raw`(?:${CJK_MOVEMENT})(?:一下|几次|幾次|看看|给我看|給我看|吧|哦|呀)`, 'iu');
const CJK_DIRECT_MOVEMENT = new RegExp(String.raw`^(?:请|請)?(?:(?:开心|開心|高兴|高興|兴奋|興奮|热情|熱情|友好|害羞|大幅|明显|明顯|快速|轻轻|輕輕|强烈|強烈|夸张|誇張|用力|剧烈|劇烈|慢慢|柔和)地?)*(?:左右|上下)?(?:${CJK_MOVEMENT})(?:一下|[一二两兩三四五六七八九\d]+次|看看|吧|哦|呀)?[！!。.]?$`, 'iu');
const MOVEMENT_NEGATION = /(?:(?:不要|不用|不必|别|別|禁止|停止).{0,10}(?:跳舞|摇头|搖頭|点头|點頭|挥手|揮手|转圈|轉圈|鞠躬|后仰|後仰|歪头|歪頭)|\b(?:do not|don't|stop|without)\b.{0,30}\b(?:dance|shake|nod|wave|spin|bow|sway)\b|(?:踊らないで|首を振らないで|うなずかないで|手を振らないで))/iu;
const ENGLISH_MOVEMENT_COMMAND = /\b(?:please|can you|could you|would you|show me|perform|do)\b.{0,40}\b(?:dance|shake your head|nod|wave|turn around|spin|bow|lean back|tilt your head|look up|look down|sway)\b/iu;
const JAPANESE_MOVEMENT_COMMAND = /(?:踊って|踊りを見せ|首を振って|うなずいて|手を振って|回って|お辞儀して|のけぞって|首をかしげて|体を揺らして)/iu;
const STRONG_MOVEMENT_INTENT = /大幅|明显|明顯|强烈|強烈|夸张|誇張|用力|剧烈|劇烈|快速|big|large|strong|dramatic|exaggerated|intense|大きく|激しく/iu;
const GENTLE_MOVEMENT_INTENT = /轻轻|輕輕|轻微|輕微|小幅|慢慢|柔和|gentle|slight|subtle|soft|slowly|軽く|少し|ゆっくり/iu;

export const DEFAULT_REALTIME_SILHOUETTE_TARGET = 0.65;
export const STRONG_REALTIME_SILHOUETTE_TARGET = 0.85;
export const GENTLE_REALTIME_SILHOUETTE_TARGET = 0.4;

export function realtimeRequiredRollPeak(target: number): number {
  if (target >= 0.8) return 0.6;
  if (target >= 0.6) return 0.45;
  return 0.3;
}

export function requiresVisuallySalientRealtimeCues(message: string): boolean {
  const normalized = message.trim().normalize('NFKC');
  if (!normalized || MOVEMENT_NEGATION.test(normalized)) return false;
  if (ENGLISH_MOVEMENT_COMMAND.test(normalized) || JAPANESE_MOVEMENT_COMMAND.test(normalized)) {
    return true;
  }
  return CJK_GROSS_MOVEMENT.test(normalized)
    && (
      CJK_MOVEMENT_COMMAND.test(normalized)
      || CJK_MOVEMENT_SUFFIX.test(normalized)
      || CJK_DIRECT_MOVEMENT.test(normalized)
    );
}

export function realtimeCueSalienceTarget(message: string): number | undefined {
  if (!requiresVisuallySalientRealtimeCues(message)) return undefined;
  const normalized = message.trim().normalize('NFKC');
  if (GENTLE_MOVEMENT_INTENT.test(normalized)) return GENTLE_REALTIME_SILHOUETTE_TARGET;
  if (STRONG_MOVEMENT_INTENT.test(normalized)) return STRONG_REALTIME_SILHOUETTE_TARGET;
  return DEFAULT_REALTIME_SILHOUETTE_TARGET;
}

export function realtimeHeadShakeCycles(message: string): number | undefined {
  const normalized = message.trim().normalize('NFKC');
  if (!requiresVisuallySalientRealtimeCues(normalized) || !/摇头|搖頭|shake your head|首を振/iu.test(normalized)) {
    return undefined;
  }
  const match = normalized.match(/([一二两兩三123])\s*次/u);
  const count = match?.[1];
  if (count === '一' || count === '1') return 1;
  if (count === '二' || count === '两' || count === '兩' || count === '2') return 2;
  if (count === '三' || count === '3') return 3;
  if (/一下/u.test(normalized)) return 2;
  return 3;
}

export interface DshReferenceAction {
  readonly group: string;
  readonly index: number;
  readonly file: string;
  readonly motion3: unknown;
}

const MAX_REFERENCE_MODEL3_BYTES = 16 * 1024 * 1024;
const MAX_REFERENCE_MOTION_BYTES = 256 * 1024;
const MAX_REFERENCE_ACTIONS = 3;
const MAX_REFERENCE_TOTAL_BYTES = 96 * 1024;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function referenceScore(group: string, file: string, message: string): number {
  const description = `${group} ${file}`.normalize("NFKC").toLocaleLowerCase();
  const request = message.normalize("NFKC").toLocaleLowerCase();
  let score = group === "PromptSoul" ? 0 : 100;
  if (/hiyori_m08/u.test(description)) score += 1_000;
  if (/摇头|搖頭|shake.{0,8}head|首を振/u.test(request) && /shake|m08|m09/u.test(description)) score += 800;
  if (/点头|點頭|\bnod\b|うなず/u.test(request) && /nod/u.test(description)) score += 800;
  if (new RegExp(`${CJK_WAVE}|${CJK_GREETING_WAVE}|\\bwave\\b|手を振`, 'u').test(request) && /wave|hand|m07|m08|m09/u.test(description)) score += 700;
  if (/跳舞|舞蹈|\bdance\b|踊/u.test(request) && /m07|m08|m09|dance/u.test(description)) score += 650;
  return score;
}

/** Loads complete, unmodified motion3 documents from the active model. */
export function loadReferenceActions(profile: ModelProfile, message: string): DshReferenceAction[] {
  try {
    const modelSize = statSync(profile.model3Path).size;
    if (modelSize <= 0 || modelSize > MAX_REFERENCE_MODEL3_BYTES) return [];
    const model3 = record(parseStrictJson(
      readFileSync(profile.model3Path),
      MAX_REFERENCE_MODEL3_BYTES,
      "DSH reference model3",
    ));
    const fileReferences = record(model3?.FileReferences);
    const groups = record(fileReferences?.Motions);
    if (!groups) return [];
    const candidates: Array<{ group: string; index: number; file: string; score: number }> = [];
    for (const [group, entries] of Object.entries(groups)) {
      if (!Array.isArray(entries)) continue;
      entries.forEach((entry, index) => {
        const file = record(entry)?.File;
        if (typeof file !== "string" || !file.endsWith(".motion3.json")) return;
        candidates.push({ group, index, file, score: referenceScore(group, file, message) });
      });
    }
    candidates.sort((left, right) => right.score - left.score
      || left.group.localeCompare(right.group)
      || left.index - right.index);
    const root = path.resolve(profile.runtime);
    const references: DshReferenceAction[] = [];
    let totalBytes = 0;
    for (const candidate of candidates) {
      if (references.length >= MAX_REFERENCE_ACTIONS) break;
      const filename = path.resolve(root, candidate.file);
      if (!filename.startsWith(`${root}${path.sep}`)) continue;
      const size = statSync(filename).size;
      if (size <= 0 || size > MAX_REFERENCE_MOTION_BYTES || totalBytes + size > MAX_REFERENCE_TOTAL_BYTES) continue;
      const motion3 = parseStrictJson(readFileSync(filename), MAX_REFERENCE_MOTION_BYTES, "DSH reference motion");
      if (!record(motion3) || !Array.isArray(record(motion3)?.Curves)) continue;
      references.push({
        group: candidate.group,
        index: candidate.index,
        file: candidate.file,
        motion3,
      });
      totalBytes += size;
    }
    return references;
  } catch {
    return [];
  }
}

function buildInput(
  request: RealtimeChatRequest,
  profile: ModelProfile,
  lipSyncParameterIds: ReadonlySet<string>,
  referenceActions: readonly DshReferenceAction[],
  retryReason?: string,
): string {
  const minimumPrimaryPeak = realtimeCueSalienceTarget(request.message);
  const headShakeCycles = realtimeHeadShakeCycles(request.message);
  const requiredReference = requestedReferenceCurveIds(
    request.message,
    referenceActions,
    profile,
    lipSyncParameterIds,
  );
  const allowedReference = requestedReferenceAllowedCurveIds(
    request.message,
    referenceActions,
    profile,
    lipSyncParameterIds,
  );
  return JSON.stringify({
    persona: request.persona,
    history: request.history,
    message: request.message,
    model_revision: profile.revision,
    control_catalog: [
      ...profile.controls
        .filter((control) => !lipSyncParameterIds.has(control.parameterId))
        .map((control) => ({
        target: "Parameter" as const,
        id: control.parameterId,
        control: control.token,
        name: describeRealtimeControl(control),
        minimum: control.minimum,
        maximum: control.maximum,
        base: control.base,
        })),
      ...(profile.partOpacityControls ?? []).map((control) => ({
        target: "PartOpacity" as const,
        id: control.partId,
        control: control.token,
        name: control.displayName,
        minimum: control.minimum,
        maximum: control.maximum,
        base: control.base,
      })),
    ],
    part_opacity_groups: (profile.partOpacityGroups ?? []).map((group) => group.map((partId) => {
      const control = profile.partOpacityControls?.find((candidate) => candidate.partId === partId);
      return { id: partId, control: control?.token ?? null, base: control?.base ?? null };
    })),
    required_reference: requiredReference.size ? {
      curve_ids: [...requiredReference].sort(),
      allowed_curve_ids: [...allowedReference].sort(),
      minimum_curve_count: requiredReference.size,
    } : null,
    reference_actions: referenceActions,
    required_motion: minimumPrimaryPeak === undefined ? null : {
      minimum_primary_peak: minimumPrimaryPeak,
      first_cue_at_most: 0.15,
      minimum_cue_span: 0.75,
      head_shake_cycles: headShakeCycles ?? null,
      required_yaw_extrema: headShakeCycles === undefined ? null : headShakeCycles * 2,
      maximum_curve_keys: 64,
      minimum_roll_peak: headShakeCycles === undefined
        ? null
        : realtimeRequiredRollPeak(minimumPrimaryPeak),
      retry_reason: retryReason ?? null,
    },
  });
}

function requestedReferenceAllowedCurveIds(
  message: string,
  references: readonly DshReferenceAction[],
  profile: ModelProfile,
  lipSyncParameterIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const reference = findRequestedReference(message, references);
  if (!reference) return new Set();
  const safeParameters = new Set(profile.controls.map((control) => control.parameterId));
  const safeParts = new Set((profile.partOpacityControls ?? []).map((control) => control.partId));
  const allowed = new Set<string>();
  const curves = record(reference.motion3)?.Curves;
  if (!Array.isArray(curves)) return allowed;
  for (const curve of curves) {
    if (!record(curve) || typeof curve.Id !== 'string') continue;
    if (curve.Target === 'Parameter'
      && safeParameters.has(curve.Id)
      && !lipSyncParameterIds.has(curve.Id)) {
      allowed.add(curve.Id);
    } else if (curve.Target === 'PartOpacity' && safeParts.has(curve.Id)) {
      allowed.add(partOpacityAddress(curve.Id));
    }
  }
  return allowed;
}

function requestedReferenceCurveIds(
  message: string,
  references: readonly DshReferenceAction[],
  profile: ModelProfile,
  lipSyncParameterIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const reference = findRequestedReference(message, references);
  if (!reference) return new Set();
  const safeParameters = new Set(profile.controls.map((control) => control.parameterId));
  const safeParts = new Set((profile.partOpacityControls ?? []).map((control) => control.partId));
  const required = new Set<string>();
  const curves = record(reference.motion3)?.Curves;
  if (!Array.isArray(curves)) return required;
  const requiredParameter = /^(?:ParamAngle[XYZ]|ParamBodyAngle[XYZ]|ParamShoulder|ParamLeg|ParamArm(?:LA|RA|LB|RB)|ParamHand(?:LB|RB)|ParamHairAhoge|ParamEye(?:L|R)(?:Open|Smile)|ParamBrow(?:L|R)Form|ParamMouthForm|ParamCheek)$/u;
  for (const curve of curves) {
    if (!record(curve) || typeof curve.Id !== 'string') continue;
    if (curve.Target === 'Parameter'
      && safeParameters.has(curve.Id)
      && requiredParameter.test(curve.Id)
      && !lipSyncParameterIds.has(curve.Id)) {
      required.add(curve.Id);
    } else if (curve.Target === 'PartOpacity' && safeParts.has(curve.Id)) {
      required.add(partOpacityAddress(curve.Id));
    }
  }
  return required;
}

function findRequestedReference(
  message: string,
  references: readonly DshReferenceAction[],
): DshReferenceAction | undefined {
  const normalizedMessage = message.normalize('NFKC').toLowerCase();
  const explicitlyNamed = references.find((candidate) => {
    const filename = path.basename(candidate.file).toLowerCase();
    const stem = filename.replace(/\.motion3\.json$/u, '');
    return stem.length > 2 && normalizedMessage.includes(stem);
  });
  if (explicitlyNamed) return explicitlyNamed;

  // Users should be able to ask for an action naturally. The technical reference
  // choice and its PartOpacity contract are implementation details, not prompt syntax.
  const naturalWaveRequest = new RegExp(`${CJK_WAVE}|${CJK_GREETING_WAVE}|\\bwave\\b|手を振`, 'u');
  if (!naturalWaveRequest.test(normalizedMessage)
    || !requiresVisuallySalientRealtimeCues(normalizedMessage)) return undefined;
  return references.find((candidate) => /hiyori_m08/i.test(candidate.file))
    ?? references.find((candidate) => /wave|hand|m07|m08|m09/i.test(`${candidate.group} ${candidate.file}`));
}

interface SourceMotionSegment {
  readonly type: number;
  readonly startTime: number;
  readonly startValue: number;
  readonly endTime: number;
  readonly endValue: number;
  readonly control1Time?: number;
  readonly control1Value?: number;
  readonly control2Time?: number;
  readonly control2Value?: number;
}

function sourceMotionSegments(raw: unknown): SourceMotionSegment[] {
  if (!Array.isArray(raw) || raw.length < 5
    || typeof raw[0] !== 'number' || typeof raw[1] !== 'number') return [];
  const segments: SourceMotionSegment[] = [];
  let startTime = raw[0];
  let startValue = raw[1];
  for (let index = 2; index < raw.length;) {
    const type = raw[index];
    if (type === 1) {
      const values = raw.slice(index + 1, index + 7);
      if (values.length !== 6 || values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) return [];
      const [control1Time, control1Value, control2Time, control2Value, endTime, endValue] = values as number[];
      segments.push({ type, startTime, startValue, control1Time, control1Value, control2Time, control2Value, endTime, endValue });
      startTime = endTime;
      startValue = endValue;
      index += 7;
    } else if (type === 0 || type === 2 || type === 3) {
      const endTime = raw[index + 1];
      const endValue = raw[index + 2];
      if (typeof endTime !== 'number' || !Number.isFinite(endTime)
        || typeof endValue !== 'number' || !Number.isFinite(endValue)) return [];
      segments.push({ type, startTime, startValue, endTime, endValue });
      startTime = endTime;
      startValue = endValue;
      index += 3;
    } else return [];
  }
  return segments;
}

function cubic(left: number, control1: number, control2: number, right: number, amount: number): number {
  const inverse = 1 - amount;
  return (inverse ** 3 * left)
    + (3 * inverse * inverse * amount * control1)
    + (3 * inverse * amount * amount * control2)
    + (amount ** 3 * right);
}

function sampleSourceMotion(segments: readonly SourceMotionSegment[], time: number): number | undefined {
  const segment = segments.find((candidate) => time <= candidate.endTime) ?? segments.at(-1);
  if (!segment) return undefined;
  if (segment.type === 2) return segment.startValue;
  if (segment.type === 3) return time < segment.endTime ? segment.endValue : segment.startValue;
  const duration = segment.endTime - segment.startTime;
  if (duration <= 0) return segment.endValue;
  if (segment.type === 0) {
    const amount = Math.min(1, Math.max(0, (time - segment.startTime) / duration));
    return segment.startValue + ((segment.endValue - segment.startValue) * amount);
  }
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 16; iteration += 1) {
    const amount = (low + high) / 2;
    const sampledTime = cubic(
      segment.startTime,
      segment.control1Time!,
      segment.control2Time!,
      segment.endTime,
      amount,
    );
    if (sampledTime < time) low = amount;
    else high = amount;
  }
  return cubic(
    segment.startValue,
    segment.control1Value!,
    segment.control2Value!,
    segment.endValue,
    (low + high) / 2,
  );
}

function trustedReferenceSegment(
  request: RealtimeChatRequest,
  references: readonly DshReferenceAction[],
  profile: ModelProfile,
  lipSyncParameterIds: ReadonlySet<string>,
  attempted: readonly ValidatedRealtimeSegment[],
): ValidatedRealtimeSegment | null {
  const reference = findRequestedReference(request.message, references);
  const document = record(reference?.motion3);
  const meta = record(document?.Meta);
  const duration = meta?.Duration;
  const sourceCurves = document?.Curves;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || !Array.isArray(sourceCurves)) {
    return null;
  }
  const parameters = new Map(profile.controls.map((control) => [control.parameterId, control] as const));
  const parts = new Map((profile.partOpacityControls ?? []).map((control) => [control.partId, control] as const));
  const curves = sourceCurves.flatMap((rawCurve) => {
    const curve = record(rawCurve);
    if (!curve || typeof curve.Id !== 'string') return [];
    const control = curve.Target === 'Parameter' ? parameters.get(curve.Id) : parts.get(curve.Id);
    if (!control || (curve.Target === 'Parameter' && lipSyncParameterIds.has(curve.Id))) return [];
    const segments = sourceMotionSegments(curve.Segments);
    if (!segments.length) return [];
    const keys = Array.from({ length: 33 }, (_, index): readonly [number, number] => {
      const phase = index / 32;
      if (index === 0 || index === 32) return [phase, 0];
      const value = sampleSourceMotion(segments, phase * duration) ?? control.base;
      return [phase, Math.min(control.maximum, Math.max(control.minimum, value)) - control.base];
    });
    if (!keys.some(([, value]) => Math.abs(value) > 1e-6)) return [];
    return [{
      parameterId: curve.Target === 'PartOpacity' ? partOpacityAddress(curve.Id) : curve.Id,
      minimum: control.minimum,
      maximum: control.maximum,
      base: control.base,
      keys,
    }];
  });
  if (!curves.length || curves.length > 40) return null;
  const last = attempted.at(-1);
  return {
    type: 'segment',
    seq: 0,
    text: last?.text || '看我的完整动作。',
    fallback: last?.fallback ?? 'happy',
    modelRevision: profile.revision,
    cuesRejected: false,
    cues: [{ id: `trusted_reference:${reference!.group}:${reference!.index}`, at: 0, span: 1, curves }],
  };
}

interface RunnerLease {
  readonly token: symbol;
  readonly runner: DshTurnRunner;
}

export class DshRealtimeBackend implements RealtimeConversationBackend {
  private runner: DshTurnRunner | null = null;
  private runnerCompletedTurns = 0;
  private activeLease: RunnerLease | null = null;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private readonly loadProfile: () => ModelProfile;
  private readonly lipSyncParameterIds: (profile: ModelProfile) => readonly string[] | ReadonlySet<string>;
  private readonly loadReferenceActions: (profile: ModelProfile, message: string) => readonly DshReferenceAction[];
  private readonly maxTurnsPerRunner: number;

  constructor(private readonly options: DshRealtimeBackendOptions) {
    this.loadProfile = options.loadProfile ?? (() => loadModelProfile());
    this.lipSyncParameterIds = options.lipSyncParameterIds ?? (() => []);
    this.loadReferenceActions = options.loadReferenceActions ?? loadReferenceActions;
    this.maxTurnsPerRunner = options.maxTurnsPerRunner ?? 64;
    if (!Number.isSafeInteger(this.maxTurnsPerRunner) || this.maxTurnsPerRunner < 1) {
      throw new TypeError("maxTurnsPerRunner must be a positive safe integer");
    }
  }

  async stream(
    request: RealtimeChatRequest,
    sink: (segment: ValidatedRealtimeSegment) => void,
    signal: AbortSignal,
  ): Promise<RealtimeChatResult> {
    signal.throwIfAborted();
    const profile = this.loadProfile();
    const lipSyncParameterIds = new Set(this.lipSyncParameterIds(profile));
    const referenceActions = this.loadReferenceActions(profile, request.message);
    const requiredReferenceCurveIds = requestedReferenceCurveIds(
      request.message,
      referenceActions,
      profile,
      lipSyncParameterIds,
    );
    const allowedReferenceCurveIds = requestedReferenceAllowedCurveIds(
      request.message,
      referenceActions,
      profile,
      lipSyncParameterIds,
    );
    const silhouetteTargetAmplitude = realtimeCueSalienceTarget(request.message);
    const headShakeCycles = realtimeHeadShakeCycles(request.message);
    const accepted: ValidatedRealtimeSegment[] = [];
    const accept = (segment: ValidatedRealtimeSegment): void => {
      accepted.push(segment);
      sink(segment);
    };
    const lease = await this.acquireRunner(signal);

    try {
      const explicitMovement = silhouetteTargetAmplitude !== undefined
        || requiredReferenceCurveIds.size > 0;
      const maxAttempts = requiredReferenceCurveIds.size > 0 ? 1 : (explicitMovement ? 3 : 1);
      let retryReason: string | undefined;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const assembler = new RealtimeSegmentAssembler(profile, {
          lipSyncParameterIds,
          silhouetteTargetAmplitude,
          headShakeCycles,
        });
        const attemptSegments: ValidatedRealtimeSegment[] = [];
        const acceptAttempt = (segment: ValidatedRealtimeSegment): void => {
          attemptSegments.push(segment);
          if (!explicitMovement) accept(segment);
        };
        const result = await lease.runner.run(
          buildInput(request, profile, lipSyncParameterIds, referenceActions, retryReason),
          {
            signal,
            onTextDelta: (text) => {
              if (this.activeLease?.token !== lease.token) {
                throw new DshRealtimeError("dsh_turn_superseded", "The realtime DSH turn was superseded.");
              }
              assembler.push(text, acceptAttempt);
            },
          },
        );
        if (result.reason !== "completed") {
          throw new DshRealtimeError("dsh_turn_incomplete", "The realtime DSH turn did not complete.");
        }
        assembler.finish(acceptAttempt);
        if (!explicitMovement) break;

        if (requiredReferenceCurveIds.size) {
          const trusted = trustedReferenceSegment(
            request,
            referenceActions,
            profile,
            lipSyncParameterIds,
            attemptSegments,
          );
          if (trusted) {
            accept(trusted);
            break;
          }
        }

        const hasValidatedMotion = attemptSegments.some(
          (segment) => !segment.cuesRejected && segment.cues.length > 0,
        );
        const emittedCurveIds = new Set(attemptSegments.flatMap((segment) => (
          segment.cues.flatMap((cue) => cue.curves.map((curve) => curve.parameterId))
        )));
        const hasCompleteReference = [...requiredReferenceCurveIds]
          .every((parameterId) => emittedCurveIds.has(parameterId));
        const hasOnlyReferenceCurves = !allowedReferenceCurveIds.size
          || [...emittedCurveIds].every((parameterId) => allowedReferenceCurveIds.has(parameterId));
        if (hasValidatedMotion && hasCompleteReference && hasOnlyReferenceCurves) {
          attemptSegments.forEach(accept);
          break;
        }
        if (attempt + 1 >= maxAttempts) {
          throw new DshRealtimeError(
            "dsh_motion_validation_failed",
            "DSH did not generate a visible motion that passed validation after retrying.",
          );
        }
        retryReason = hasValidatedMotion && !hasCompleteReference
          ? "previous_cues_omitted_required_reference_curves"
          : hasValidatedMotion && !hasOnlyReferenceCurves
            ? "previous_cues_added_controls_outside_named_reference"
            : "previous_cues_failed_visible_motion_validation";
      }
      if (!accepted.length) {
        throw new DshRealtimeError("dsh_empty_response", "The realtime DSH turn produced no segments.");
      }
      const response: RealtimeChatResult = {
        reply: accepted.map((segment) => segment.text).join(""),
        emotion: accepted.at(-1)?.fallback ?? "neutral",
        mode: "dsh-realtime",
        modelRevision: profile.revision,
        segmentCount: accepted.length,
      };
      if (!await this.finishLease(lease, false)) {
        throw new DshRealtimeError("dsh_turn_superseded", "The realtime DSH turn was superseded.");
      }
      return response;
    } catch (error) {
      await this.finishLease(lease, true).catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.withLifecycle(async () => {
      const runner = this.runner;
      this.runner = null;
      this.runnerCompletedTurns = 0;
      this.activeLease = null;
      await runner?.close();
    });
  }

  private acquireRunner(signal: AbortSignal): Promise<RunnerLease> {
    return this.withLifecycle(async () => {
      signal.throwIfAborted();
      const displaced = this.activeLease;
      if (displaced !== null) {
        this.activeLease = null;
        if (this.runner === displaced.runner) {
          this.runner = null;
          this.runnerCompletedTurns = 0;
        }
        this.notifyRunnerReset();
        await displaced.runner.close();
        signal.throwIfAborted();
      }
      if (this.runner === null) {
        this.runner = this.options.createRunner();
        this.runnerCompletedTurns = 0;
      }
      const runner = this.runner;
      const lease = { token: Symbol("dsh-run"), runner };
      this.activeLease = lease;
      return lease;
    });
  }

  private finishLease(lease: RunnerLease, reset: boolean): Promise<boolean> {
    return this.withLifecycle(async () => {
      if (this.activeLease?.token !== lease.token) return false;
      this.activeLease = null;
      if (!reset) {
        this.runnerCompletedTurns += 1;
        if (this.runnerCompletedTurns < this.maxTurnsPerRunner) return true;
        if (this.runner === lease.runner) {
          this.runner = null;
          this.runnerCompletedTurns = 0;
        }
        this.notifyRunnerReset();
        await lease.runner.close().catch(() => undefined);
        return true;
      }
      if (this.runner === lease.runner) {
        this.runner = null;
        this.runnerCompletedTurns = 0;
      }
      this.notifyRunnerReset();
      await lease.runner.close();
      return true;
    });
  }

  private notifyRunnerReset(): void {
    try {
      this.options.onRunnerReset?.();
    } catch {
      // Metrics must not interfere with runtime recovery.
    }
  }

  private async withLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTail;
    let release!: () => void;
    this.lifecycleTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
