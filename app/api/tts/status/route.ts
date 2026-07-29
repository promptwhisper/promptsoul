import { getAivisTtsStatus } from "../../../../lib/server/aivis-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const status = await getAivisTtsStatus();
  return Response.json(status, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
