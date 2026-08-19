import { randomUUID } from "node:crypto";

import {
  demoReply,
  loadPersona,
  type Persona,
  validateChatPayload,
} from "./chat-service";
import type { RealtimeConversationBackend } from "./dsh-realtime";
import { realtimeMetrics, type RealtimeMetrics } from "./realtime-metrics";
import type { ValidatedRealtimeSegment } from "./realtime-cue";

export interface DshRealtimeStreamingOptions {
  readonly backend: RealtimeConversationBackend;
  readonly metrics?: RealtimeMetrics;
  readonly persona?: Persona;
  readonly turnId?: string;
}

function publicSegment(turnId: string, segment: ValidatedRealtimeSegment): unknown {
  return {
    type: "segment",
    turnId,
    seq: segment.seq,
    text: segment.text,
    fallback: segment.fallback,
    modelRevision: segment.modelRevision,
    cuesRejected: segment.cuesRejected,
    cues: segment.cues.map((cue) => ({
      id: cue.id,
      at: cue.at,
      span: cue.span,
      curves: cue.curves.map((curve) => ({
        parameter: curve.parameterId,
        minimum: curve.minimum,
        maximum: curve.maximum,
        keys: curve.keys,
      })),
    })),
  };
}

export function createDshRealtimeStreamingResponse(
  payload: unknown,
  request: Request,
  options: DshRealtimeStreamingOptions,
): Response {
  const validated = validateChatPayload(payload);
  const persona = options.persona ?? loadPersona();
  const turnId = options.turnId ?? randomUUID();
  const encoder = new TextEncoder();
  const metrics = options.metrics ?? realtimeMetrics;
  const turnController = new AbortController();
  let cancelled = false;
  let emittedSegments = 0;
  metrics.beginTurn(turnId);

  const abortFromRequest = () => turnController.abort(request.signal.reason);
  if (request.signal.aborted) abortFromRequest();
  else request.signal.addEventListener("abort", abortFromRequest, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (event: unknown): void => {
        if (cancelled || turnController.signal.aborted) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      write({ type: "start", turnId, mode: "dsh-realtime" });
      void options.backend.stream(
        { ...validated, persona },
        (segment) => {
          if (cancelled || turnController.signal.aborted) {
            throw turnController.signal.reason
              ?? new DOMException("The realtime turn was cancelled.", "AbortError");
          }
          emittedSegments += 1;
          metrics.recordSegment(turnId, segment.cuesRejected);
          write(publicSegment(turnId, segment));
        },
        turnController.signal,
      ).then((result) => {
        metrics.completeTurn(turnId);
        write({ type: "done", turnId, ...result });
      }).catch(() => {
        if (turnController.signal.aborted || cancelled) {
          metrics.cancelTurn(turnId);
          return;
        }
        metrics.failTurn(turnId);
        if (emittedSegments === 0) {
          const [reply, emotion] = demoReply(persona, validated.message);
          write({
            type: "segment",
            turnId,
            seq: 0,
            text: reply,
            fallback: emotion,
            modelRevision: null,
            cuesRejected: true,
            cues: [],
          });
          write({
            type: "done",
            turnId,
            reply,
            emotion,
            mode: "demo",
            modelRevision: null,
            segmentCount: 1,
          });
          return;
        }
        write({
          type: "error",
          turnId,
          partial: true,
          error: {
            code: "dsh_realtime_failed",
            message: "The realtime response ended before completion.",
          },
        });
      }).finally(() => {
        request.signal.removeEventListener("abort", abortFromRequest);
        if (!cancelled) controller.close();
      });
    },
    cancel() {
      cancelled = true;
      turnController.abort(new DOMException("The browser closed the realtime response.", "AbortError"));
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Cache-Control": "no-store, no-transform",
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
