import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderEvent } from '../../provider/types.js';
import {
  type CodexAppServerClient,
  type CodexMessageListener,
  dispatchCodexServerMessage,
} from './client.js';
import { CodexProvider } from './provider.js';

interface RequestRecord {
  method: string;
  params: Record<string, unknown>;
}

class FakeCodexClient implements CodexAppServerClient {
  closed = false;
  failed = false;
  readonly requests: RequestRecord[] = [];
  readonly responses: Array<{ id: number | string; result: unknown }> = [];
  readonly serverErrors: Array<{
    error: { code: number; message: string };
    id: number | string;
  }> = [];
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly listeners = new Set<CodexMessageListener>();

  async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === 'thread/start' || method === 'thread/resume') {
      return { thread: { id: 'codex-thread' } };
    }
    if (method === 'turn/start') {
      queueMicrotask(() => this.emitTurnStart());
      return { turn: { id: 'codex-turn' } };
    }
    if (method === 'turn/interrupt') {
      queueMicrotask(() => this.emitTurnCompleted('interrupted'));
      return {};
    }
    return {};
  }

  respond(id: number | string, result: unknown): void {
    if (this.failed) throw new Error('fake Codex transport failed');
    this.responses.push({ id, result });
    if (
      typeof result === 'object' &&
      result !== null &&
      'decision' in result &&
      result.decision === 'accept'
    ) {
      queueMicrotask(() => this.emitAfterApproval());
    }
  }

  subscribe(listener: CodexMessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  fail(error: Error): void {
    this.failed = true;
    for (const listener of this.errorListeners) listener(error);
  }

  private emit(message: Record<string, unknown>): void {
    dispatchCodexServerMessage(message, this.listeners, (id, error) => {
      this.serverErrors.push({ error, id });
    });
  }

  private emitTurnStart(): void {
    this.emit({
      method: 'item/agentMessage/delta',
      params: {
        delta: 'Hello',
        itemId: 'message-1',
        threadId: 'codex-thread',
        turnId: 'codex-turn',
      },
    });
    this.emit({
      method: 'item/started',
      params: {
        item: commandItem('inProgress'),
        threadId: 'codex-thread',
        turnId: 'codex-turn',
      },
    });
    this.emit({
      id: 77,
      method: 'item/commandExecution/requestApproval',
      params: {
        command: 'npm test',
        cwd: '/workspace',
        itemId: 'command-1',
        threadId: 'codex-thread',
        turnId: 'codex-turn',
      },
    });
  }

  private emitAfterApproval(): void {
    this.emit({
      method: 'item/completed',
      params: {
        item: commandItem('completed'),
        threadId: 'codex-thread',
        turnId: 'codex-turn',
      },
    });
    this.emit({
      method: 'item/completed',
      params: {
        item: fileChangeItem(),
        threadId: 'codex-thread',
        turnId: 'codex-turn',
      },
    });
    this.emit({
      method: 'item/completed',
      params: {
        item: renamedFileChangeItem(),
        threadId: 'codex-thread',
        turnId: 'codex-turn',
      },
    });
    this.emit({
      method: 'item/completed',
      params: {
        item: webSearchItem(),
        threadId: 'codex-thread',
        turnId: 'codex-turn',
      },
    });
    this.emit({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'codex-thread',
        tokenUsage: {
          last: {
            cachedInputTokens: 2,
            inputTokens: 10,
            outputTokens: 5,
            reasoningOutputTokens: 1,
            totalTokens: 17,
          },
        },
        turnId: 'codex-turn',
      },
    });
    this.emitTurnCompleted('completed');
  }

  private emitTurnCompleted(status: string): void {
    this.emit({
      method: 'turn/completed',
      params: {
        threadId: 'codex-thread',
        turn: { durationMs: 30, id: 'codex-turn', status },
      },
    });
  }
}

function commandItem(status: string): Record<string, unknown> {
  return {
    aggregatedOutput: status === 'completed' ? 'ok' : null,
    command: 'npm test',
    commandActions: [],
    cwd: '/workspace',
    durationMs: status === 'completed' ? 20 : null,
    exitCode: status === 'completed' ? 0 : null,
    id: 'command-1',
    status,
    type: 'commandExecution',
  };
}

