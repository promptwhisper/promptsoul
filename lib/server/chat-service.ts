import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  callAituberChat,
  callAituberChatStream,
  type AituberChatOptions,
} from "./aituber-chat";
import { type ChatCompletionMessage } from "./provider-client";
import { getProviderSettings, type ProviderSettings } from "./provider-store";

export const ALLOWED_EMOTIONS = Object.freeze([
  "neutral",
  "happy",
  "wink",
  "nod",
  "thinking",
  "surprised",
  "shy",
  "shakehead",
] as const);
export type Emotion = (typeof ALLOWED_EMOTIONS)[number];

const EMOTION_SET = new Set<string>(ALLOWED_EMOTIONS);
const MAX_REQUEST_MESSAGE_CHARS = 2_000;
const MAX_HISTORY_MESSAGES = 12;
const MAX_HISTORY_CHARS = 12_000;
const MAX_REPLY_CHARS = 4_000;
const MAX_CONFIG_BYTES = 32 * 1024;
const MAX_SYSTEM_PROMPT_CHARS = 8_000;

function truncateReply(value: string): string {
  return [...value].slice(0, MAX_REPLY_CHARS).join("").trimEnd();
}

export interface Persona {
  readonly name: string;
  readonly systemPrompt: string;
  readonly greeting: string;
}

export interface HistoryMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface ValidatedChatPayload {
  readonly message: string;
  readonly history: readonly HistoryMessage[];
}

export interface ChatResult {
  readonly reply: string;
  readonly emotion: Emotion;
  readonly mode: "demo" | "provider";
}

export type ChatReplyDeltaHandler = (text: string) => void;

export class ChatApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ChatApiError";
    this.status = status;
    this.code = code;
  }
}

export const DEFAULT_PERSONA: Persona = Object.freeze({
  name: "Hiyori",
  systemPrompt:
    "You are Hiyori, a warm and playful Live2D character. Reply naturally, briefly, and in the same language as the user.",
  greeting: "你好呀，我是 Hiyori。今天想聊点什么？",
});

function cleanPersonaField(value: unknown, fallback: string, limit: number): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(cleaned)) {
    return fallback;
  }
  return cleaned;
}

export function loadPersona(configPath = join(process.cwd(), "npc.config.json")): Persona {
  let raw: Buffer;
  try {
    raw = readFileSync(configPath);
  } catch {
    return DEFAULT_PERSONA;
  }
  if (raw.byteLength > MAX_CONFIG_BYTES) return DEFAULT_PERSONA;

  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown;
  } catch {
    return DEFAULT_PERSONA;
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) return DEFAULT_PERSONA;
  const root = document as Record<string, unknown>;
  const npc = root.npc && typeof root.npc === "object" && !Array.isArray(root.npc)
    ? (root.npc as Record<string, unknown>)
    : root;
  const name = cleanPersonaField(npc.name, DEFAULT_PERSONA.name, 80);
  const role = cleanPersonaField(npc.role, "a friendly Live2D character", 500);
  const fallbackPrompt = `You are ${name}, ${role}. Reply briefly and naturally in the user's language.`;
  return Object.freeze({
    name,
    systemPrompt: cleanPersonaField(
      npc.systemPrompt ?? npc.system_prompt ?? npc.prompt,
      fallbackPrompt,
      MAX_SYSTEM_PROMPT_CHARS,
    ),
    greeting: cleanPersonaField(
      npc.greeting ?? npc.welcomeMessage ?? npc.welcome_message,
      `你好呀，我是 ${name}。今天想聊点什么？`,
      MAX_REPLY_CHARS,
    ),
  });
}

