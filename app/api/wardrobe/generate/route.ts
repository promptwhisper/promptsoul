import { generateWardrobeWithPromptSkin } from "@/lib/server/promptskin-client";
import { assertLocalSameOriginMutation, readJsonMutation } from "@/lib/server/provider-request";
import { parseGenerateWardrobeRequest, wardrobeErrorResponse } from "@/lib/server/wardrobe-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

export async function POST(request: Request): Promise<Response> {
  try {
    assertLocalSameOriginMutation(request);
    const { prompt } = parseGenerateWardrobeRequest(await readJsonMutation(request));
    const status = await generateWardrobeWithPromptSkin(prompt);
    return Response.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return wardrobeErrorResponse(error);
  }
}
