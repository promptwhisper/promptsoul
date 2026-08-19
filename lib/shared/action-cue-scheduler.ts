export type ActionCueKey = readonly [phase: number, offset: number];

export interface ResolvedActionCurve {
  parameter: string;
  minimum: number;
  maximum: number;
  keys: readonly ActionCueKey[];
}

export interface ResolvedActionCue {
  id: string;
  at: number;
  span: number;
  curves: readonly ResolvedActionCurve[];
}

export interface ResolvedSegment {
  turnId: string;
  modelEpoch: number;
  seq: number;
  cues: readonly ResolvedActionCue[];
}

export interface ActionCueParameterAccess {
  read(parameter: string): number | undefined;
  write(parameter: string, value: number): boolean;
}

export interface ActionCueAppliedEvent {
  turnId: string;
  modelEpoch: number;
  segmentSeq: number;
  cueId: string;
  scheduledAt: number;
  appliedAt: number;
  clockId: string | null;
  parameterIds: readonly string[];
}

export interface ActionCueFrameAppliedEvent {
  turnId: string;
  modelEpoch: number;
  appliedAt: number;
  clockId: string | null;
  writeCount: number;
  parameterIds: readonly string[];
}

export interface ActionCueSegmentEndedEvent {
  turnId: string;
  modelEpoch: number;
  segmentSeq: number;
  clockId: string | null;
  scheduledStartAt: number;
  scheduledEndAt: number;
  observedAt: number;
  writeCount: number;
}

export interface ActionCueSchedulerOptions {
  onCueApplied?: (event: ActionCueAppliedEvent) => void;
  onFrameApplied?: (event: ActionCueFrameAppliedEvent) => void;
  onSegmentEnded?: (event: ActionCueSegmentEndedEvent) => void;
}

interface ParameterBounds {
  minimum: number;
  maximum: number;
}

interface AudioAnchor {
  startAt: number;
  duration: number;
}

interface StoredSegment extends ResolvedSegment {
  audio: AudioAnchor | null;
  writeCount: number;
}

interface AppliedOffset extends ParameterBounds {
  offset: number;
}

interface CancellationFade {
  startAt: number;
  duration: number;
  offsets: ReadonlyMap<string, AppliedOffset>;
  baselines: ReadonlyMap<string, number>;
  clockId: string | null;
  reanchorOnNextFrame: boolean;
}

interface ActiveTurn {
  turnId: string;
  modelEpoch: number;
  clockId: string | null;
  cancelled: boolean;
}

interface PendingCueApplication {
  cue: ResolvedActionCue;
  turnId: string;
  modelEpoch: number;
  clockId: string | null;
  segmentSeq: number;
  scheduledAt: number;
  parameterIds: ReadonlySet<string>;
}

interface OffsetWriteResult {
  count: number;
  parameterIds: ReadonlySet<string>;
  baselines: ReadonlyMap<string, number>;
}

