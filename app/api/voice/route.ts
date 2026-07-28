import { LocalMutationError, readJsonMutation } from "../../../lib/server/provider-request";
import { VoiceConfigurationError } from "../../../lib/server/voice-store";
import { synthesizeVoice, VoiceApiError } from "../../../lib/server/voice-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(document: unknown, status: number): Response {
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
    error instanceof VoiceApiError
    || error instanceof VoiceConfigurationError
    || error instanceof LocalMutationError
  ) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }
  return json({ error: { code: "internal_error", message: "Internal server error." } }, 500);
}

export async function POST(request: Request): Promise<Response> {
  try {
    const result = await synthesizeVoice(await readJsonMutation(request));
    return new Response(result.audio, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": result.contentType,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
