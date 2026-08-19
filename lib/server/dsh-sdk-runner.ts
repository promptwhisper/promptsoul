import { randomUUID } from 'node:crypto';
import { findPackageJSON } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  HarnessClient,
  type ContentBlock,
  type HarnessClientOptions,
  type HarnessNotification,
  type NotificationFilter,
} from '@deepseek-ai/dsh-sdk-client';

import type { DshTurnRunner, DshTurnRunnerOptions } from './dsh-realtime';

const DEFAULT_PROVIDER = 'deepseek-official';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_MAX_TOKENS = 8_192;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_TURN_TIMEOUT_MS = 180_000;
const EXPECTED_SERVER_NAME = 'deepseek-harness-sdk-runtime';
const DSH_RUNTIME_PACKAGE = '@deepseek-ai/dsh-sdk-jsonrpc-demo';

const CHILD_ENV_ALLOWLIST = Object.freeze([
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'WINDIR',
] as const);

interface InitializeParams {
  readonly cwd: string;
  readonly provider: string;
  readonly model: string;
  readonly maxTokens?: number;
}

export interface DshSdkNotificationSubscription {
  next(): Promise<HarnessNotification>;
  close(): void;
}

export interface DshSdkClient {
  initialize(params: InitializeParams): Promise<{ serverInfo: { name: string; version: string } }>;
  prompt(sessionId: string, contentBlocks: ContentBlock[]): Promise<string>;
  subscribe(filter?: NotificationFilter): DshSdkNotificationSubscription;
  close(): Promise<void>;
}

export interface DshSdkTurnRunnerOptions {
  readonly workspaceCwd?: string;
  readonly runtimeConfigPath?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly requestTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly clientFactory?: (launch: HarnessClientOptions) => DshSdkClient;
  readonly sessionIdFactory?: () => string;
}

