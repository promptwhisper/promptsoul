import { assertLocalSameOriginMutation, readJsonMutation } from "@/lib/server/provider-request";
import { parseSelectWardrobeRequest, wardrobeErrorResponse } from "@/lib/server/wardrobe-api";
import { selectWardrobePreset } from "@/lib/server/wardrobe-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertLocalSameOriginMutation(request);
    const { presetId, revision } = parseSelectWardrobeRequest(await readJsonMutation(request));
    const status = await selectWardrobePreset(presetId, revision);
    return Response.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return wardrobeErrorResponse(error);
  }
}
