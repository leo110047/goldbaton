import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createCodexCommand } from '../../scripts/codex-command.mjs';
import type { ClientNotification } from './generated/ClientNotification.js';
import type { ClientRequest } from './generated/ClientRequest.js';
import type { CommandExecutionRequestApprovalResponse } from './generated/v2/CommandExecutionRequestApprovalResponse.js';
import { MessageBus, type Predicate, type WireMessage } from './message-bus.js';

function isRecord(value: unknown): value is WireMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMessage(line: string): WireMessage {
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed)) {
    throw new Error('app-server emitted a non-object JSON message');
  }
  return parsed;
}

function requireRecord(value: unknown, label: string): WireMessage {
  if (!isRecord(value)) {
    throw new Error(`${label} was not an object`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} was not a non-empty string`);
  }
  return value;
}

function runtimeName(): string {
  return process.versions.bun
    ? `bun ${process.versions.bun}`
    : `node ${process.version}`;
}

function send(
  child: ChildProcessWithoutNullStreams,
  message: ClientRequest | ClientNotification | WireMessage,
): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function responseWithId(id: number): Predicate {
  return (message) => message.id === id;
}

function methodIs(method: string): Predicate {
  return (message) => message.method === method;
}

function resolutionFor(request: WireMessage): Predicate {
  const requestId = request.id;
  if (typeof requestId !== 'number' && typeof requestId !== 'string') {
    throw new Error('approval request did not include a request id');
  }
  return (message) => {
    if (message.method !== 'serverRequest/resolved') {
      return false;
    }
    return isRecord(message.params) && message.params.requestId === requestId;
  };
}

function traceMessage(message: WireMessage): void {
  if (process.env.GOLDBATON_SPIKE_DEBUG !== '1') {
    return;
  }
  const name = typeof message.method === 'string' ? message.method : 'response';
  const id =
    typeof message.id === 'string' || typeof message.id === 'number'
      ? ` id=${message.id}`
      : '';
  process.stderr.write(`[codex app-server] ${name}${id}\n`);
}

function extractResult(message: WireMessage, label: string): WireMessage {
  if (message.error) {
    throw new Error(`${label} failed: ${JSON.stringify(message.error)}`);
  }
  return requireRecord(message.result, `${label} result`);
}

function respondToApproval(
  child: ChildProcessWithoutNullStreams,
  message: WireMessage,
): boolean {
  if (message.method !== 'item/commandExecution/requestApproval') {
    return false;
  }
  if (typeof message.id !== 'number' && typeof message.id !== 'string') {
    throw new Error('approval request did not include a request id');
  }
  const result = {
    decision: 'decline',
  } satisfies CommandExecutionRequestApprovalResponse;
  send(child, { id: message.id, result });
  return true;
}

function startAppServer(bus: MessageBus): {
  child: ChildProcessWithoutNullStreams;
  getApprovalReplies: () => number;
} {
  const launch = createCodexCommand(['app-server', '--stdio']);
  const child = spawn(launch.command, launch.args, {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let approvalReplies = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try {
      const message = parseMessage(line);
      traceMessage(message);
      bus.push(message);
      if (respondToApproval(child, message)) {
        approvalReplies += 1;
      }
    } catch (error) {
      bus.fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
  child.once('error', (error) => bus.fail(error));
  child.once('exit', (code, signal) => {
    const reason = signal ? `signal ${signal}` : `status ${code ?? 'unknown'}`;
    bus.fail(new Error(`Codex app-server exited with ${reason}`));
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  return { child, getApprovalReplies: () => approvalReplies };
}

async function initialize(
  child: ChildProcessWithoutNullStreams,
  bus: MessageBus,
): Promise<void> {
  const request = {
    id: 1,
    method: 'initialize',
    params: {
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
      clientInfo: { name: 'goldbaton', title: 'goldbaton', version: '0.0.0' },
    },
  } satisfies ClientRequest;
  send(child, request);
  extractResult(
    await bus.waitFor(responseWithId(1), 'initialize'),
    'initialize',
  );
  send(child, { method: 'initialized' } satisfies ClientNotification);
}

async function startThread(
  child: ChildProcessWithoutNullStreams,
  bus: MessageBus,
): Promise<{ cliVersion: string; threadId: string }> {
  const request = {
    id: 2,
    method: 'thread/start',
    params: {
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      cwd: process.cwd(),
      ephemeral: true,
      sandbox: 'read-only',
    },
  } satisfies ClientRequest;
  send(child, request);
  const result = extractResult(
    await bus.waitFor(responseWithId(2), 'thread/start'),
    'thread/start',
  );
  const thread = requireRecord(result.thread, 'thread/start thread');
  return {
    cliVersion: requireString(thread.cliVersion, 'thread.cliVersion'),
    threadId: requireString(thread.id, 'thread.id'),
  };
}

async function startTurn(
  child: ChildProcessWithoutNullStreams,
  bus: MessageBus,
  threadId: string,
  markerCommand: string,
): Promise<string> {
  const request = {
    id: 3,
    method: 'turn/start',
    params: {
      input: [
        {
          text: `First output exactly STREAM_READY. Then use the shell to run this exact command: ${markerCommand}. Do not use another tool.`,
          text_elements: [],
          type: 'text',
        },
      ],
      threadId,
    },
  } satisfies ClientRequest;
  send(child, request);
  const result = extractResult(
    await bus.waitFor(responseWithId(3), 'turn/start'),
    'turn/start',
  );
  const turn = requireRecord(result.turn, 'turn/start turn');
  return requireString(turn.id, 'turn.id');
}

async function run(): Promise<void> {
  const bus = new MessageBus();
  const server = startAppServer(bus);
  const markerName = `goldbaton-codex-spike-${process.pid}`;
  const markerPath = resolve(tmpdir(), markerName);
  const markerCommand = `node -e "require('fs').writeFileSync(require('path').join(require('os').tmpdir(), '${markerName}'), '')"`;
  try {
    await initialize(server.child, bus);
    const thread = await startThread(server.child, bus);
    const turnId = await startTurn(
      server.child,
      bus,
      thread.threadId,
      markerCommand,
    );
    const approval = bus.waitFor(
      methodIs('item/commandExecution/requestApproval'),
      'command approval request',
    );
    const approvalResolved = approval.then((request) =>
      bus.waitFor(resolutionFor(request), 'command approval resolution'),
    );
    const [delta, , , completed] = await Promise.all([
      bus.waitFor(methodIs('item/agentMessage/delta'), 'streamed agent text'),
      approval,
      approvalResolved,
      bus.waitFor(methodIs('turn/completed'), 'turn completion'),
    ]);
    const params = requireRecord(completed.params, 'turn/completed params');
    const turn = requireRecord(params.turn, 'turn/completed turn');
    const deltaParams = requireRecord(delta.params, 'agent delta params');
    if (server.getApprovalReplies() < 1) {
      throw new Error('approval request was observed but not answered');
    }
    if (existsSync(markerPath)) {
      throw new Error('declined Codex command still created its marker file');
    }
    process.stdout.write(
      `${JSON.stringify({
        approvalReplies: server.getApprovalReplies(),
        approvalResolved: true,
        cliVersion: thread.cliVersion,
        provider: 'codex',
        runtime: runtimeName(),
        streamedText: requireString(deltaParams.delta, 'agent delta'),
        turnId,
        turnStatus: requireString(turn.status, 'turn status'),
      })}\n`,
    );
  } finally {
    rmSync(markerPath, { force: true });
    server.child.stdin.end();
    server.child.kill();
  }
}

run().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
