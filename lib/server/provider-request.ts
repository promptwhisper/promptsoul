const MAX_MUTATION_BYTES = 16 * 1024;

export class LocalMutationError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "LocalMutationError";
    this.status = status;
    this.code = code;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized)
  );
}

function parseHostHeader(host: string, protocol: string): URL {
  try {
    const url = new URL(`${protocol}//${host}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("invalid host");
    }
    return url;
  } catch {
    throw new LocalMutationError(403, "local_request_required", "Provider settings can only be changed locally.");
  }
}

export function assertLocalSameOriginMutation(request: Request): void {
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    throw new LocalMutationError(403, "local_request_required", "Provider settings can only be changed locally.");
  }
  if (!isLoopbackHostname(requestUrl.hostname)) {
    throw new LocalMutationError(403, "local_request_required", "Provider settings can only be changed locally.");
  }

  const host = request.headers.get("host");
  let effectiveOrigin = requestUrl.origin;
  if (host) {
    const hostUrl = parseHostHeader(host, requestUrl.protocol);
    // Next may normalize Request.url to localhost even when the browser used
    // 127.0.0.1. Both names are loopback aliases; the Host header remains the
    // browser-visible authority and therefore defines the expected Origin.
    if (!isLoopbackHostname(hostUrl.hostname) || hostUrl.port !== requestUrl.port) {
      throw new LocalMutationError(403, "local_request_required", "Provider settings can only be changed locally.");
    }
    effectiveOrigin = hostUrl.origin;
  }

  const origin = request.headers.get("origin");
  if (!origin || origin === "null") {
    throw new LocalMutationError(403, "same_origin_required", "A same-origin browser request is required.");
  }
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new LocalMutationError(403, "same_origin_required", "A same-origin browser request is required.");
  }
  if (
    originUrl.origin !== effectiveOrigin ||
    originUrl.pathname !== "/" ||
    originUrl.search ||
    originUrl.hash ||
    !isLoopbackHostname(originUrl.hostname)
  ) {
    throw new LocalMutationError(403, "same_origin_required", "A same-origin browser request is required.");
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite.toLowerCase() !== "same-origin") {
    throw new LocalMutationError(403, "same_origin_required", "A same-origin browser request is required.");
  }
}

export async function readJsonMutation(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new LocalMutationError(415, "unsupported_media_type", "Content-Type must be application/json.");
  }
  const contentEncoding = request.headers.get("content-encoding");
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    throw new LocalMutationError(415, "unsupported_content_encoding", "Encoded request bodies are not supported.");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength) {
    const value = Number(declaredLength);
    if (!Number.isInteger(value) || value < 1) {
      throw new LocalMutationError(400, "invalid_request", "Request body must not be empty.");
    }
    if (value > MAX_MUTATION_BYTES) {
      throw new LocalMutationError(413, "request_too_large", "Request body is too large.");
    }
  }
  if (!request.body) {
    throw new LocalMutationError(400, "invalid_request", "Request body must not be empty.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_MUTATION_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new LocalMutationError(413, "request_too_large", "Request body is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!total) {
    throw new LocalMutationError(400, "invalid_request", "Request body must not be empty.");
  }

  const raw = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    return JSON.parse(text) as unknown;
  } catch {
    throw new LocalMutationError(400, "invalid_json", "Request body must be valid UTF-8 JSON.");
  }
}