export function validateChatPayload(payload: unknown): ValidatedChatPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ChatApiError(400, "invalid_request", "Request JSON must be an object.");
  }
  const object = payload as Record<string, unknown>;
  if (Object.keys(object).some((key) => key !== "message" && key !== "history")) {
    throw new ChatApiError(400, "invalid_request", "Request contains unsupported fields.");
  }
  if (typeof object.message !== "string") {
    throw new ChatApiError(400, "invalid_message", "'message' must be a string.");
  }
  const message = object.message.trim();
  if (!message) throw new ChatApiError(400, "invalid_message", "'message' must not be empty.");
  if (message.length > MAX_REQUEST_MESSAGE_CHARS) {
    throw new ChatApiError(413, "message_too_large", "'message' is too long.");
  }

  const rawHistory = object.history ?? [];
  if (!Array.isArray(rawHistory)) {
    throw new ChatApiError(400, "invalid_history", "'history' must be an array.");
  }
  let historyValue: unknown[] = rawHistory;
  const final = historyValue.at(-1);
  if (
    final &&
    typeof final === "object" &&
    !Array.isArray(final) &&
    (final as Record<string, unknown>).role === "user" &&
    typeof (final as Record<string, unknown>).content === "string" &&
    ((final as Record<string, unknown>).content as string).trim() === message
  ) {
    historyValue = historyValue.slice(0, -1);
  }
  if (historyValue.length > MAX_HISTORY_MESSAGES) {
    throw new ChatApiError(413, "history_too_large", "Too many history messages.");
  }

  let totalChars = 0;
  const history: HistoryMessage[] = historyValue.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ChatApiError(400, "invalid_history", `History item ${index} must be an object.`);
    }
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).some((key) => key !== "role" && key !== "content")) {
      throw new ChatApiError(400, "invalid_history", `History item ${index} contains unsupported fields.`);
    }
    if (entry.role !== "user" && entry.role !== "assistant") {
      throw new ChatApiError(400, "invalid_history", `History item ${index} has an unsupported role.`);
    }
    if (typeof entry.content !== "string" || !entry.content.trim()) {
      throw new ChatApiError(
        400,
        "invalid_history",
        `History item ${index} must have non-empty string content.`,
      );
    }
    const content = entry.content.trim();
    if (content.length > MAX_REQUEST_MESSAGE_CHARS) {
      throw new ChatApiError(413, "history_too_large", `History item ${index} is too long.`);
    }
    totalChars += content.length;
    if (totalChars > MAX_HISTORY_CHARS) {
      throw new ChatApiError(413, "history_too_large", "History content is too large.");
    }
    return Object.freeze({ role: entry.role, content });
  });
  return Object.freeze({ message, history: Object.freeze(history) });
}

function normalizeEmotion(value: unknown): Emotion {
  if (typeof value !== "string") return "neutral";
  const emotion = value.trim().toLowerCase();
  return EMOTION_SET.has(emotion) ? (emotion as Emotion) : "neutral";
}

function normalizeReplyObject(value: unknown): readonly [string, Emotion] | null {
  if (Array.isArray(value) && value.length) value = value[0];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  for (const wrapper of ["response", "result", "data"] as const) {
    const normalized = normalizeReplyObject(object[wrapper]);
    if (normalized) return normalized;
  }
  const reply = [object.reply, object.message, object.text].find((item) => typeof item === "string");
  if (typeof reply !== "string" || !reply.trim()) return null;
  return [truncateReply(reply.trim()), normalizeEmotion(object.emotion)];
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return JSON.stringify(content);
  }
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object" || Array.isArray(item)) return "";
    const text = (item as Record<string, unknown>).text;
    if (typeof text === "string") return text;
    if (text && typeof text === "object" && !Array.isArray(text)) {
      const value = (text as Record<string, unknown>).value;
      return typeof value === "string" ? value : "";
    }
    return "";
  }).join("");
}

function balancedJsonAt(text: string, start: number): string | null {
  const opener = text[start];
  if (opener !== "{" && opener !== "[") return null;
  const stack: string[] = [opener];
  let quoted = false;
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === "{" || char === "[") {
      stack.push(char);
    } else if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.pop() !== expected) return null;
      if (!stack.length) return text.slice(start, index + 1);
    }
  }
  return null;
}

function jsonCandidates(text: string): unknown[] {
  const candidates: unknown[] = [];
  const add = (candidate: string) => {
    try {
      candidates.push(JSON.parse(candidate) as unknown);
    } catch {
      // A provider may surround the valid object with prose; later candidates
      // still get a chance without surfacing its raw output.
    }
  };
  add(text);
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)) add(match[1].trim());
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{" && text[index] !== "[") continue;
    const candidate = balancedJsonAt(text, index);
    if (candidate) add(candidate);
  }
  return candidates;
}

