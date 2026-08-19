import { getPromptSkinAvailability } from "@/lib/server/promptskin-client";
import { wardrobeErrorResponse } from "@/lib/server/wardrobe-api";
import { getWardrobeStatus } from "@/lib/server/wardrobe-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const [wardrobe, generator] = await Promise.all([
      getWardrobeStatus(),
      getPromptSkinAvailability(),
    ]);
    return Response.json(
      { ...wardrobe, generator },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return wardrobeErrorResponse(error);
  }
}
