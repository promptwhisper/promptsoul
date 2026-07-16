import { realpath, readFile, stat } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME_TYPES: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".moc3": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
};

type RouteContext = { params: Promise<{ path: string[] }> };

async function resolveModelFile(segments: string[]): Promise<string | null> {
  if (!segments.length || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\0"))) {
    return null;
  }
  // Runtime-only licensed files are deliberately excluded from Next's NFT
  // deployment trace and mounted beside the self-hosted Node process.
  const root = await realpath(path.join(/*turbopackIgnore: true*/ process.cwd(), "models"));
  const candidate = path.resolve(/* turbopackIgnore: true */ root, ...segments);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
  const target = await realpath(/* turbopackIgnore: true */ candidate);
  if (!target.startsWith(`${root}${path.sep}`)) return null;
  const info = await stat(/* turbopackIgnore: true */ target);
  return info.isFile() ? target : null;
}

async function serve(request: Request, context: RouteContext, headOnly: boolean) {
  try {
    const { path: segments } = await context.params;
    const target = await resolveModelFile(segments);
    if (!target) return new Response("Not found", { status: 404 });
    const info = await stat(/* turbopackIgnore: true */ target);
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Content-Length": String(info.size),
      "Content-Type": MIME_TYPES[path.extname(target).toLowerCase()] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    return new Response(
      headOnly ? null : await readFile(/* turbopackIgnore: true */ target),
      { headers },
    );
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

export async function GET(request: Request, context: RouteContext) {
  return serve(request, context, false);
}

export async function HEAD(request: Request, context: RouteContext) {
  return serve(request, context, true);
}
