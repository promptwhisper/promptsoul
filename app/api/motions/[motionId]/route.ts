import { deleteMotion, MotionApiError } from '../../../../lib/server/motion-api';
import {
  assertLocalSameOriginMutation,
  LocalMutationError,
  readJsonMutation,
} from '../../../../lib/server/provider-request';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  readonly params: Promise<{ motionId: string }>;
}

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
  if (error instanceof MotionApiError || error instanceof LocalMutationError) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }
  return json({ error: { code: 'internal_error', message: 'Internal server error.' } }, 500);
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    assertLocalSameOriginMutation(request);
    const { motionId } = await context.params;
    const payload = await readJsonMutation(request);
    return json(deleteMotion(motionId, payload));
  } catch (error) {
    return errorResponse(error);
  }
}
