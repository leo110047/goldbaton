import { randomUUID } from 'node:crypto';
import {
  type Options,
  query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  CreateSessionRequest,
  Provider,
  ProviderCapabilities,
  ProviderSession,
} from '../../provider/types.js';
import { ClaudeSession } from './session.js';

export interface ClaudeQueryHandle extends AsyncIterable<unknown> {
  close(): void;
  interrupt(): Promise<unknown>;
}

export interface ClaudeQueryRequest {
  options: Options;
  prompt: AsyncIterable<SDKUserMessage>;
}

export type ClaudeQueryFactory = (
  request: ClaudeQueryRequest,
) => ClaudeQueryHandle;

export interface ClaudeProviderOptions {
  createId?: () => string;
  queryFactory?: ClaudeQueryFactory;
}

const CAPABILITIES: ProviderCapabilities = {
  approvals: true,
  costReporting: true,
  interrupt: true,
  sessions: true,
  streaming: true,
  toolUse: true,
};

function defaultQueryFactory(request: ClaudeQueryRequest): ClaudeQueryHandle {
  return query(request);
}

export class ClaudeProvider implements Provider {
  readonly id = 'claude';
  private readonly createId: () => string;
  private readonly queryFactory: ClaudeQueryFactory;
  private readonly sessions = new Set<ClaudeSession>();

  constructor(options: ClaudeProviderOptions = {}) {
    this.createId = options.createId ?? randomUUID;
    this.queryFactory = options.queryFactory ?? defaultQueryFactory;
  }

  capabilities(): ProviderCapabilities {
    return { ...CAPABILITIES };
  }

  async createSession(request: CreateSessionRequest): Promise<ProviderSession> {
    if (request.cwd.length === 0)
      throw new Error('Claude session cwd is required');
    if (request.profile.id.length === 0) {
      throw new Error('Claude session profile id is required');
    }
    let session: ClaudeSession;
    session = new ClaudeSession(
      this.createId(),
      request,
      this.queryFactory,
      () => this.sessions.delete(session),
    );
    this.sessions.add(session);
    return session;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sessions].map((session) => session.close()));
  }
}
