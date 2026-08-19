import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  HarnessClient,
  type HarnessClientOptions,
  type HarnessNotification,
  type NotificationFilter,
} from '@deepseek-ai/dsh-sdk-client';

import {
  createDshChildEnvironment,
  createDshHarnessClientOptions,
  DshSdkTurnRunner,
  DshSdkTurnRunnerError,
  type DshSdkClient,
  type DshSdkNotificationSubscription,
} from '../lib/server/dsh-sdk-runner';

function event(sessionId: string, type: string, data: unknown): HarnessNotification {
  return { method: 'session.event', params: { sessionId, event: { type, data, seq: 0, time: 0 } } };
}

function chunk(sessionId: string, chunkValue: unknown): HarnessNotification {
  return event(sessionId, 'assistant/chunk', { turn: 0, step: 0, chunk: chunkValue });
}

function completed(sessionId: string, kind = 'completed'): HarnessNotification[] {
  return [
    event(sessionId, 'turn/end', { turn: 0, reason: { kind } }),
    { method: 'session.status', params: { sessionId, status: 'idle' } },
  ];
}

class FakeClient implements DshSdkClient {
  readonly promptedSessions: string[] = [];
  initializeCount = 0;
  closeCount = 0;
  private active: { filter?: NotificationFilter; queue: HarnessNotification[] } | undefined;

  constructor(private readonly scripts: ((sessionId: string) => HarnessNotification[])[]) {}

  async initialize(): Promise<{ serverInfo: { name: string; version: string } }> {
    this.initializeCount += 1;
    return { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: 'test' } };
  }

  async prompt(sessionId: string): Promise<string> {
    this.promptedSessions.push(sessionId);
    const active = this.active;
    assert.ok(active);
    const script = this.scripts.shift();
    assert.ok(script);
    active.queue.push(...script(sessionId).filter((notification) => active.filter?.(notification) ?? true));
    return `message-${this.promptedSessions.length}`;
  }

  subscribe(filter?: NotificationFilter): DshSdkNotificationSubscription {
    const active = { filter, queue: [] as HarnessNotification[] };
    this.active = active;
    return {
      next: async () => {
        const notification = active.queue.shift();
        if (notification === undefined) return new Promise<HarnessNotification>(() => {});
        return notification;
      },
      close: () => {
        if (this.active === active) this.active = undefined;
      },
    };
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

function runnerWith(client: FakeClient): DshSdkTurnRunner {
  return new DshSdkTurnRunner({
    environment: { DEEPSEEK_API_KEY: 'test-key' },
    clientFactory: () => client,
    turnTimeoutMs: 10_000,
  });
}

test('runner streams only text deltas and uses a fresh session for every turn', async () => {
  const client = new FakeClient([
    (sessionId) => [
      event(sessionId, 'user/message', { ignored: true }),
      chunk(sessionId, { type: 'reasoning-delta', index: 0, text: 'private reasoning' }),
      chunk(sessionId, { type: 'text-delta', index: 0, text: '{"type":"segment"' }),
      chunk('another-session', { type: 'text-delta', index: 0, text: 'wrong session' }),
      ...completed(sessionId),
    ],
    (sessionId) => [
      chunk(sessionId, { type: 'text-delta', index: 0, text: '}\n' }),
      ...completed(sessionId),
    ],
  ]);
  const runner = runnerWith(client);
  const received: string[] = [];

  assert.deepEqual(
    await runner.run('first', { signal: new AbortController().signal, onTextDelta: (text) => received.push(text) }),
    { reason: 'completed' },
  );
  assert.deepEqual(
    await runner.run('second', { signal: new AbortController().signal, onTextDelta: (text) => received.push(text) }),
    { reason: 'completed' },
  );

  assert.deepEqual(received, ['{"type":"segment"', '}\n']);
  assert.equal(client.initializeCount, 1);
  assert.equal(client.promptedSessions.length, 2);
  assert.notEqual(client.promptedSessions[0], client.promptedSessions[1]);
  assert.equal(client.closeCount, 0);
  await runner.close();
  assert.equal(client.closeCount, 1);
});

test('runner closes the runtime on abort and malformed protocol data', async () => {
  const abortClient = new FakeClient([() => []]);
  const abortRunner = runnerWith(abortClient);
  const controller = new AbortController();
  const pending = abortRunner.run('wait', { signal: controller.signal, onTextDelta: () => {} });
  controller.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/u);
  assert.equal(abortClient.closeCount, 1);

  const malformedClient = new FakeClient([
    (sessionId) => [chunk(sessionId, { type: 'text-delta', index: 0, text: 42 })],
  ]);
  const malformedRunner = runnerWith(malformedClient);
  await assert.rejects(
    malformedRunner.run('bad', { signal: new AbortController().signal, onTextDelta: () => {} }),
    (error: unknown) => error instanceof DshSdkTurnRunnerError && error.code === 'dsh_protocol_error',
  );
  assert.equal(malformedClient.closeCount, 1);
});

