import { chat, ChatApiError } from "../../../lib/server/chat-service";
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

export async function POST(request: Request): Promise<Response> {
  try {
    const payload = await readJsonMutation(request);
    return json(await chat(payload));
  } catch (error) {
    return errorResponse(error);
  }
}