const MAX_CUES_PER_SEGMENT = 3;
const MAX_CURVES_PER_CUE = 40;
const MIN_KEYS_PER_CURVE = 3;
const MAX_KEYS_PER_CURVE = 64;
const MAX_SEGMENTS_PER_TURN = 24;
const PERFORMANCE_FRAME_GAP_SECONDS = 0.25;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSafeSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sameBounds(left: ParameterBounds, right: ParameterBounds): boolean {
  return left.minimum === right.minimum && left.maximum === right.maximum;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function smoothstep(value: number): number {
  return value * value * (3 - (2 * value));
}

function interpolate(keys: readonly ActionCueKey[], phase: number): number {
  for (let index = 1; index < keys.length; index += 1) {
    const right = keys[index];
    if (phase > right[0]) continue;
    const left = keys[index - 1];
    const localPhase = (phase - left[0]) / (right[0] - left[0]);
    const eased = smoothstep(localPhase);
    return left[1] + ((right[1] - left[1]) * eased);
  }
  return keys.at(-1)?.[1] ?? 0;
}

function validateAndCopySegment(
  segment: ResolvedSegment,
  knownBounds: ReadonlyMap<string, ParameterBounds>,
): { segment: StoredSegment; bounds: Map<string, ParameterBounds> } | null {
  if (
    !segment
    || typeof segment.turnId !== "string"
    || !segment.turnId.trim()
    || !isSafeSequence(segment.modelEpoch)
    || !isSafeSequence(segment.seq)
    || !Array.isArray(segment.cues)
    || segment.cues.length > MAX_CUES_PER_SEGMENT
  ) {
    return null;
  }

  const bounds = new Map(knownBounds);
  const cueIds = new Set<string>();
  const cues: ResolvedActionCue[] = [];

  for (const cue of segment.cues) {
    if (
      !cue
      || typeof cue.id !== "string"
      || !cue.id.trim()
      || cueIds.has(cue.id)
      || !isFiniteNumber(cue.at)
      || !isFiniteNumber(cue.span)
      || cue.at < 0
      || cue.at > 1
      || cue.span <= 0
      || cue.span > 1
      || cue.at + cue.span > 1
      || !Array.isArray(cue.curves)
      || cue.curves.length < 1
      || cue.curves.length > MAX_CURVES_PER_CUE
    ) {
      return null;
    }
    cueIds.add(cue.id);

    const curves: ResolvedActionCurve[] = [];
    for (const curve of cue.curves) {
      if (
        !curve
        || typeof curve.parameter !== "string"
        || !curve.parameter.trim()
        || !isFiniteNumber(curve.minimum)
        || !isFiniteNumber(curve.maximum)
        || curve.minimum > curve.maximum
        || !Array.isArray(curve.keys)
        || curve.keys.length < MIN_KEYS_PER_CURVE
        || curve.keys.length > MAX_KEYS_PER_CURVE
      ) {
        return null;
      }

      const curveBounds = {
        minimum: curve.minimum,
        maximum: curve.maximum,
      };
      const existingBounds = bounds.get(curve.parameter);
      if (existingBounds && !sameBounds(existingBounds, curveBounds)) return null;

      const keys: ActionCueKey[] = [];
      let previousPhase = -1;
      for (const key of curve.keys) {
        if (
          !Array.isArray(key)
          || key.length !== 2
          || !isFiniteNumber(key[0])
          || !isFiniteNumber(key[1])
          || key[0] < 0
          || key[0] > 1
          || key[0] <= previousPhase
        ) {
          return null;
        }
        keys.push([key[0], key[1]]);
        previousPhase = key[0];
      }
      if (
        keys[0][0] !== 0
        || keys[0][1] !== 0
        || keys.at(-1)?.[0] !== 1
        || keys.at(-1)?.[1] !== 0
        || !keys.some(([, offset]) => offset !== 0)
      ) {
        return null;
      }

      bounds.set(curve.parameter, curveBounds);
      curves.push({
        parameter: curve.parameter,
        minimum: curve.minimum,
        maximum: curve.maximum,
        keys,
      });
    }
    cues.push({ id: cue.id, at: cue.at, span: cue.span, curves });
  }

  return {
    segment: {
      turnId: segment.turnId,
      modelEpoch: segment.modelEpoch,
      seq: segment.seq,
      cues,
      audio: null,
      writeCount: 0,
    },
    bounds,
  };
}

/**
 * Mixes validated, in-memory action cues against the model's value for the
 * current frame. Time values use the same seconds clock as AudioContext.
 */
export class ActionCueScheduler {
  private activeTurn: ActiveTurn | null = null;
  private readonly segments = new Map<number, StoredSegment>();
  private parameterBounds = new Map<string, ParameterBounds>();
  private lastSequence = -1;
  private acceptedSegments = 0;
  private latestModelEpoch = -1;
  private lastFrameTime: number | null = null;
  private lastPerformanceTimelineFrameTime: number | null = null;
  private lastAppliedOffsets = new Map<string, AppliedOffset>();
  // The Cubism motion evaluator resets Parameters every frame, but it does not
  // necessarily reset PartOpacity. Keep a stable pre-cue value for both so a
  // realtime layer cannot accumulate and is restored on every exit path.
  private readonly cueBaselines = new Map<string, number>();
  private cancellationFade: CancellationFade | null = null;
  private readonly appliedCues = new Set<ResolvedActionCue>();
  private readonly onCueApplied?: (event: ActionCueAppliedEvent) => void;
  private readonly onFrameApplied?: (event: ActionCueFrameAppliedEvent) => void;
  private readonly onSegmentEnded?: (event: ActionCueSegmentEndedEvent) => void;
  private disposed = false;

  constructor(options: ActionCueSchedulerOptions = {}) {
    this.onCueApplied = options.onCueApplied;
    this.onFrameApplied = options.onFrameApplied;
    this.onSegmentEnded = options.onSegmentEnded;
  }

  beginTurn(turnId: string, modelEpoch: number, clockId: string | null = null): boolean {
    if (
      this.disposed
      || typeof turnId !== "string"
      || !turnId.trim()
      || !isSafeSequence(modelEpoch)
      || (clockId !== null && (typeof clockId !== "string" || !clockId.trim()))
      || modelEpoch < this.latestModelEpoch
    ) {
      return false;
    }

    const keepCancellationFade = Boolean(
      this.cancellationFade
      && this.activeTurn?.cancelled
      && this.activeTurn.modelEpoch === modelEpoch,
    );
    if (
      keepCancellationFade
      && this.cancellationFade
      && this.cancellationFade.clockId !== clockId
    ) {
      this.cancellationFade.reanchorOnNextFrame = true;
      this.cancellationFade.clockId = clockId;
    }
    this.activeTurn = { turnId, modelEpoch, clockId, cancelled: false };
    this.segments.clear();
    this.parameterBounds.clear();
    this.lastSequence = -1;
    this.acceptedSegments = 0;
    this.latestModelEpoch = modelEpoch;
    this.lastFrameTime = null;
    this.lastPerformanceTimelineFrameTime = null;
    this.lastAppliedOffsets.clear();
    if (keepCancellationFade && this.cancellationFade) {
      for (const [parameter, baseline] of this.cancellationFade.baselines) {
        this.cueBaselines.set(parameter, baseline);
      }
    } else {
      this.cueBaselines.clear();
    }
    this.appliedCues.clear();
    if (!keepCancellationFade) this.cancellationFade = null;
    return true;
  }

  enqueueSegment(segment: ResolvedSegment): boolean {
    const turn = this.activeTurn;
    if (
      this.disposed
      || !turn
      || turn.cancelled
      || segment?.turnId !== turn.turnId
      || segment?.modelEpoch !== turn.modelEpoch
      || !isSafeSequence(segment?.seq)
      || segment.seq <= this.lastSequence
      || this.acceptedSegments >= MAX_SEGMENTS_PER_TURN
    ) {
      return false;
    }

    const validated = validateAndCopySegment(segment, this.parameterBounds);
    if (!validated) return false;
    this.segments.set(segment.seq, validated.segment);
    this.parameterBounds = validated.bounds;
    this.lastSequence = segment.seq;
    this.acceptedSegments += 1;
    return true;
  }

  bindAudio(
    segmentSeq: number,
    startAt: number,
    duration: number,
    turnId?: string,
  ): boolean {
    const turn = this.activeTurn;
    const segment = this.segments.get(segmentSeq);
    if (
      this.disposed
      || !turn
      || turn.cancelled
      || (turnId !== undefined && turnId !== turn.turnId)
      || !isSafeSequence(segmentSeq)
      || !isFiniteNumber(startAt)
      || startAt < 0
      || !isFiniteNumber(duration)
      || duration <= 0
      || !isFiniteNumber(startAt + duration)
      || !segment
      || segment.audio
    ) {
      return false;
    }

    let effectiveStartAt = startAt;
    if (turn.clockId === "performance") {
      const otherBoundSegments = [...this.segments.values()]
        .filter((candidate) => candidate !== segment && candidate.audio !== null);
      if (!otherBoundSegments.length) this.lastPerformanceTimelineFrameTime = null;
      const latestBoundEnd = Math.max(
        0,
        ...otherBoundSegments
          .map((candidate) => candidate.audio!.startAt + candidate.audio!.duration),
      );
      effectiveStartAt = Math.max(effectiveStartAt, latestBoundEnd);
    } else if (this.lastFrameTime !== null && startAt < this.lastFrameTime) {
      this.segments.delete(segmentSeq);
      return false;
    }
    segment.audio = { startAt: effectiveStartAt, duration };
    return true;
  }

  cancelTurn(turnId: string, fadeMs = 200): boolean {
    const turn = this.activeTurn;
    if (
      this.disposed
      || !turn
      || turn.cancelled
      || turn.turnId !== turnId
      || !isFiniteNumber(fadeMs)
      || fadeMs < 0
    ) {
      return false;
    }

    turn.cancelled = true;
    this.segments.clear();
    if (fadeMs === 0 || this.lastFrameTime === null || !this.lastAppliedOffsets.size) {
      this.cancellationFade = null;
      this.lastAppliedOffsets.clear();
      return true;
    }

    this.cancellationFade = {
      startAt: this.lastFrameTime,
      duration: fadeMs / 1_000,
      offsets: new Map(this.lastAppliedOffsets),
      baselines: new Map(this.cueBaselines),
      clockId: turn.clockId,
      reanchorOnNextFrame: false,
    };
    return true;
  }

  applyFrame(now: number, parameters: ActionCueParameterAccess): number {
    if (
      this.disposed
      || !isFiniteNumber(now)
      || now < 0
      || (this.lastFrameTime !== null && now < this.lastFrameTime)
      || !parameters
      || typeof parameters.read !== "function"
      || typeof parameters.write !== "function"
    ) {
      return 0;
    }
    const observingPerformanceTimeline = this.reanchorPerformanceTimeline(
      now,
      this.lastPerformanceTimelineFrameTime,
    );
    this.lastPerformanceTimelineFrameTime = observingPerformanceTimeline ? now : null;
    this.lastFrameTime = now;

    const offsets = new Map<string, AppliedOffset>();
    const segmentOffsets = new Map<StoredSegment, Map<string, AppliedOffset>>();
    const pendingCueApplications: PendingCueApplication[] = [];
    this.mergeOffsets(offsets, this.getCancellationOffsets(now));
    if (this.activeTurn && !this.activeTurn.cancelled) {
      const orderedSegments = [...this.segments.values()]
        .sort((left, right) => left.seq - right.seq);
      for (const segment of orderedSegments) {
        const audio = segment.audio;
        if (!audio) continue;
        const segmentEnd = audio.startAt + audio.duration;
        if (now >= segmentEnd) {
          this.segments.delete(segment.seq);
          this.emitSegmentEnded({
            turnId: this.activeTurn.turnId,
            modelEpoch: this.activeTurn.modelEpoch,
            segmentSeq: segment.seq,
            clockId: this.activeTurn.clockId,
            scheduledStartAt: audio.startAt,
            scheduledEndAt: segmentEnd,
            observedAt: now,
            writeCount: segment.writeCount,
          });
          continue;
        }

        for (const cue of segment.cues) {
          const cueStart = audio.startAt + (cue.at * audio.duration);
          const cueDuration = cue.span * audio.duration;
          const phase = (now - cueStart) / cueDuration;
          if (phase <= 0 || phase >= 1) continue;

          const parameterIds = new Set<string>();
          for (const curve of cue.curves) {
            const offset = interpolate(curve.keys, phase);
            if (offset === 0) continue;
            parameterIds.add(curve.parameter);
            let activeOffsets = segmentOffsets.get(segment);
            if (!activeOffsets) {
              activeOffsets = new Map<string, AppliedOffset>();
              segmentOffsets.set(segment, activeOffsets);
            }
            this.mergeOffset(activeOffsets, curve.parameter, {
              offset,
              minimum: curve.minimum,
              maximum: curve.maximum,
            });
            this.mergeOffset(offsets, curve.parameter, {
              offset,
              minimum: curve.minimum,
              maximum: curve.maximum,
            });
          }
          if (parameterIds.size && !this.appliedCues.has(cue)) {
            pendingCueApplications.push({
              cue,
              turnId: this.activeTurn.turnId,
              modelEpoch: this.activeTurn.modelEpoch,
              clockId: this.activeTurn.clockId,
              segmentSeq: segment.seq,
              scheduledAt: cueStart,
              parameterIds,
            });
          }
        }
      }
    }

    const written = this.writeOffsets(offsets, parameters);
    for (const [segment, activeOffsets] of segmentOffsets) {
      for (const [parameterId, activeOffset] of activeOffsets) {
        if (!written.parameterIds.has(parameterId)) continue;
        const baseline = written.baselines.get(parameterId);
        if (
          isFiniteNumber(baseline)
          && clamp(
            baseline + activeOffset.offset,
            activeOffset.minimum,
            activeOffset.maximum,
          ) !== baseline
        ) {
          segment.writeCount += 1;
        }
      }
    }
    if (written.count && this.activeTurn) {
      this.emitFrameApplied({
        turnId: this.activeTurn.turnId,
        modelEpoch: this.activeTurn.modelEpoch,
        appliedAt: now,
        clockId: this.activeTurn.clockId,
        writeCount: written.count,
        parameterIds: [...written.parameterIds].sort(),
      });
    }
    for (const pending of pendingCueApplications) {
      const appliedParameterIds = [...pending.parameterIds]
        .filter((parameterId) => written.parameterIds.has(parameterId))
        .sort();
      if (!appliedParameterIds.length) continue;
      this.appliedCues.add(pending.cue);
      this.emitCueApplied({
        turnId: pending.turnId,
        modelEpoch: pending.modelEpoch,
        segmentSeq: pending.segmentSeq,
        cueId: pending.cue.id,
        scheduledAt: pending.scheduledAt,
        appliedAt: now,
        clockId: pending.clockId,
        parameterIds: appliedParameterIds,
      });
    }
    return written.count;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activeTurn = null;
    this.segments.clear();
    this.parameterBounds.clear();
    this.lastAppliedOffsets.clear();
    this.cueBaselines.clear();
    this.lastPerformanceTimelineFrameTime = null;
    this.appliedCues.clear();
    this.cancellationFade = null;
  }

  private getCancellationOffsets(now: number): Map<string, AppliedOffset> {
    const fade = this.cancellationFade;
    const offsets = new Map<string, AppliedOffset>();
    if (!fade) return offsets;
    if (fade.reanchorOnNextFrame) {
      fade.startAt = now;
      fade.reanchorOnNextFrame = false;
    }
    if (now < fade.startAt) {
      this.cancellationFade = null;
      return offsets;
    }
    const factor = 1 - ((now - fade.startAt) / fade.duration);
    if (factor <= 0) {
      this.cancellationFade = null;
      return offsets;
    }

    for (const [parameter, applied] of fade.offsets) {
      offsets.set(parameter, { ...applied, offset: applied.offset * factor });
    }
    return offsets;
  }

  private reanchorPerformanceTimeline(
    now: number,
    previousFrameTime: number | null,
  ): boolean {
    if (this.activeTurn?.cancelled || this.activeTurn?.clockId !== "performance") return false;
    const boundSegments = [...this.segments.values()]
      .filter((segment): segment is StoredSegment & { audio: AudioAnchor } => segment.audio !== null)
      .sort((left, right) => left.audio.startAt - right.audio.startAt);
    const earliest = boundSegments[0];
    if (!earliest) return false;

    let shift = 0;
    if (previousFrameTime === null) {
      const earliestEnd = earliest.audio.startAt + earliest.audio.duration;
      if (now >= earliestEnd) shift = now - earliest.audio.startAt;
    } else if (now - previousFrameTime > PERFORMANCE_FRAME_GAP_SECONDS) {
      shift = now - previousFrameTime;
    }
    if (shift > 0) {
      for (const segment of boundSegments) segment.audio.startAt += shift;
    }
    return true;
  }

  private mergeOffsets(
    target: Map<string, AppliedOffset>,
    source: ReadonlyMap<string, AppliedOffset>,
  ): void {
    for (const [parameter, offset] of source) {
      this.mergeOffset(target, parameter, offset);
    }
  }

  private mergeOffset(
    target: Map<string, AppliedOffset>,
    parameter: string,
    offset: AppliedOffset,
  ): void {
    const existing = target.get(parameter);
    if (!existing) {
      target.set(parameter, { ...offset });
    } else if (sameBounds(existing, offset)) {
      existing.offset += offset.offset;
    }
  }

  private writeOffsets(
    offsets: ReadonlyMap<string, AppliedOffset>,
    parameters: ActionCueParameterAccess,
  ): OffsetWriteResult {
    const applied = new Map<string, AppliedOffset>();
    const baselines = new Map<string, number>();
    const parameterIds = new Set<string>();
    // Restore controls that were affected on the preceding frame but are no
    // longer active. This also handles normal cue completion without relying
    // on the model's Parameter evaluator.
    for (const [parameter, baseline] of this.cueBaselines) {
      if (offsets.has(parameter)) continue;
      parameters.write(parameter, baseline);
      this.cueBaselines.delete(parameter);
    }
    for (const parameter of [...offsets.keys()].sort()) {
      const offset = offsets.get(parameter);
      if (!offset || offset.offset === 0) continue;
      const baseline = this.cueBaselines.get(parameter) ?? parameters.read(parameter);
      if (!isFiniteNumber(baseline)) continue;
      this.cueBaselines.set(parameter, baseline);
      baselines.set(parameter, baseline);
      const value = clamp(
        baseline + offset.offset,
        offset.minimum,
        offset.maximum,
      );
      const appliedOffset = value - baseline;
      if (appliedOffset === 0) continue;
      if (!parameters.write(parameter, value)) continue;
      parameterIds.add(parameter);
      applied.set(parameter, { ...offset, offset: appliedOffset });
    }
    this.lastAppliedOffsets = applied;
    return { count: parameterIds.size, parameterIds, baselines };
  }

  /** Immediately restore every value this scheduler changed, e.g. on unload. */
  restore(parameters: ActionCueParameterAccess): number {
    if (this.disposed || !parameters || typeof parameters.write !== "function") return 0;
    let count = 0;
    for (const [parameter, baseline] of this.cueBaselines) {
      if (parameters.write(parameter, baseline)) count += 1;
    }
    this.cueBaselines.clear();
    this.lastAppliedOffsets.clear();
    this.cancellationFade = null;
    return count;
  }

  private emitCueApplied(event: ActionCueAppliedEvent): void {
    try {
      this.onCueApplied?.(event);
    } catch {
      // Diagnostics must not interfere with frame updates.
    }
  }

  private emitFrameApplied(event: ActionCueFrameAppliedEvent): void {
    try {
      this.onFrameApplied?.(event);
    } catch {
      // Diagnostics must not interfere with frame updates.
    }
  }

  private emitSegmentEnded(event: ActionCueSegmentEndedEvent): void {
    try {
      this.onSegmentEnded?.(event);
    } catch {
      // Diagnostics must not interfere with frame updates.
    }
  }
}
