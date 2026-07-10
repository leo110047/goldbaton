import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  HookInput,
  PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';
import type { ProviderEvent } from '../../provider/types.js';
import type {
  ClaudeQueryFactory,
  ClaudeQueryHandle,
  ClaudeQueryRequest,
} from './provider.js';
import { ClaudeProvider } from './provider.js';

class FakeClaudeQuery implements ClaudeQueryHandle {
  closed = false;
  interrupted = false;

  constructor(
    private readonly messages: () => AsyncGenerator<unknown>,
    private readonly onInterrupt: () => void = () => undefined,
  ) {}

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this.messages();
  }

  close(): void {
    this.closed = true;
  }

  async interrupt(): Promise<unknown> {
    this.interrupted = true;
    this.onInterrupt();
    return undefined;
  }
}

function initMessage(sessionId = 'claude-session'): Record<string, unknown> {
  return {
    claude_code_version: '2.1.206',
    session_id: sessionId,
    subtype: 'init',
    type: 'system',
  };
}

function resultMessage(sessionId = 'claude-session'): Record<string, unknown> {
  return {
    duration_ms: 25,
    is_error: false,
    session_id: sessionId,
    subtype: 'success',
    total_cost_usd: 0.012,
    type: 'result',
    usage: {
      cache_creation_input_tokens: 4,
      cache_read_input_tokens: 3,
      input_tokens: 10,
      output_tokens: 5,
    },
  };
}

async function* approvalMessages(
  request: ClaudeQueryRequest,
  capture: (result: PermissionResult | null) => void,
): AsyncGenerator<unknown> {
  yield initMessage();
  yield {
    event: {
      delta: { text: 'Hello', type: 'text_delta' },
      type: 'content_block_delta',
    },
    session_id: 'claude-session',
    type: 'stream_event',
  };
  yield {
    message: {
      content: [
        {
          id: 'tool-1',
          input: { command: 'npm test' },
          name: 'Bash',
          type: 'tool_use',
        },
      ],
    },
    session_id: 'claude-session',
    type: 'assistant',
  };
  const canUseTool = request.options.canUseTool;
  assert.ok(canUseTool);
  capture(
    await canUseTool(
      'Bash',
      { command: 'npm test' },
      {
        requestId: 'request-1',
        signal: new AbortController().signal,
        suggestions: [],
        toolUseID: 'tool-1',
      },
    ),
  );
  await runHook(request, 'PostToolUse', completedToolHook());
  await runHook(request, 'PostToolUse', completedWriteHook());
  await runHook(request, 'PostToolUseFailure', failedEditHook());
  await runHook(request, 'PostToolUse', completedNotebookEditHook());
  yield resultMessage();
}

function completedToolHook(): HookInput {
  return {
    cwd: '/workspace',
    hook_event_name: 'PostToolUse',
    session_id: 'claude-session',
    tool_input: { command: 'npm test' },
    tool_name: 'Bash',
    tool_response: { output: 'ok' },
    tool_use_id: 'tool-1',
    transcript_path: '/tmp/transcript',
  };
}

function completedWriteHook(): HookInput {
  return {
    cwd: '/workspace',
    hook_event_name: 'PostToolUse',
    session_id: 'claude-session',
    tool_input: {
      content: 'export const ready = true;\n',
      file_path: '/workspace/src/ready.ts',
    },
    tool_name: 'Write',
    tool_response: {
      gitDiff: { patch: '@@ -0,0 +1 @@\n+ready' },
      type: 'create',
    },
    tool_use_id: 'tool-write',
    transcript_path: '/tmp/transcript',
  };
}

function failedEditHook(): HookInput {
  return {
    cwd: '/workspace',
    error: 'old string was not found',
    hook_event_name: 'PostToolUseFailure',
    session_id: 'claude-session',
    tool_input: {
      file_path: '/workspace/src/existing.ts',
      new_string: 'new',
      old_string: 'old',
    },
    tool_name: 'Edit',
    tool_use_id: 'tool-edit',
    transcript_path: '/tmp/transcript',
  };
}

