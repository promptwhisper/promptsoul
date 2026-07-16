import { loadPersona } from "../../../lib/server/chat-service";
import { getProviderSettings } from "../../../lib/server/provider-store";

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
export async function GET(): Promise<Response> {
  try {
    const settings = getProviderSettings();
    const persona = loadPersona();
    return json({
      mode: settings.apiKey ? "provider" : "demo",
      model: settings.model,
      persona: persona.name,
    });
  } catch {
    return json({ error: { code: "internal_error", message: "Internal server error." } }, 500);
  }
}
