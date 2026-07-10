import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isRecord } from '../../provider/wire.js';
import { createCodexCommand } from './command.js';

export type CodexWireMessage = Record<string, unknown>;
export type CodexMessageListener = (message: CodexWireMessage) => boolean;

export interface CodexServerError {
  code: number;
  message: string;
}

type RejectServerRequest = (
  id: number | string,
  error: CodexServerError,
) => void;

type ListenerDispatch =
  | { error: unknown; ok: false }
  | { handled: boolean; ok: true };

export interface CodexAppServerClient {
  close(): Promise<void>;
  onError(listener: (error: Error) => void): () => void;
  request(method: string, params: CodexWireMessage): Promise<unknown>;
  respond(id: number | string, result: unknown): void;
  subscribe(listener: CodexMessageListener): () => void;
}

interface PendingRequest {
  method: string;
  reject: (error: Error) => void;
  resolve: (result: unknown) => void;
}

function parseMessage(line: string): CodexWireMessage {
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed)) {
    throw new Error('Codex app-server emitted a non-object JSON message');
  }
  return parsed;
}

function responseId(message: CodexWireMessage): number | undefined {
  return typeof message.id === 'number' && !('method' in message)
    ? message.id
    : undefined;
}

function serverRequestId(
  message: CodexWireMessage,
): number | string | undefined {
  const id = message.id;
  return typeof message.method === 'string' &&
    (typeof id === 'number' || typeof id === 'string')
    ? id
    : undefined;
}

function notifyListeners(
  message: CodexWireMessage,
  listeners: Iterable<CodexMessageListener>,
): ListenerDispatch {
  let handled = false;
  try {
    for (const listener of listeners) {
      if (listener(message)) handled = true;
    }
    return { handled, ok: true };
  } catch (error) {
    return { error, ok: false };
  }
}

export function dispatchCodexServerMessage(
  message: CodexWireMessage,
  listeners: Iterable<CodexMessageListener>,
  rejectRequest: RejectServerRequest,
): void {
  const id = serverRequestId(message);
  const dispatch = notifyListeners(message, listeners);
  if (!dispatch.ok) {
    if (id === undefined) throw dispatch.error;
    const detail =
      dispatch.error instanceof Error
        ? dispatch.error.message
        : String(dispatch.error);
    rejectRequest(id, {
      code: -32603,
      message: `Codex server request handler failed: ${detail}`,
    });
    return;
  }
  if (id === undefined || dispatch.handled) return;
  rejectRequest(id, {
    code: -32601,
    message: `Unsupported Codex server request: ${String(message.method)}`,
  });
}

export class StdioCodexClient implements CodexAppServerClient {
  private closing = false;
  private failure: Error | undefined;
  private nextRequestId = 1;
  private readonly errors = new Set<(error: Error) => void>();
  private readonly listeners = new Set<CodexMessageListener>();
  private readonly pending = new Map<number, PendingRequest>();

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.once('error', (error) => this.fail(error));
    child.once('exit', (code, signal) => this.handleExit(code, signal));
  }

  static async connect(): Promise<StdioCodexClient> {
    const launch = createCodexCommand(['app-server', '--stdio']);
    const child = spawn(launch.command, launch.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const client = new StdioCodexClient(child);
    try {
      await client.request('initialize', {
        capabilities: { experimentalApi: false, requestAttestation: false },
        clientInfo: { name: 'goldbaton', title: 'goldbaton', version: '0.0.0' },
      });
      client.write({ method: 'initialized' });
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  request(method: string, params: CodexWireMessage): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, reject, resolve });
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  respond(id: number | string, result: unknown): void {
    this.write({ id, result });
  }

  subscribe(listener: CodexMessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errors.add(listener);
    return () => this.errors.delete(listener);
  }

  private write(message: CodexWireMessage): void {
    if (this.closing || this.failure || !this.child.stdin.writable) {
      throw new Error('Codex app-server transport is closed');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    try {
      const message = parseMessage(line);
      const id = responseId(message);
      if (id === undefined) {
        dispatchCodexServerMessage(
          message,
          this.listeners,
          (requestId, error) => this.write({ error, id: requestId }),
        );
        return;
      }
      this.resolveResponse(id, message);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private resolveResponse(id: number, message: CodexWireMessage): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (message.error !== undefined) {
      pending.reject(
        new Error(
          `Codex ${pending.method} failed: ${JSON.stringify(message.error)}`,
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closing) return;
    const reason = signal ? `signal ${signal}` : `status ${code ?? 'unknown'}`;
    this.fail(new Error(`Codex app-server exited with ${reason}`));
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    for (const listener of this.errors) listener(error);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.child.stdin.end();
    this.child.kill();
    this.fail(new Error('Codex app-server transport closed'));
  }
}