function completedNotebookEditHook(): HookInput {
  return {
    cwd: '/workspace',
    hook_event_name: 'PostToolUse',
    session_id: 'claude-session',
    tool_input: {
      edit_mode: 'replace',
      new_source: 'print("ready")',
      notebook_path: '/workspace/notebook.ipynb',
    },
    tool_name: 'NotebookEdit',
    tool_response: { edit_mode: 'replace' },
    tool_use_id: 'tool-notebook',
    transcript_path: '/tmp/transcript',
  };
}

async function runHook(
  request: ClaudeQueryRequest,
  name: 'PostToolUse' | 'PostToolUseFailure',
  input: HookInput,
): Promise<void> {
  const hook = request.options.hooks?.[name]?.[0]?.hooks[0];
  assert.ok(hook, `${name} hook was not installed`);
  const toolUseId = 'tool_use_id' in input ? input.tool_use_id : undefined;
  await hook(input, toolUseId, {
    signal: new AbortController().signal,
  });
}

test('declares capabilities from the verified Claude SDK surface', () => {
  const provider = new ClaudeProvider();

  assert.deepEqual(provider.capabilities(), {
    approvals: true,
    costReporting: true,
    interrupt: true,
    sessions: true,
    streaming: true,
    toolUse: true,
  });
});

test('translates streaming, approval, tools, files, usage, and actor data', async () => {
  let capturedRequest: ClaudeQueryRequest | undefined;
  let permissionResult: PermissionResult | null | undefined;
  let fakeQuery: FakeClaudeQuery | undefined;
  const queryFactory: ClaudeQueryFactory = (request) => {
    capturedRequest = request;
    fakeQuery = new FakeClaudeQuery(() =>
      approvalMessages(request, (result) => {
        permissionResult = result;
      }),
    );
    return fakeQuery;
  };
  const provider = new ClaudeProvider({
    createId: () => 'local-session',
    queryFactory,
  });
  const session = await provider.createSession({
    cwd: '/workspace',
    profile: { id: 'default', model: 'claude-test' },
  });

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

  assertClaudeOptions(capturedRequest);
  assert.deepEqual(permissionResult, {
    behavior: 'allow',
    updatedInput: { command: 'npm test' },
  });
  assert.equal(session.providerSessionId, 'claude-session');
  assert.equal(fakeQuery?.closed, true);
  assertTranslatedEvents(events);
});

function assertClaudeOptions(request: ClaudeQueryRequest | undefined): void {
  assert.equal(request?.options.cwd, '/workspace');
  assert.equal(request?.options.model, 'claude-test');
  assert.equal(request?.options.permissionMode, 'default');
  assert.equal(request?.options.persistSession, true);
  assert.equal(request?.options.includePartialMessages, true);
  assert.equal(request?.options.settingSources, undefined);
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
      'tool.call',
      'file.change',
      'tool.call',
      'file.change',
      'tool.call',
      'file.change',
      'turn.completed',
    ],
  );
  const approval = events.find((event) => event.type === 'approval.requested');
  assert.equal(approval?.risk, 'execute');
  const resolution = events.find((event) => event.type === 'approval.resolved');
  assert.equal(resolution?.actor, 'human');
  assertFileChanges(events);
  const completion = events.find((event) => event.type === 'turn.completed');
  assert.equal(completion?.costUsd, 0.012);
  assert.deepEqual(completion?.usage, {
    cachedInputTokens: 7,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 22,
  });
}

function assertFileChanges(events: ProviderEvent[]): void {
  const files = events.filter((event) => event.type === 'file.change');
  assert.deepEqual(
    files.map((event) => ({
      change: event.change,
      diff: event.diff,
      path: event.path,
      status: event.status,
      toolCallId: event.toolCallId,
    })),
    [
      {
        change: 'add',
        diff: '@@ -0,0 +1 @@\n+ready',
        path: '/workspace/src/ready.ts',
        status: 'applied',
        toolCallId: 'tool-write',
      },
      {
        change: 'update',
        diff: undefined,
        path: '/workspace/src/existing.ts',
        status: 'failed',
        toolCallId: 'tool-edit',
      },
      {
        change: 'update',
        diff: undefined,
        path: '/workspace/notebook.ipynb',
        status: 'applied',
        toolCallId: 'tool-notebook',
      },
    ],
  );
}