function fileChangeItem(): Record<string, unknown> {
  return {
    changes: [
      {
        diff: '+export const ready = true;',
        kind: { type: 'update' },
        path: '/workspace/src/main.ts',
      },
    ],
    id: 'file-1',
    status: 'completed',
    type: 'fileChange',
  };
}

function renamedFileChangeItem(): Record<string, unknown> {
  return {
    changes: [
      {
        diff: '@@ -1 +1 @@\n-before\n+after',
        kind: {
          move_path: '/workspace/src/renamed.ts',
          type: 'update',
        },
        path: '/workspace/src/original.ts',
      },
    ],
    id: 'file-rename',
    status: 'completed',
    type: 'fileChange',
  };
}

function webSearchItem(): Record<string, unknown> {
  return {
    action: { query: 'Codex app-server protocol', type: 'search' },
    id: 'web-1',
    query: 'Codex app-server protocol',
    type: 'webSearch',
  };
}

test('declares only capabilities proven by the Codex app-server', () => {
  const provider = new CodexProvider({
    clientFactory: async () => new FakeCodexClient(),
  });

  assert.deepEqual(provider.capabilities(), {
    approvals: true,
    costReporting: false,
    interrupt: true,
    sessions: true,
    streaming: true,
    toolUse: true,
  });
});

test('translates Codex events and approval responses without leaking wire types', async () => {
  const client = new FakeCodexClient();
  const provider = new CodexProvider({
    clientFactory: async () => client,
    createId: () => 'local-session',
  });
  const session = await provider.createSession({
    cwd: '/workspace',
    profile: { id: 'default', model: 'codex-test' },
  });

  const events = await collectApprovedRun(session, client);

  assertSessionStart(client);
  assert.deepEqual(client.responses, [
    { id: 77, result: { decision: 'accept' } },
  ]);
  assertTranslatedEvents(events);
  assert.equal(session.providerSessionId, 'codex-thread');
});

async function collectApprovedRun(
  session: Awaited<ReturnType<CodexProvider['createSession']>>,
  client: FakeCodexClient,
): Promise<ProviderEvent[]> {
  const events = [];
  for await (const event of session.send({
    actor: 'human',
    content: 'Inspect the repository.',
    runId: 'run-1',
  })) {
    events.push(event);
    if (event.type === 'approval.requested') {
      await session.respondToApproval(event.approvalId, {
        actor: 'human',
        decision: 'approve',
      });
    }
  }
  assert.equal(
    client.requests.some((item) => item.method === 'turn/start'),
    true,
  );
  return events;
}

function assertSessionStart(client: FakeCodexClient): void {
  const start = client.requests.find((item) => item.method === 'thread/start');
  assert.deepEqual(start?.params, {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    cwd: '/workspace',
    ephemeral: false,
    model: 'codex-test',
    sandbox: 'read-only',
  });
}

function assertTranslatedEvents(events: ProviderEvent[]): void {
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'run.started',
      'message.input',
      'text.delta',
      'tool.call',
      'approval.requested',
      'approval.resolved',
      'tool.call',
      'file.change',
      'file.change',
      'file.change',
      'tool.call',
      'turn.completed',
    ],
  );
  const approval = events.find((event) => event.type === 'approval.requested');
  assert.equal(approval?.risk, 'execute');
  const completion = events.find((event) => event.type === 'turn.completed');
  assert.deepEqual(completion?.usage, {
    cachedInputTokens: 2,
    inputTokens: 10,
    outputTokens: 5,
    reasoningTokens: 1,
    totalTokens: 17,
  });
  const rename = events
    .filter((event) => event.type === 'file.change')
    .slice(-2)
    .map((event) => ({ change: event.change, path: event.path }));
  assert.deepEqual(rename, [
    { change: 'delete', path: '/workspace/src/original.ts' },
    { change: 'add', path: '/workspace/src/renamed.ts' },
  ]);
  const webSearch = events.find(
    (event): event is Extract<ProviderEvent, { type: 'tool.call' }> =>
      event.type === 'tool.call' && event.toolName === 'webSearch',
  );
  assert.deepEqual(webSearch?.input, {
    action: { query: 'Codex app-server protocol', type: 'search' },
    query: 'Codex app-server protocol',
  });
}

