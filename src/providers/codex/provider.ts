import { randomUUID } from 'node:crypto';
import type {
  CreateSessionRequest,
  Provider,
  ProviderCapabilities,
  ProviderSession,
} from '../../provider/types.js';
import { isRecord, recordField, stringField } from '../../provider/wire.js';
import { type CodexAppServerClient, StdioCodexClient } from './client.js';
import { CodexSession } from './session.js';

export type CodexClientFactory = () => Promise<CodexAppServerClient>;

export interface CodexProviderOptions {
  clientFactory?: CodexClientFactory;
  createId?: () => string;
}

const CAPABILITIES: ProviderCapabilities = {
  approvals: true,
  costReporting: false,
  interrupt: true,
  sessions: true,
  streaming: true,
  toolUse: true,
};

// Temporary until provider-neutral permission profiles map native policies.
const BASELINE_THREAD_POLICY = {
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user',
  sandbox: 'read-only',
} as const;

export class CodexProvider implements Provider {
  readonly id = 'codex';
  private readonly clientFactory: CodexClientFactory;
  private clientPromise: Promise<CodexAppServerClient> | undefined;
  private readonly createId: () => string;
  private readonly sessions = new Set<CodexSession>();

  constructor(options: CodexProviderOptions = {}) {
    this.clientFactory = options.clientFactory ?? StdioCodexClient.connect;
    this.createId = options.createId ?? randomUUID;
  }

  capabilities(): ProviderCapabilities {
    return { ...CAPABILITIES };
  }

  private client(): Promise<CodexAppServerClient> {
    this.clientPromise ??= this.clientFactory();
    return this.clientPromise;
  }

  async createSession(request: CreateSessionRequest): Promise<ProviderSession> {
    if (request.cwd.length === 0)
      throw new Error('Codex session cwd is required');
    if (request.profile.id.length === 0) {
      throw new Error('Codex session profile id is required');
    }
    const client = await this.client();
    const result = request.resumeSessionId
      ? await this.resumeThread(client, request)
      : await this.startThread(client, request);
    const thread = isRecord(result) ? recordField(result, 'thread') : undefined;
    const threadId = thread ? stringField(thread, 'id') : undefined;
    if (!threadId) throw new Error('Codex session did not return a thread id');
    let session: CodexSession;
    session = new CodexSession({
      client,
      id: this.createId(),
      onClose: () => this.sessions.delete(session),
      providerSessionId: threadId,
      request,
    });
    this.sessions.add(session);
    return session;
  }

  private startThread(
    client: CodexAppServerClient,
    request: CreateSessionRequest,
  ): Promise<unknown> {
    return client.request('thread/start', {
      ...(request.profile.model ? { model: request.profile.model } : {}),
      ...BASELINE_THREAD_POLICY,
      cwd: request.cwd,
      ephemeral: false,
    });
  }

  private resumeThread(
    client: CodexAppServerClient,
    request: CreateSessionRequest,
  ): Promise<unknown> {
    return client.request('thread/resume', {
      ...(request.profile.model ? { model: request.profile.model } : {}),
      ...BASELINE_THREAD_POLICY,
      cwd: request.cwd,
      excludeTurns: true,
      threadId: request.resumeSessionId,
    });
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sessions].map((session) => session.close()));
    const client = await this.clientPromise;
    await client?.close();
  }
}
