import { listAivisVoices } from "../../../../lib/server/aivis-service";
import { AivisTtsError } from "../../../../lib/server/aivis-types";

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
    return json({ voices: await listAivisVoices() });
  } catch (error) {
    if (error instanceof AivisTtsError) {
      return json({ error: { code: error.code, message: error.message } }, error.status);
    }
    return json({ error: { code: "TTS_INTERNAL_ERROR", message: "Could not list TTS voices." } }, 500);
  }
}
