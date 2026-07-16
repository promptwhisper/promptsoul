import type { ProviderSettings } from "./provider-store";

export const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;
export const DEFAULT_PROVIDER_RESPONSE_BYTES = 512 * 1024;
const MAX_PROVIDER_REQUEST_BYTES = 128 * 1024;

export interface ChatCompletionMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}
export interface ChatCompletionOptions {
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetchImpl?: typeof fetch;
}

export class ProviderRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ProviderRequestError";
    this.status = status;
    this.code = code;
  }
}

function providerTimeout(): ProviderRequestError {
  return new ProviderRequestError(504, "provider_timeout", "The configured AI provider timed out.");
}

function providerUnavailable(): ProviderRequestError {
  return new ProviderRequestError(502, "provider_error", "The configured AI provider is unavailable.");
}

function invalidProviderResponse(message = "The AI provider returned an invalid response.") {
  return new ProviderRequestError(502, "provider_response_invalid", message);
}

export function normalizeChatCompletionsUrl(apiBase: string): string {
  const url = new URL(apiBase);
  const path = url.pathname.replace(/\/+$/u, "");
  url.pathname = path.endsWith("/chat/completions") ? path : `${path}/chat/completions`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader) {
    const declaredLength = Number(lengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw invalidProviderResponse("The AI provider response was too large.");
    }
  }
  if (!response.body) {
    throw invalidProviderResponse();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw invalidProviderResponse("The AI provider response was too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function extractProviderContent(document: unknown): unknown {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw invalidProviderResponse();
  }
  const choices = (document as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || !choices.length || !choices[0] || typeof choices[0] !== "object") {
    throw invalidProviderResponse("The AI provider response did not contain a choice.");
  }
  const choice = choices[0] as Record<string, unknown>;
  const message = choice.message;
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const content = (message as Record<string, unknown>).content;
    if (content !== null && content !== undefined) return content;
  }
  if (typeof choice.text === "string") return choice.text;
  throw invalidProviderResponse("The AI provider response did not contain message content.");
}

async function performRequest(
  settings: ProviderSettings,
  messages: readonly ChatCompletionMessage[],
  maxResponseBytes: number,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<unknown> {
  const body = JSON.stringify({
    model: settings.model,
    messages,
    stream: false,
  });
  if (new TextEncoder().encode(body).byteLength > MAX_PROVIDER_REQUEST_BYTES) {
    throw new ProviderRequestError(502, "provider_error", "The AI provider request was too large.");
  }

  let response: Response;
  try {
    response = await fetchImpl(normalizeChatCompletionsUrl(settings.apiBase), {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "promptsoul-local/2.0",
      },
      body,
      cache: "no-store",
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw providerTimeout();
    }
    throw providerUnavailable();
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) {
      throw new ProviderRequestError(
        502,
        "provider_auth_error",
        "The configured AI provider rejected the server credentials.",
      );
    }
    if (response.status === 408 || response.status === 504) throw providerTimeout();
    throw providerUnavailable();
  }

  const raw = await readBoundedResponse(response, maxResponseBytes);
  let document: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    document = JSON.parse(text) as unknown;
  } catch {
    throw invalidProviderResponse("The AI provider returned invalid JSON.");
  }
  return extractProviderContent(document);
}

export async function callChatCompletions(
  settings: ProviderSettings,
  messages: readonly ChatCompletionMessage[],
  options: ChatCompletionOptions = {},
): Promise<unknown> {
  if (!settings.apiKey) {
    throw new ProviderRequestError(
      503,
      "provider_not_configured",
      "No AI provider is configured.",
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_PROVIDER_RESPONSE_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new RangeError("Provider request limits must be positive integers.");
  }

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(providerTimeout());
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      performRequest(
        settings,
        messages,
        maxResponseBytes,
        options.fetchImpl ?? fetch,
        controller.signal,
      ),
      timeout,
    ]);
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw providerTimeout();
    }
    throw providerUnavailable();
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
