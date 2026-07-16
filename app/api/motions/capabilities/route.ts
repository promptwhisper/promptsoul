import { motionCapabilities } from '../../../../lib/server/motion-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(document: unknown, status = 200): Response {
  return Response.json(document, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export function GET(): Response {
  try {
    return json(motionCapabilities());
  } catch {
    return json({ error: { code: 'internal_error', message: 'Internal server error.' } }, 500);
  }
}
