import {
  chat,
  chatStream,
  ChatApiError,
  validateChatPayload,
} from "../../../lib/server/chat-service";
import { ProviderRequestError } from "../../../lib/server/provider-client";
import { LocalMutationError, readJsonMutation } from "../../../lib/server/provider-request";
import { ProviderConfigurationError } from "../../../lib/server/provider-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(document: unknown, status = 200): Response {
  return Response.json(document, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
function errorResponse(error: unknown): Response {
  if (
    error instanceof ChatApiError ||
    error instanceof ProviderRequestError ||
    error instanceof LocalMutationError ||
    error instanceof ProviderConfigurationError
  ) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }
  return json({ error: { code: "internal_error", message: "Internal server error." } }, 500);
}

function errorDocument(error: unknown): { error: { code: string; message: string } } {
  if (
    error instanceof ChatApiError ||
    error instanceof ProviderRequestError ||
    error instanceof LocalMutationError ||
    error instanceof ProviderConfigurationError
  ) {
    return { error: { code: error.code, message: error.message } };
  }
  return { error: { code: "internal_error", message: "Internal server error." } };
}

function wantsStream(request: Request): boolean {
  const accept = request.headers.get("accept") ?? "";
  return new URL(request.url).searchParams.get("stream") === "1"
    || accept.toLowerCase().includes("application/x-ndjson");
}

function streamingResponse(payload: unknown, request: Request): Response {
  validateChatPayload(payload);
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (event: unknown) => {
        if (!cancelled && !request.signal.aborted) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
      };
      void chatStream(payload, (text) => write({ type: "delta", text }))
        .then((result) => {
          write({ type: "done", ...result });
        })
        .catch((error: unknown) => {
          write({ type: "error", ...errorDocument(error) });
        })
        .finally(() => {
          if (!cancelled) controller.close();
        });
    },
    cancel() {
      cancelled = true;
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

export async function POST(request: Request): Promise<Response> {
  try {
    const payload = await readJsonMutation(request);
    if (wantsStream(request)) return streamingResponse(payload, request);
    return json(await chat(payload));
  } catch (error) {
    return errorResponse(error);
  }
}
