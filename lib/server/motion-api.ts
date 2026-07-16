import { callChatCompletions, ProviderRequestError } from './provider-client';
import type { ChatCompletionMessage } from './provider-client';
import { getProviderSettings } from './provider-store';
import type { ProviderSettings } from './provider-store';
import {
  authorMotion,
  buildAuthoringMessages,
  deleteAuthoredMotion,
  isPublicMotionId,
  listAuthoredMotions,
  loadModelProfile,
  MAX_SPEC_BYTES,
  MOTION_GROUP,
  MotionAuthoringError,
  MotionNotFeasibleError,
  motionIdForDescription,
  normalizeMotionPrompt,
  opaqueMotionRevision,
  parseMotionSpec,
} from './motion-authoring';

export const MAX_MOTION_PROMPT_CHARS = 1_000;
const MOTION_PROVIDER_TIMEOUT_MS = 90_000;

export class MotionApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'MotionApiError';
    this.status = status;
    this.code = code;
  }
}

export interface PublicMotion {
  readonly group: typeof MOTION_GROUP;
  readonly index: number;
  readonly name: string;
  readonly label: string;
  readonly revision: string;
  readonly duration?: number;
}

export interface MotionCapabilities {
  readonly available: boolean;
  readonly mode: 'demo' | 'provider';
  readonly group: typeof MOTION_GROUP;
  readonly maxPromptLength: number;
  readonly motions: readonly PublicMotion[];
}

type ProviderCaller = (
  settings: ProviderSettings,
  messages: readonly ChatCompletionMessage[],
  options: { timeoutMs: number; maxResponseBytes: number },
) => Promise<unknown>;

interface MotionApiDependencies {
  readonly root?: string;
  readonly settings?: Readonly<ProviderSettings>;
  readonly callProvider?: ProviderCaller;
}

interface GenerationState {
  busy: boolean;
}

const GENERATION_STATE_KEY: unique symbol = Symbol.for('promptsoul.motion.generation.v1') as never;
type GlobalWithGenerationState = typeof globalThis & { [GENERATION_STATE_KEY]?: GenerationState };

function generationState(): GenerationState {
  const target = globalThis as GlobalWithGenerationState;
  if (!target[GENERATION_STATE_KEY]) target[GENERATION_STATE_KEY] = { busy: false };
  return target[GENERATION_STATE_KEY];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateMotionPayload(value: unknown): string {
  if (!isObject(value)) throw new MotionApiError(400, 'invalid_request', 'Request JSON must be an object.');
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'prompt') {
    throw new MotionApiError(400, 'invalid_request', 'Request contains unsupported fields.');
  }
  if (typeof value.prompt !== 'string') {
    throw new MotionApiError(400, 'invalid_prompt', "'prompt' must be a string.");
  }
  const trimmed = value.prompt.trim();
  if (!trimmed) throw new MotionApiError(400, 'invalid_prompt', "'prompt' must not be empty.");
  if (trimmed.length > MAX_MOTION_PROMPT_CHARS) {
    throw new MotionApiError(413, 'prompt_too_large', "'prompt' is too long.");
  }
  if ([...trimmed].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 && character !== '\t' && character !== '\r' && character !== '\n';
  })) {
    throw new MotionApiError(400, 'invalid_prompt', "'prompt' contains invalid characters.");
  }
  const normalized = normalizeMotionPrompt(trimmed);
  if (!normalized) throw new MotionApiError(400, 'invalid_prompt', "'prompt' must not be empty.");
  return normalized;
}

export function validateDeleteMotionId(value: unknown): string {
  if (typeof value !== 'string' || !isPublicMotionId(value)) {
    throw new MotionApiError(400, 'invalid_motion_id', 'Motion id must identify a generated PromptSoul action.');
  }
  return value;
}

export function validateDeleteMotionPayload(value: unknown): string {
  if (!isObject(value)) throw new MotionApiError(400, 'invalid_request', 'Request JSON must be an object.');
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'revision') {
    throw new MotionApiError(400, 'invalid_request', 'Request contains unsupported fields.');
  }
  if (typeof value.revision !== 'string' || !/^rev_[0-9a-f]{16}$/u.test(value.revision)) {
    throw new MotionApiError(400, 'invalid_revision', 'Motion revision is invalid.');
  }
  return value.revision;
}