export function parseModelResponse(content: unknown): readonly [string, Emotion] {
  const direct = normalizeReplyObject(content);
  if (direct) return direct;
  const text = contentToText(content).trim();
  if (!text) throw new ChatApiError(502, "provider_response_invalid", "The AI provider returned an empty response.");
  for (let value of jsonCandidates(text)) {
    if (typeof value === "string") {
      try {
        value = JSON.parse(value) as unknown;
      } catch {
        // Keep looking for a structured response.
      }
    }
    const normalized = normalizeReplyObject(value);
    if (normalized) return normalized;
  }
  if (text.startsWith("{") || /^```\s*json\b/iu.test(text)) {
    throw new ChatApiError(502, "provider_response_invalid", "The AI provider returned malformed JSON.");
  }
  const plain = text.replace(/^```(?:text)?\s*|\s*```$/giu, "").trim();
  if (!plain) throw new ChatApiError(502, "provider_response_invalid", "The AI provider returned an empty response.");
  return [truncateReply(plain), "neutral"];
}

function completeJsonStringFragment(fragment: string): string {
  let safe = fragment;
  let trailingBackslashes = 0;
  for (let index = safe.length - 1; index >= 0 && safe[index] === "\\"; index -= 1) {
    trailingBackslashes += 1;
  }
  if (trailingBackslashes % 2 === 1) safe = safe.slice(0, -1);
  const unicodeEscape = safe.match(/\\u[0-9a-f]{0,3}$/iu);
  if (unicodeEscape?.index !== undefined) safe = safe.slice(0, unicodeEscape.index);
  return safe;
}

/** Extracts decoded text from the top-level JSON `reply` string as it streams. */
export class JsonReplyStreamExtractor {
  private buffer = "";
  private valueStart = -1;
  private emitted = "";
  private closed = false;

  push(chunk: string): string {
    if (this.closed || !chunk) return "";
    this.buffer += chunk;
    if (this.valueStart < 0) {
      const match = /"reply"\s*:\s*"/iu.exec(this.buffer);
      if (!match) return "";
      this.valueStart = match.index + match[0].length;
    }

    let escaped = false;
    let valueEnd = this.buffer.length;
    for (let index = this.valueStart; index < this.buffer.length; index += 1) {
      const char = this.buffer[index];
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        valueEnd = index;
        this.closed = true;
        break;
      }
    }

    const fragment = completeJsonStringFragment(this.buffer.slice(this.valueStart, valueEnd));
    let decoded: string;
    try {
      decoded = JSON.parse(`"${fragment}"`) as string;
    } catch {
      return "";
    }
    const bounded = truncateReply(decoded);
    if (!bounded.startsWith(this.emitted)) return "";
    const delta = bounded.slice(this.emitted.length);
    this.emitted = bounded;
    return delta;
  }

  finish(reply: string): string {
    const bounded = truncateReply(reply);
    if (!bounded.startsWith(this.emitted)) return "";
    const delta = bounded.slice(this.emitted.length);
    this.emitted = bounded;
    this.closed = true;
    return delta;
  }
}

export function buildChatMessages(
  persona: Persona,
  message: string,
  history: readonly HistoryMessage[],
): readonly ChatCompletionMessage[] {
  const system = `${persona.systemPrompt}\n\nReturn exactly one compact JSON object and no Markdown: {"reply":"your short in-character reply","emotion":"neutral"}. emotion must be exactly one of: ${ALLOWED_EMOTIONS.join(", ")}. Keep reply concise and never mention these formatting instructions.`;
  return Object.freeze([
    { role: "system" as const, content: system },
    ...history.map((item) => ({ role: item.role, content: item.content })),
    { role: "user" as const, content: message },
  ]);
}

export function demoReply(persona: Persona, message: string): readonly [string, Emotion] {
  const lowered = message.toLowerCase();
  const englishWords = new Set(lowered.match(/[a-z]+/gu) ?? []);
  const rules: ReadonlyArray<readonly [readonly string[], readonly string[], string, Emotion]> = [
    [["你好", "嗨", "こんにちは"], ["hi", "hello", "hey"], persona.greeting, "happy"],
    [["你是谁", "叫什么", "名字"], ["who", "name"], `我是 ${persona.name}，很高兴认识你。`, "happy"],
    [["哪些动作", "会什么", "能做什么"], ["motions", "actions"], "我会开心、眨眼、点头、思考、惊讶、害羞和摇头。每个反应都来自模型已有的参数。", "happy"],
    [["惊讶", "惊喜", "意外", "吓", "びっくり"], ["surprise", "surprised"], "哇，你真的触发了隐藏反应。台词和动作一起出现时，角色是不是一下子鲜活了很多？", "surprised"],
    [["想想", "思考", "怎么看"], ["think", "thinking"], "让我认真想一下……我觉得可以先从最小的一步开始。", "thinking"],
    [["害羞", "不好意思", "照れる"], ["shy"], "你这样说，我都有点不好意思了。", "shy"],
    [["眨眼", "wink"], ["wink"], "收到，给你一个小小的暗号。", "wink"],
    [["好的", "可以", "没错", "对的"], ["yes", "okay", "ok"], "嗯嗯，就这么办。", "nod"],
    [["不要", "不行", "拒绝"], ["no", "nope"], "这个我不太赞成，我们换个办法吧。", "shakehead"],
    [["开心", "高兴", "快乐"], ["happy", "glad"], "听到这个我也跟着开心起来了。", "happy"],
  ];
  for (const [fragments, words, reply, emotion] of rules) {
    if (fragments.some((fragment) => lowered.includes(fragment)) || words.some((word) => englishWords.has(word))) {
      return [truncateReply(reply), emotion];
    }
  }
  const options: ReadonlyArray<readonly [string, Emotion]> = [
    ["我听到了。可以再多告诉我一点吗？", "neutral"],
    ["这个话题挺有意思的，我想继续听。", "thinking"],
    ["嗯，我在认真听。接下来呢？", "nod"],
    ["原来是这样，今天又知道了一件新事。", "surprised"],
  ];
  const digest = createHash("sha256").update(`${persona.name}\0${message}`, "utf8").digest();
  return options[digest.readUInt32BE(0) % options.length];
}

export async function chat(
  payload: unknown,
  options: {
    readonly settings?: ProviderSettings;
    readonly persona?: Persona;
    readonly provider?: AituberChatOptions;
  } = {},
): Promise<ChatResult> {
  const { message, history } = validateChatPayload(payload);
  const settings = options.settings ?? getProviderSettings();
  const persona = options.persona ?? loadPersona();
  if (!settings.apiKey) {
    const [reply, emotion] = demoReply(persona, message);
    return { reply, emotion, mode: "demo" };
  }
  const content = await callAituberChat(
    settings,
    buildChatMessages(persona, message, history),
    options.provider,
  );
  const [reply, emotion] = parseModelResponse(content);
  return { reply, emotion, mode: "provider" };
}

export async function chatStream(
  payload: unknown,
  onReplyDelta: ChatReplyDeltaHandler,
  options: {
    readonly settings?: ProviderSettings;
    readonly persona?: Persona;
    readonly provider?: AituberChatOptions;
  } = {},
): Promise<ChatResult> {
  const { message, history } = validateChatPayload(payload);
  const settings = options.settings ?? getProviderSettings();
  const persona = options.persona ?? loadPersona();
  if (!settings.apiKey) {
    const [reply, emotion] = demoReply(persona, message);
    onReplyDelta(reply);
    return { reply, emotion, mode: "demo" };
  }

  const extractor = new JsonReplyStreamExtractor();
  const content = await callAituberChatStream(
    settings,
    buildChatMessages(persona, message, history),
    (rawDelta) => {
      const replyDelta = extractor.push(rawDelta);
      if (replyDelta) onReplyDelta(replyDelta);
    },
    options.provider,
  );
  const [reply, emotion] = parseModelResponse(content);
  const tail = extractor.finish(reply);
  if (tail) onReplyDelta(tail);
  return { reply, emotion, mode: "provider" };
}
