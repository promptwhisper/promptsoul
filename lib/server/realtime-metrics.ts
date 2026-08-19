export interface RealtimeMetricsSnapshot {
  readonly turnsStarted: number;
  readonly turnsCompleted: number;
  readonly turnsFailed: number;
  readonly turnsCancelled: number;
  readonly segments: number;
  readonly invalidCues: number;
  readonly runtimeRestarts: number;
  readonly lastTtfcMs: number | null;
  readonly ttfcP95Ms: number | null;
}

interface ActiveTurnMetric {
  readonly startedAt: number;
  firstSegmentAt: number | null;
}

const MAX_TTFC_SAMPLES = 256;

function rounded(value: number): number {
  return Number(value.toFixed(1));
}

export class RealtimeMetrics {
  private readonly activeTurns = new Map<string, ActiveTurnMetric>();
  private readonly ttfcSamples: number[] = [];
  private turnsStarted = 0;
  private turnsCompleted = 0;
  private turnsFailed = 0;
  private turnsCancelled = 0;
  private segments = 0;
  private invalidCues = 0;
  private runtimeRestarts = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  beginTurn(turnId: string): void {
    if (!turnId || this.activeTurns.has(turnId)) return;
    this.activeTurns.set(turnId, { startedAt: this.now(), firstSegmentAt: null });
    this.turnsStarted += 1;
  }

  recordSegment(turnId: string, cuesRejected: boolean): void {
    const turn = this.activeTurns.get(turnId);
    if (!turn) return;
    this.segments += 1;
    if (cuesRejected) this.invalidCues += 1;
    if (turn.firstSegmentAt !== null) return;
    turn.firstSegmentAt = this.now();
    this.ttfcSamples.push(Math.max(0, turn.firstSegmentAt - turn.startedAt));
    if (this.ttfcSamples.length > MAX_TTFC_SAMPLES) this.ttfcSamples.shift();
  }

  completeTurn(turnId: string): void {
    if (!this.activeTurns.delete(turnId)) return;
    this.turnsCompleted += 1;
  }

  failTurn(turnId: string): void {
    if (!this.activeTurns.delete(turnId)) return;
    this.turnsFailed += 1;
  }

  cancelTurn(turnId: string): void {
    if (!this.activeTurns.delete(turnId)) return;
    this.turnsCancelled += 1;
  }

  recordRuntimeRestart(): void {
    this.runtimeRestarts += 1;
  }

  snapshot(): RealtimeMetricsSnapshot {
    const sorted = [...this.ttfcSamples].sort((left, right) => left - right);
    const percentileIndex = sorted.length
      ? Math.max(0, Math.ceil(sorted.length * 0.95) - 1)
      : -1;
    return Object.freeze({
      turnsStarted: this.turnsStarted,
      turnsCompleted: this.turnsCompleted,
      turnsFailed: this.turnsFailed,
      turnsCancelled: this.turnsCancelled,
      segments: this.segments,
      invalidCues: this.invalidCues,
      runtimeRestarts: this.runtimeRestarts,
      lastTtfcMs: sorted.length ? rounded(this.ttfcSamples.at(-1) ?? 0) : null,
      ttfcP95Ms: percentileIndex >= 0 ? rounded(sorted[percentileIndex]) : null,
    });
  }
}

export const realtimeMetrics = new RealtimeMetrics();