function publicMotion(value: unknown, expectedId?: string, fallbackLabel = 'AI 动作'): PublicMotion | undefined {
  if (!isObject(value)) return undefined;
  if (value.group !== MOTION_GROUP) return undefined;
  if (!Number.isInteger(value.index) || (value.index as number) < 0) return undefined;
  const name = expectedId ?? (typeof value.name === 'string' ? value.name : '');
  if (!isPublicMotionId(name)) return undefined;
  if (typeof value.revision !== 'string') return undefined;
  let revision: string;
  try {
    revision = opaqueMotionRevision(value.revision);
  } catch {
    return undefined;
  }
  const rawLabel = typeof value.label === 'string' ? value.label.trim().replace(/\s+/gu, ' ') : '';
  const label = rawLabel && rawLabel.length <= 80 && !/[\u0000-\u001f\u007f]/u.test(rawLabel)
    ? rawLabel
    : fallbackLabel.slice(0, 80);
  const motion: PublicMotion = {
    group: MOTION_GROUP,
    index: value.index as number,
    name,
    label: label || 'AI 动作',
    revision,
  };
  if (typeof value.duration === 'number' && Number.isFinite(value.duration) && value.duration > 0 && value.duration <= 60) {
    return { ...motion, duration: Number(value.duration.toFixed(3)) };
  }
  return motion;
}

function listedMotions(root: string): PublicMotion[] {
  try {
    return listAuthoredMotions(root)
      .map((motion) => publicMotion(motion))
      .filter((motion): motion is PublicMotion => Boolean(motion))
      .sort((left, right) => left.index - right.index);
  } catch {
    return [];
  }
}

export function motionCapabilities(dependencies: MotionApiDependencies = {}): MotionCapabilities {
  const root = dependencies.root ?? process.cwd();
  const settings = dependencies.settings ?? getProviderSettings();
  let ready = false;
  if (settings.apiKey) {
    try {
      ready = loadModelProfile(root).controls.length > 0;
    } catch {
      ready = false;
    }
  }
  return {
    available: ready,
    mode: settings.apiKey ? 'provider' : 'demo',
    group: MOTION_GROUP,
    maxPromptLength: MAX_MOTION_PROMPT_CHARS,
    motions: listedMotions(root),
  };
}

function providerContentToText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (isObject(content)) return JSON.stringify(content);
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === 'string') return item;
      if (!isObject(item)) return '';
      if (typeof item.text === 'string') return item.text;
      if (isObject(item.text) && typeof item.text.value === 'string') return item.text.value;
      return '';
    }).join('').trim();
  }
  return '';
}

function mapAuthoringError(error: MotionAuthoringError): MotionApiError {
  if (error instanceof MotionNotFeasibleError || error.code === 'motion_not_feasible') {
    return new MotionApiError(
      422,
      'motion_not_feasible',
      'The requested motion cannot be expressed safely by this model.',
    );
  }
  if (error.code === 'model_changed' || error.code === 'motion_conflict') {
    return new MotionApiError(409, 'model_changed', 'The model changed during generation.');
  }
  if (error.code === 'motion_limit_reached') {
    return new MotionApiError(
      409,
      'motion_limit_reached',
      'The AI motion limit has been reached for this model.',
    );
  }
  if (error.code === 'invalid_motion_spec') {
    return new MotionApiError(
      502,
      'provider_response_invalid',
      'The AI provider returned an invalid motion specification.',
    );
  }
  if (error.code === 'model_not_ready') {
    return new MotionApiError(
      503,
      'motion_generation_unavailable',
      'The current model is not ready for motion generation.',
    );
  }
  return new MotionApiError(500, 'authoring_failed', 'Could not save the generated motion.');
}

function mapDeletionError(error: MotionAuthoringError): MotionApiError {
  if (error.code === 'motion_not_found') {
    return new MotionApiError(404, 'motion_not_found', 'The generated motion does not exist for the active model.');
  }
  if (error.code === 'model_changed') {
    return new MotionApiError(409, 'model_changed', 'The active model changed before deletion.');
  }
  if (
    error.code === 'motion_conflict'
    || error.code === 'invalid_motion_spec'
  ) {
    return new MotionApiError(
      409,
      'motion_delete_conflict',
      'The generated motion could not be verified and was not deleted.',
    );
  }
  if (error.code === 'model_not_ready') {
    return new MotionApiError(503, 'motion_delete_unavailable', 'The active model is not ready.');
  }
  return new MotionApiError(500, 'motion_delete_failed', 'Could not delete the generated motion.');
}

