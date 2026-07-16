import { generateMotion, MotionApiError } from '../../../../lib/server/motion-api';
import { ProviderRequestError } from '../../../../lib/server/provider-client';
import {
  assertLocalSameOriginMutation,
  LocalMutationError,
  readJsonMutation,
} from '../../../../lib/server/provider-request';

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

function errorResponse(error: unknown): Response {
  if (
    error instanceof MotionApiError
    || error instanceof ProviderRequestError
    || error instanceof LocalMutationError
  ) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }
  return json({ error: { code: 'internal_error', message: 'Internal server error.' } }, 500);
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertLocalSameOriginMutation(request);
    const payload = await readJsonMutation(request);
    return json(await generateMotion(payload), 201);
  } catch (error) {
    return errorResponse(error);
  }
}