test('rejects every server request that no session handles', () => {
  const errors: Array<{
    error: { code: number; message: string };
    id: number | string;
  }> = [];
  const methods = [
    'item/permissions/requestApproval',
    'item/tool/requestUserInput',
    'mcpServer/elicitation/request',
    'currentTime/read',
  ];

  methods.forEach((method, index) => {
    dispatchCodexServerMessage(
      { id: index + 1, method, params: {} },
      new Set(),
      (id, error) => errors.push({ error, id }),
    );
  });

  assert.deepEqual(
    errors.map(({ error, id }) => ({ code: error.code, id })),
    methods.map((_, index) => ({ code: -32601, id: index + 1 })),
  );

  dispatchCodexServerMessage(
    { id: 'request-error', method: 'item/tool/requestUserInput', params: {} },
    new Set([
      () => {
        throw new Error('handler failed');
      },
    ]),
    (id, error) => errors.push({ error, id }),
  );
  assert.deepEqual(errors.at(-1), {
    error: {
      code: -32603,
      message: 'Codex server request handler failed: handler failed',
    },
    id: 'request-error',
  });
});

test('uses thread resume and sends a typed turn interrupt', async () => {
  const client = new FakeCodexClient();
  const provider = new CodexProvider({ clientFactory: async () => client });
  const session = await provider.createSession({
    cwd: '/workspace',
    profile: { id: 'default' },
    resumeSessionId: 'codex-thread',
  });
  const iterator = session
    .send({ actor: 'human', content: 'Continue.', runId: 'run-2' })
    [Symbol.asyncIterator]();

  await iterator.next();
  await session.interrupt();
  const remaining = [];
  for (
    let next = await iterator.next();
    !next.done;
    next = await iterator.next()
  ) {
    remaining.push(next.value);
  }

  assert.equal(client.requests[0]?.method, 'thread/resume');
  assert.equal(
    client.requests.some(
      (item) =>
        item.method === 'turn/interrupt' &&
        item.params.threadId === 'codex-thread' &&
        item.params.turnId === 'codex-turn',
    ),
    true,
    JSON.stringify(client.requests),
  );
  assert.equal(
    client.responses.some(
      (response) =>
        response.id === 77 &&
        typeof response.result === 'object' &&
        response.result !== null &&
        'decision' in response.result &&
        response.result.decision === 'cancel',
    ),
    true,
  );
  assert.equal(
    remaining.some(
      (event) =>
        event.type === 'turn.completed' && event.outcome === 'interrupted',
    ),
    true,
  );
});

test('closes a pending approval when the Codex transport fails', async () => {
  const client = new FakeCodexClient();
  const provider = new CodexProvider({ clientFactory: async () => client });
  const session = await provider.createSession({
    cwd: '/workspace',
    profile: { id: 'default' },
  });
  const iterator = session
    .send({ actor: 'human', content: 'Run tests.', runId: 'run-failure' })
    [Symbol.asyncIterator]();
  const events = [];
  for (
    let next = await iterator.next();
    !next.done;
    next = await iterator.next()
  ) {
    events.push(next.value);
    if (next.value.type === 'approval.requested') {
      client.fail(new Error('connection lost'));
    }
  }

  assert.equal(
    events.some(
      (event) => event.type === 'approval.resolved' && event.actor === 'policy',
    ),
    true,
  );
  assert.equal(
    events.some(
      (event) => event.type === 'turn.completed' && event.outcome === 'failed',
    ),
    true,
  );
});

test('rejects a concurrent run in the same Codex session', async () => {
  const client = new FakeCodexClient();
  const provider = new CodexProvider({ clientFactory: async () => client });
  const session = await provider.createSession({
    cwd: '/workspace',
    profile: { id: 'default' },
  });
  const first = session
    .send({ actor: 'human', content: 'First.', runId: 'run-first' })
    [Symbol.asyncIterator]();
  const second = session
    .send({ actor: 'human', content: 'Second.', runId: 'run-second' })
    [Symbol.asyncIterator]();

  await first.next();
  await assert.rejects(second.next(), /already has an active run/);
  await session.interrupt();
  for (let next = await first.next(); !next.done; next = await first.next()) {
    // Drain the interrupted run.
  }
});
