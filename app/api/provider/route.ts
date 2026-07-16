import {
  getPublicProviderSettings,
  ProviderConfigurationError,
  resetRuntimeProviderSettings,
  setRuntimeProviderSettings,
} from "../../../lib/server/provider-store";
import {
  assertLocalSameOriginMutation,
  LocalMutationError,
  readJsonMutation,
} from "../../../lib/server/provider-request";

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
  if (error instanceof ProviderConfigurationError || error instanceof LocalMutationError) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }
  return json({ error: { code: "internal_error", message: "Internal server error." } }, 500);
}

export async function GET(): Promise<Response> {
  try {
    return json(getPublicProviderSettings());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertLocalSameOriginMutation(request);
    const payload = await readJsonMutation(request);
    return json(setRuntimeProviderSettings(payload));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    assertLocalSameOriginMutation(request);
    return json(resetRuntimeProviderSettings());
  } catch (error) {
    return errorResponse(error);
  }
}