export class DshSdkTurnRunnerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DshSdkTurnRunnerError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${label} must be positive and finite`);
  return value;
}

export function createDshChildEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  const environment: Record<string, string> = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = source[name];
    if (typeof value === 'string') environment[name] = value;
  }
  return environment as NodeJS.ProcessEnv;
}

export function defaultDshRuntimeConfigPath(root = process.cwd()): string {
  return path.join(path.resolve(root), 'lib', 'server', 'dsh-runtime.cordis.yml');
}

export function defaultDshRuntimeExecutable(root = process.cwd()): string {
  const manifest = findPackageJSON(
    DSH_RUNTIME_PACKAGE,
    pathToFileURL(path.join(path.resolve(root), 'package.json')).href,
  );
  if (manifest === undefined) {
    throw new DshSdkTurnRunnerError(
      'dsh_runtime_missing',
      'The pinned DSH JSON-RPC runtime package is not installed.',
    );
  }
  return path.join(path.dirname(manifest), 'lib', 'bin.js');
}

export function createDshHarnessClientOptions(options: {
  readonly workspaceCwd?: string;
  readonly runtimeConfigPath?: string;
  readonly requestTimeoutMs?: number;
  readonly environment?: Readonly<Record<string, string | undefined>>;
} = {}): HarnessClientOptions {
  const workspaceCwd = path.resolve(options.workspaceCwd ?? process.cwd());
  const runtimeConfigPath = path.resolve(options.runtimeConfigPath ?? defaultDshRuntimeConfigPath());
  return {
    command: process.execPath,
    args: [defaultDshRuntimeExecutable(workspaceCwd), runtimeConfigPath],
    cwd: workspaceCwd,
    env: {
      ...createDshChildEnvironment(options.environment),
      // dsh-llm-deepseek's anonymous-id helper falls back to a process UUID
      // when this existing file cannot be used as a directory.
      DSH_HOME: runtimeConfigPath,
    },
    requestTimeoutMs: positiveFinite(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    ),
    shutdownTimeoutMs: 250,
    disposeEofGraceMs: 250,
    disposeGraceMs: 250,
  };
}

function protocolError(message: string): DshSdkTurnRunnerError {
  return new DshSdkTurnRunnerError('dsh_protocol_error', message);
}

function belongsToTurn(notification: HarnessNotification, sessionId: string): boolean {
  if (notification.params.sessionId !== sessionId) return false;
  if (notification.method === 'session.status') return true;
  if (notification.method !== 'session.event') return false;
  const event = notification.params.event;
  if (!isRecord(event)) return true;
  if (event.type === 'turn/end') return true;
  if (event.type !== 'assistant/chunk') return false;
  if (!isRecord(event.data)) return true;
  const chunk = event.data.chunk;
  if (!isRecord(chunk) || typeof chunk.type !== 'string') return true;
  return chunk.type === 'text-delta';
}

interface Cancellation {
  readonly promise: Promise<never>;
  dispose(): void;
}

export class DshSdkTurnRunner implements DshTurnRunner {
  private readonly workspaceCwd: string;
  private readonly provider: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly turnTimeoutMs: number;
  private readonly launch: HarnessClientOptions;
  private readonly clientFactory: (launch: HarnessClientOptions) => DshSdkClient;
  private readonly sessionIdFactory: () => string;
  private client: DshSdkClient | undefined;
  private initializeTask: Promise<void> | undefined;
  private resetTask: Promise<void> | undefined;
  private running = false;
  private closed = false;

  constructor(options: DshSdkTurnRunnerOptions = {}) {
    this.workspaceCwd = path.resolve(options.workspaceCwd ?? process.cwd());
    this.provider = options.provider ?? DEFAULT_PROVIDER;
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxTokens = positiveSafeInteger(options.maxTokens ?? DEFAULT_MAX_TOKENS, 'maxTokens');
    this.turnTimeoutMs = positiveFinite(options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS, 'turnTimeoutMs');
    this.launch = createDshHarnessClientOptions({
      workspaceCwd: this.workspaceCwd,
      runtimeConfigPath: options.runtimeConfigPath,
      requestTimeoutMs: options.requestTimeoutMs,
      environment: options.environment,
    });
    this.clientFactory = options.clientFactory ?? ((launch) => new HarnessClient(launch));
    this.sessionIdFactory = options.sessionIdFactory ?? randomUUID;
  }

  async run(input: string, options: DshTurnRunnerOptions): Promise<{ reason: string }> {
    if (this.closed) throw new DshSdkTurnRunnerError('dsh_runner_closed', 'The DSH runtime runner is closed.');
    if (this.running) throw new DshSdkTurnRunnerError('dsh_runner_busy', 'The DSH runtime runner is busy.');
    options.signal.throwIfAborted();
    this.running = true;
    const client = this.getClient();
    const cancellation = this.createCancellation(options.signal);
    let subscription: DshSdkNotificationSubscription | undefined;
    try {
      await Promise.race([this.initialize(client), cancellation.promise]);
      const sessionId = this.sessionIdFactory();
      subscription = client.subscribe((notification) => belongsToTurn(notification, sessionId));
      await Promise.race([
        client.prompt(sessionId, [{ type: 'text', text: input }]),
        cancellation.promise,
      ]);
      let ended = false;
      while (true) {
        const notification = await Promise.race([subscription.next(), cancellation.promise]);
        if (notification.method === 'session.status') {
          const status = notification.params.status;
          if (status === 'running') continue;
          if (status !== 'idle') throw protocolError('DSH emitted an invalid session status.');
          if (!ended) throw protocolError('DSH became idle without a turn/end event.');
          return { reason: 'completed' };
        }

        const rawEvent = notification.params.event;
        if (!isRecord(rawEvent) || typeof rawEvent.type !== 'string' || !isRecord(rawEvent.data)) {
          throw protocolError('DSH emitted a malformed session event.');
        }
        if (rawEvent.type === 'assistant/chunk') {
          if (ended) throw protocolError('DSH emitted an assistant chunk after turn/end.');
          const rawChunk = rawEvent.data.chunk;
          if (!isRecord(rawChunk) || typeof rawChunk.type !== 'string') {
            throw protocolError('DSH emitted a malformed assistant chunk.');
          }
          if (rawChunk.type !== 'text-delta') continue;
          if (typeof rawChunk.text !== 'string') {
            throw protocolError('DSH emitted a text delta without text.');
          }
          options.onTextDelta(rawChunk.text);
          continue;
        }
        if (rawEvent.type !== 'turn/end') throw protocolError('DSH emitted an unexpected session event.');
        if (ended) throw protocolError('DSH emitted duplicate turn/end events.');
        const reason = rawEvent.data.reason;
        if (!isRecord(reason) || typeof reason.kind !== 'string') {
          throw protocolError('DSH emitted turn/end without a valid reason.');
        }
        if (reason.kind !== 'completed') {
          throw new DshSdkTurnRunnerError('dsh_turn_incomplete', 'The DSH turn did not complete.');
        }
        ended = true;
      }
    } catch (error) {
      await this.resetClient().catch(() => undefined);
      if (options.signal.aborted) options.signal.throwIfAborted();
      throw error;
    } finally {
      subscription?.close();
      cancellation.dispose();
      this.running = false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.resetClient();
  }

  private getClient(): DshSdkClient {
    if (this.client === undefined) this.client = this.clientFactory(this.launch);
    return this.client;
  }

  private initialize(client: DshSdkClient): Promise<void> {
    this.initializeTask ??= client.initialize({
      cwd: this.workspaceCwd,
      provider: this.provider,
      model: this.model,
      maxTokens: this.maxTokens,
    }).then((result) => {
      if (result.serverInfo.name !== EXPECTED_SERVER_NAME) {
        throw protocolError('DSH returned an unexpected server identity.');
      }
    });
    return this.initializeTask;
  }

  private createCancellation(signal: AbortSignal): Cancellation {
    let settled = false;
    let rejectCancellation!: (reason: unknown) => void;
    const promise = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const stop = (reason: unknown): void => {
      if (settled) return;
      settled = true;
      void this.resetClient().catch(() => undefined);
      rejectCancellation(reason);
    };
    const onAbort = (): void => stop(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      stop(new DshSdkTurnRunnerError('dsh_turn_timeout', 'The DSH turn exceeded its time limit.'));
    }, this.turnTimeoutMs);
    timer.unref();
    if (signal.aborted) onAbort();
    return {
      promise,
      dispose: () => {
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      },
    };
  }

  private resetClient(): Promise<void> {
    if (this.resetTask !== undefined) return this.resetTask;
    const client = this.client;
    this.client = undefined;
    this.initializeTask = undefined;
    if (client === undefined) return Promise.resolve();
    const reset = client.close().finally(() => {
      if (this.resetTask === reset) this.resetTask = undefined;
    });
    this.resetTask = reset;
    return reset;
  }
}

export function createDshTurnRunner(options: DshSdkTurnRunnerOptions = {}): DshTurnRunner {
  return new DshSdkTurnRunner(options);
}
