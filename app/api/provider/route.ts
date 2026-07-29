import {
  getPublicProviderSettings,
  ProviderConfigurationError,
} from "../../../lib/server/provider-store";

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
  if (error instanceof ProviderConfigurationError) {
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

function environmentOnly(request: Request): Response {
  void request;
  return Response.json({
    error: {
      code: "provider_environment_only",
      message: "AI Provider credentials can only be configured through server environment variables.",
    },
  }, {
    status: 405,
    headers: {
      "Allow": "GET",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export const POST = environmentOnly;
export const DELETE = environmentOnly;