export interface GeneratedMotionResponse {
  readonly motion: PublicMotion;
  readonly message: string;
  readonly modelRevision: string;
}

export async function generateMotion(
  payload: unknown,
  dependencies: MotionApiDependencies = {},
): Promise<GeneratedMotionResponse> {
  const prompt = validateMotionPayload(payload);
  const root = dependencies.root ?? process.cwd();
  const settings = dependencies.settings ?? getProviderSettings();
  if (!settings.apiKey) {
    throw new MotionApiError(
      503,
      'motion_generation_unavailable',
      'Motion generation requires a configured AI provider.',
    );
  }
  const state = generationState();
  if (state.busy) throw new MotionApiError(409, 'generation_in_progress', 'A motion is already being generated.');
  state.busy = true;
  try {
    let profile;
    try {
      profile = loadModelProfile(root);
      if (!profile.controls.length) throw new Error('no controls');
    } catch {
      throw new MotionApiError(
        503,
        'motion_generation_unavailable',
        'The current model is not ready for motion generation.',
      );
    }
    const motionId = motionIdForDescription(prompt);
    const messages = buildAuthoringMessages(prompt, profile, motionId);
    const callProvider = dependencies.callProvider ?? callChatCompletions;
    const content = await callProvider(settings, messages, {
      timeoutMs: MOTION_PROVIDER_TIMEOUT_MS,
      maxResponseBytes: MAX_SPEC_BYTES,
    });
    const text = providerContentToText(content);
    if (!text) {
      throw new MotionApiError(
        502,
        'provider_response_invalid',
        'The AI provider returned an empty motion specification.',
      );
    }
    let spec;
    try {
      spec = parseMotionSpec(text);
    } catch (error) {
      if (error instanceof MotionAuthoringError) throw mapAuthoringError(error);
      throw new MotionApiError(
        502,
        'provider_response_invalid',
        'The AI provider returned an invalid motion specification.',
      );
    }
    let authored;
    try {
      authored = authorMotion(spec, motionId, { root, expectedRevision: profile.revision });
    } catch (error) {
      if (error instanceof MotionAuthoringError) throw mapAuthoringError(error);
      throw new MotionApiError(500, 'authoring_failed', 'Could not save the generated motion.');
    }
    const motion = publicMotion(authored, motionId, prompt);
    if (!motion) throw new MotionApiError(500, 'authoring_failed', 'Could not verify the generated motion.');
    return {
      motion,
      message: '动作已生成，可以预览了。',
      modelRevision: opaqueMotionRevision(authored.revision),
    };
  } catch (error) {
    if (error instanceof MotionApiError || error instanceof ProviderRequestError) throw error;
    throw new MotionApiError(500, 'authoring_failed', 'Could not generate the motion.');
  } finally {
    state.busy = false;
  }
}


export interface DeletedMotionResponse {
  readonly motion: PublicMotion;
  readonly message: string;
  readonly modelRevision: string;
  readonly cleanupPending: boolean;
}

export function deleteMotion(
  motionIdValue: unknown,
  payload: unknown,
  dependencies: MotionApiDependencies = {},
): DeletedMotionResponse {
  const motionId = validateDeleteMotionId(motionIdValue);
  const expectedRevision = validateDeleteMotionPayload(payload);
  const root = dependencies.root ?? process.cwd();
  const state = generationState();
  if (state.busy) throw new MotionApiError(409, 'generation_in_progress', 'A motion is already being generated.');
  state.busy = true;
  try {
    let deleted;
    try {
      deleted = deleteAuthoredMotion(motionId, { root, expectedRevision });
    } catch (error) {
      if (error instanceof MotionAuthoringError) throw mapDeletionError(error);
      throw new MotionApiError(500, 'motion_delete_failed', 'Could not delete the generated motion.');
    }
    const motion = publicMotion(deleted.motion, motionId, deleted.motion.label);
    if (!motion) {
      throw new MotionApiError(500, 'motion_delete_failed', 'Could not verify the deleted motion.');
    }
    return {
      motion,
      message: deleted.cleanupPending ? '动作已删除；有未注册的本地残留文件待清理。' : '动作已删除。',
      modelRevision: opaqueMotionRevision(deleted.revision),
      cleanupPending: deleted.cleanupPending,
    };
  } finally {
    state.busy = false;
  }
}