test('resumes provider sessions and interrupts an active turn', async () => {
  let capturedRequest: ClaudeQueryRequest | undefined;
  let fakeQuery: FakeClaudeQuery | undefined;
  let release: () => void = () => undefined;
  const queryFactory: ClaudeQueryFactory = (request) => {
    capturedRequest = request;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    fakeQuery = new FakeClaudeQuery(async function* () {
      yield initMessage('existing-session');
      await blocked;
      yield resultMessage('existing-session');
    }, release);
    return fakeQuery;
  };
  const provider = new ClaudeProvider({ queryFactory });
  const session = await provider.createSession({
    cwd: '/workspace',
    profile: { id: 'default' },
    resumeSessionId: 'existing-session',
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

  assert.equal(capturedRequest?.options.resume, 'existing-session');
  assert.equal(fakeQuery?.interrupted, true);
  assert.equal(
    remaining.some(
      (event) =>
        event.type === 'turn.completed' && event.outcome === 'interrupted',
    ),
    true,
  );
});

test('fails explicitly when the Claude SDK ends without a result', async () => {
  const provider = new ClaudeProvider({
    queryFactory: () =>
      new FakeClaudeQuery(async function* () {
        yield initMessage();
      }),
  });
  const session = await provider.createSession({
    cwd: '/workspace',
    profile: { id: 'default' },
  });

  const events = [];
  for await (const event of session.send({
    actor: 'human',
    content: 'Hello.',
    runId: 'run-missing-result',
  })) {
    events.push(event);
  }

  assert.equal(
    events.some(
      (event) =>
        event.type === 'error' &&
        event.message.includes('without a terminal result'),
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

test('marks a turn failed after a terminal Claude assistant error', async () => {
  const provider = new ClaudeProvider({
    queryFactory: () =>
      new FakeClaudeQuery(async function* () {
        yield initMessage();
        yield {
          error: 'rate_limit',
          message: { content: [] },
          session_id: 'claude-session',
          type: 'assistant',
        };
        yield resultMessage();
      }),
  });
  const session = await provider.createSession({
    cwd: '/workspace',
    profile: { id: 'default' },
  });

  const events = [];
  for await (const event of session.send({
    actor: 'human',
    content: 'Hello.',
    runId: 'run-rate-limit',
  })) {
    events.push(event);
  }

  const error = events.find((event) => event.type === 'error');
  assert.equal(error?.code, 'rate_limit');
  assert.equal(error?.retryable, true);
  assert.equal(
    events.some(
      (event) => event.type === 'turn.completed' && event.outcome === 'failed',
    ),
    true,
  );
});

test('cancels a pending approval when the SDK aborts its signal', async () => {
  let permissionResult: PermissionResult | null | undefined;
  const provider = new ClaudeProvider({
    queryFactory: (request) =>
      new FakeClaudeQuery(async function* () {
        yield initMessage();
        const controller = new AbortController();
        const canUseTool = request.options.canUseTool;
        assert.ok(canUseTool);
        const pending = canUseTool(
          'Bash',
          { command: 'npm test' },
          {
            requestId: 'request-abort',
            signal: controller.signal,
            toolUseID: 'tool-abort',
          },
        );
        queueMicrotask(() => controller.abort());
        permissionResult = await pending;
        yield resultMessage();
      }),
  });
  const session = await provider.createSession({
    cwd: '/workspace',
    profile: { id: 'default' },
  });
  const fallback = setTimeout(() => session.close(), 50);
  const events = [];
  for await (const event of session.send({
    actor: 'human',
    content: 'Run the tests.',
    runId: 'run-aborted-approval',
  })) {
    events.push(event);
  }
  clearTimeout(fallback);

  assert.equal(permissionResult?.behavior, 'deny');
  const resolution = events.find((event) => event.type === 'approval.resolved');
  assert.equal(resolution?.actor, 'policy');
  assert.equal(resolution?.decision, 'cancel');
  assert.match(resolution?.reason ?? '', /SDK aborted/);
});

test('rejects a concurrent run in the same Claude session', async () => {
  let release: () => void = () => undefined;
  const provider = new ClaudeProvider({
    queryFactory: () => {
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      return new FakeClaudeQuery(async function* () {
        yield initMessage();
        await blocked;
        yield resultMessage();
      }, release);
    },
  });
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
