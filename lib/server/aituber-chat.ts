import {
  ChatServiceFactory,
  ChatServiceHttpClient,
  HttpError,
  type ChatService,
  type Message,
  type ToolChatCompletion,
} from "@aituber-onair/chat";

import {
  DEFAULT_PROVIDER_RESPONSE_BYTES,
  normalizeChatCompletionsUrl,
  ProviderRequestError,
  type ChatCompletionMessage,
} from "./provider-client";
import type { ProviderSettings } from "./provider-store";

const FETCH_ADAPTER_KEY: unique symbol = Symbol.for(
  "promptsoul.aituber.chat.fetch-adapter.v1",
) as never;
type GlobalWithAituberFetchAdapter = typeof globalThis & {
  [FETCH_ADAPTER_KEY]?: true;
};

export interface AituberChatService {
  chatOnce(
    messages: Message[],
    stream: boolean,
    onPartialResponse: (text: string) => void,
    maxTokens?: number,
  ): Promise<ToolChatCompletion>;
}

export interface AituberChatOptions {
  readonly createService?: (settings: ProviderSettings) => AituberChatService;
}

function invalidProviderResponse(message = "The AI provider returned an invalid response.") {
  return new ProviderRequestError(502, "provider_response_invalid", message);
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader) {
    const declaredLength = Number(lengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > DEFAULT_PROVIDER_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw invalidProviderResponse("The AI provider response was too large.");
    }
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > DEFAULT_PROVIDER_RESPONSE_BYTES) {
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

function installBoundedFetchAdapter(): void {
  const target = globalThis as GlobalWithAituberFetchAdapter;
  if (target[FETCH_ADAPTER_KEY]) return;

  ChatServiceHttpClient.setFetch(async (url, init) => {
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
      redirect: "error",
    });
    const body = await readBoundedBody(response);
    const responseBody = new ArrayBuffer(body.byteLength);
    new Uint8Array(responseBody).set(body);
    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  });
  target[FETCH_ADAPTER_KEY] = true;
}

function createService(settings: ProviderSettings): ChatService {
  installBoundedFetchAdapter();
  return ChatServiceFactory.createChatService("openai-compatible", {
    apiKey: settings.apiKey ?? undefined,
    endpoint: normalizeChatCompletionsUrl(settings.apiBase),
    model: settings.model,
  });
}

function completionText(completion: ToolChatCompletion): string {
  const assistantContent = completion.assistant_message?.content;
  if (typeof assistantContent === "string" && assistantContent.trim()) {
    return assistantContent;
  }
  return completion.blocks
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function mapAituberError(error: unknown): ProviderRequestError {
  if (error instanceof ProviderRequestError) return error;
  if (error instanceof HttpError) {
    if (error.status === 401 || error.status === 403) {
      return new ProviderRequestError(
        502,
        "provider_auth_error",
        "The configured AI provider rejected the server credentials.",
      );
    }
    if (error.status === 408 || error.status === 504) {
      return new ProviderRequestError(
        504,
        "provider_timeout",
        "The configured AI provider timed out.",
      );
    }
  }
  if (
    error instanceof Error
    && (error.name === "AbortError" || /(?:request )?timeout/iu.test(error.message))
  ) {
    return new ProviderRequestError(
      504,
      "provider_timeout",
      "The configured AI provider timed out.",
    );
  }
  return new ProviderRequestError(
    502,
    "provider_error",
    "The configured AI provider is unavailable.",
  );
}

export async function callAituberChat(
  settings: ProviderSettings,
  messages: readonly ChatCompletionMessage[],
  options: AituberChatOptions = {},
): Promise<string> {
  if (!settings.apiKey) {
    throw new ProviderRequestError(
      503,
      "provider_not_configured",
      "No AI provider is configured.",
    );
  }
  try {
    const service = options.createService?.(settings) ?? createService(settings);
    const completion = await service.chatOnce(
      messages.map((message) => ({ ...message })),
      false,
      () => undefined,
    );
    const content = completionText(completion).trim();
    if (!content) {
      throw invalidProviderResponse("The AI provider returned an empty response.");
    }
    return content;
  } catch (error) {
    throw mapAituberError(error);
  }
}