test('runner requires a completed turn/end before idle and closes incomplete turns', async () => {
  const client = new FakeClient([(sessionId) => completed(sessionId, 'max-tokens')]);
  const runner = runnerWith(client);
  await assert.rejects(
    runner.run('limited', { signal: new AbortController().signal, onTextDelta: () => {} }),
    (error: unknown) => error instanceof DshSdkTurnRunnerError && error.code === 'dsh_turn_incomplete',
  );
  assert.equal(client.closeCount, 1);
});

test('runner rejects an unexpected JSON-RPC server identity', async () => {
  const client = new FakeClient([() => []]);
  client.initialize = async () => {
    client.initializeCount += 1;
    return { serverInfo: { name: 'wrong-runtime', version: 'test' } };
  };
  const runner = runnerWith(client);
  await assert.rejects(
    runner.run('hello', { signal: new AbortController().signal, onTextDelta: () => {} }),
    (error: unknown) => error instanceof DshSdkTurnRunnerError && error.code === 'dsh_protocol_error',
  );
  assert.equal(client.closeCount, 1);
});

test('child environment is an explicit allowlist', () => {
  const environment = createDshChildEnvironment({
    DEEPSEEK_API_KEY: 'key',
    DEEPSEEK_BASE_URL: 'https://example.invalid',
    HTTPS_PROXY: 'http://proxy.invalid',
    NODE_EXTRA_CA_CERTS: '/certs/ca.pem',
    NPC_API_KEY: 'must-not-leak',
    OPENAI_API_KEY: 'must-not-leak',
    HOME: '/secret/home',
    PATH: '/untrusted/bin',
    NODE_OPTIONS: '--require /tmp/inject.cjs',
    DSH_HOME: '/secret/dsh-home',
  });
  assert.deepEqual(environment, {
    DEEPSEEK_API_KEY: 'key',
    DEEPSEEK_BASE_URL: 'https://example.invalid',
    HTTPS_PROXY: 'http://proxy.invalid',
    NODE_EXTRA_CA_CERTS: '/certs/ca.pem',
  });
});

test('launch forces the non-persistable DSH home to the runtime config file', () => {
  const runtimeConfigPath = path.join(process.cwd(), 'lib', 'server', 'dsh-runtime.cordis.yml');
  const launch = createDshHarnessClientOptions({
    runtimeConfigPath,
    environment: {
      DSH_HOME: '/must/not/pass-through',
      HOME: '/must/not/pass-through',
      DEEPSEEK_API_KEY: 'key',
    },
  });
  assert.equal(launch.env?.DSH_HOME, runtimeConfigPath);
  assert.equal(launch.env?.HOME, undefined);
  assert.equal(launch.env?.DEEPSEEK_API_KEY, 'key');
  assert.equal(
    launch.args?.[0],
    path.join(
      process.cwd(),
      'node_modules',
      '@deepseek-ai',
      'dsh-sdk-jsonrpc-demo',
      'lib',
      'bin.js',
    ),
  );
  assert.equal(launch.shutdownTimeoutMs, 250);
  assert.equal(launch.disposeEofGraceMs, 250);
  assert.equal(launch.disposeGraceMs, 250);
});

test('Cordis runtime config mounts only the minimal tool-free agent stack', () => {
  const filename = path.join(process.cwd(), 'lib', 'server', 'dsh-runtime.cordis.yml');
  const source = readFileSync(filename, 'utf8');
  const packages = [...source.matchAll(/^\s*name:\s*'([^']+)'\s*$/gmu)].map((match) => match[1]);
  assert.deepEqual(packages, [
    '@deepseek-ai/dsh-sdk-jsonrpc-server',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-agent-loop',
    '@deepseek-ai/dsh-llm-deepseek',
  ]);
  assert.match(source, /includeHarnessIdentity:\s*false/u);
  assert.match(source, /includeRuntimeContext:\s*false/u);
  assert.match(source, /maxRetries:\s*0/u);
  assert.doesNotMatch(source, /spine|bash|skill|job|goal|workspace|persistence|subagent/iu);
});

test('real minimal Cordis runtime completes initialize and shutdown without a provider request', async () => {
  const launch: HarnessClientOptions = createDshHarnessClientOptions({
    environment: { NODE_ENV: 'test' },
    requestTimeoutMs: 10_000,
  });
  const client = new HarnessClient(launch);
  try {
    const result = await client.initialize({
      cwd: process.cwd(),
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      maxTokens: 8_192,
    });
    assert.equal(result.serverInfo.name, 'deepseek-harness-sdk-runtime');
  } finally {
    await client.close();
  }
});
