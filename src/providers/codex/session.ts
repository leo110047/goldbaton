import { AsyncQueue } from '../../provider/async-queue.js';
import { ProviderEventFactory } from '../../provider/event-factory.js';
import { toJsonValue } from '../../provider/json.js';
import type {
  ApprovalDecision,
  ApprovalResponse,
  CreateSessionRequest,
  ProviderEvent,
  ProviderSession,
  SendMessageRequest,
  TokenUsage,
} from '../../provider/types.js';
import { isRecord, recordField, stringField } from '../../provider/wire.js';
import type { CodexAppServerClient, CodexWireMessage } from './client.js';
import { translateCodexMessage } from './translation.js';

interface PendingCodexApproval {
  kind: 'command' | 'file';
  rpcId: number | string;
}

interface CodexRun {
  approvals: Map<string, PendingCodexApproval>;
  factory: ProviderEventFactory;
  interrupted: boolean;
  queue: AsyncQueue<ProviderEvent>;
  started?: Promise<void>;
  terminal: boolean;
  turnId?: string;
  unsubscribeError: () => void;
  unsubscribeMessage: () => void;
  usage?: TokenUsage;
}

export interface CodexSessionOptions {
  client: CodexAppServerClient;
  id: string;
  onClose: () => void;
  providerSessionId: string;
  request: CreateSessionRequest;
}

function rawDecision(
  decision: ApprovalDecision,
): 'accept' | 'acceptForSession' | 'cancel' | 'decline' {
  if (decision === 'approve') return 'accept';
  if (decision === 'approve-session') return 'acceptForSession';
  if (decision === 'cancel') return 'cancel';
  return 'decline';
}

function providerDecision(value: unknown): ApprovalDecision | undefined {
  if (value === 'accept') return 'approve';
  if (value === 'acceptForSession') return 'approve-session';
  if (value === 'decline') return 'deny';
  if (value === 'cancel') return 'cancel';
  return undefined;
}

function allowedDecisions(params: Record<string, unknown>): ApprovalDecision[] {
  if (!Array.isArray(params.availableDecisions)) {
    return ['approve', 'approve-session', 'deny', 'cancel'];
  }
  return params.availableDecisions
    .map(providerDecision)
    .filter((value): value is ApprovalDecision => value !== undefined);
}

export class CodexSession implements ProviderSession {
  private active: CodexRun | undefined;
  private closed = false;
  private readonly client: CodexAppServerClient;
  readonly id: string;
  private readonly onClose: () => void;
  readonly providerSessionId: string;
  private readonly request: CreateSessionRequest;

  constructor(options: CodexSessionOptions) {
    this.client = options.client;
    this.id = options.id;
    this.onClose = options.onClose;
    this.providerSessionId = options.providerSessionId;
    this.request = options.request;
  }

  send(message: SendMessageRequest): AsyncIterable<ProviderEvent> {
    return this.stream(message);
  }

  private async *stream(
    message: SendMessageRequest,
  ): AsyncGenerator<ProviderEvent> {
    const run = this.startRun(message);
    run.started = this.startTurn(run, message);
    try {
      for await (const event of run.queue) yield event;
    } finally {
      if (!run.terminal) await this.stopRun(run);
      if (this.active === run) this.active = undefined;
    }
  }

  private startRun(message: SendMessageRequest): CodexRun {
    if (this.closed) throw new Error('Codex session is closed');
    if (this.active) throw new Error('Codex session already has an active run');
    const factory = new ProviderEventFactory({
      provider: 'codex',
      providerSessionId: this.providerSessionId,
      runId: message.runId,
      sessionId: this.id,
    });
    const run: CodexRun = {
      approvals: new Map(),
      factory,
      interrupted: false,
      queue: new AsyncQueue(),
      terminal: false,
      unsubscribeError: () => undefined,
      unsubscribeMessage: () => undefined,
    };
    run.unsubscribeMessage = this.client.subscribe((value) =>
      this.handleMessage(run, value),
    );
    run.unsubscribeError = this.client.onError((error) =>
      this.failRun(run, error),
    );
    this.active = run;
    run.queue.push(
      factory.create({
        actor: message.actor,
        profileId: this.request.profile.id,
        type: 'run.started',
      }),
    );
    run.queue.push(
      factory.create({
        actor: message.actor,
        content: message.content,
        type: 'message.input',
      }),
    );
    return run;
  }

  private async startTurn(
    run: CodexRun,
    message: SendMessageRequest,
  ): Promise<void> {
    try {
      const result = await this.client.request('turn/start', {
        clientUserMessageId: message.runId,
        input: [{ text: message.content, text_elements: [], type: 'text' }],
        threadId: this.providerSessionId,
      });
      const response = isRecord(result)
        ? recordField(result, 'turn')
        : undefined;
      const turnId = response ? stringField(response, 'id') : undefined;
      if (!turnId) throw new Error('Codex turn/start did not return a turn id');
      run.turnId = turnId;
    } catch (error) {
      this.failRun(
        run,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private handleMessage(run: CodexRun, message: CodexWireMessage): boolean {
    const params = recordField(message, 'params');
    if (!params || stringField(params, 'threadId') !== this.providerSessionId) {
      return false;
    }
    const messageTurnId =
      stringField(params, 'turnId') ??
      stringField(recordField(params, 'turn') ?? {}, 'id');
    if (run.turnId && messageTurnId && messageTurnId !== run.turnId) {
      return false;
    }
    return translateCodexMessage(message, {
      complete: (outcome, durationMs) =>
        this.completeRun(run, outcome, durationMs),
      emit: (event) => run.queue.push(event),
      factory: run.factory,
      requestApproval: (value) => this.registerApproval(run, value),
      setUsage: (usage) => {
        run.usage = usage;
      },
    });
  }

  private registerApproval(run: CodexRun, message: CodexWireMessage): void {
    const method = stringField(message, 'method');
    const params = recordField(message, 'params');
    const rpcId = message.id;
    if (
      !method ||
      !params ||
      (typeof rpcId !== 'number' && typeof rpcId !== 'string')
    ) {
      throw new Error(
        'Codex approval request was missing method, params, or id',
      );
    }
    const kind = method.includes('fileChange') ? 'file' : 'command';
    const providerId = stringField(params, 'approvalId');
    const approvalId = providerId ?? `${kind}:${String(rpcId)}`;
    if (run.approvals.has(approvalId)) {
      throw new Error(`Duplicate Codex approval id: ${approvalId}`);
    }
    run.approvals.set(approvalId, { kind, rpcId });
    const network = params.networkApprovalContext != null;
    const reason = stringField(params, 'reason');
    const toolCallId = stringField(params, 'itemId');
    run.queue.push(
      run.factory.create({
        ...(reason ? { reason } : {}),
        ...(toolCallId ? { toolCallId } : {}),
        actor: 'agent',
        allowedDecisions: allowedDecisions(params),
        approvalId,
        input: toJsonValue(
          this.approvalInput(kind, params),
          'Codex approval input',
        ),
        risk: network ? 'network' : kind === 'file' ? 'write' : 'execute',
        toolName: kind === 'file' ? 'apply_patch' : 'shell',
        type: 'approval.requested',
      }),
    );
  }

  private approvalInput(
    kind: PendingCodexApproval['kind'],
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    if (kind === 'file') {
      return {
        grantRoot: params.grantRoot ?? null,
        itemId: params.itemId ?? null,
      };
    }
    return {
      command: params.command ?? null,
      commandActions: params.commandActions ?? [],
      cwd: params.cwd ?? null,
    };
  }

  async respondToApproval(
    id: string,
    response: ApprovalResponse,
  ): Promise<void> {
    const run = this.active;
    const pending = run?.approvals.get(id);
    if (!run || !pending) throw new Error(`Unknown Codex approval: ${id}`);
    this.client.respond(pending.rpcId, {
      decision: rawDecision(response.decision),
    });
    run.approvals.delete(id);
    run.queue.push(
      run.factory.create({
        ...(response.reason ? { reason: response.reason } : {}),
        actor: response.actor,
        approvalId: id,
        decision: response.decision,
        type: 'approval.resolved',
      }),
    );
  }

  private completeRun(
    run: CodexRun,
    rawOutcome: string,
    durationMs: number | undefined,
    respondPending = true,
  ): void {
    if (run.terminal) return;
    const outcome = run.interrupted
      ? 'interrupted'
      : rawOutcome === 'completed'
        ? 'completed'
        : rawOutcome === 'interrupted'
          ? 'interrupted'
          : 'failed';
    run.queue.push(
      run.factory.create({
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(run.usage ? { usage: run.usage } : {}),
        actor: 'agent',
        outcome,
        type: 'turn.completed',
      }),
    );
    this.finishRun(run, respondPending);
  }

  private failRun(run: CodexRun, error: Error): void {
    if (run.terminal) return;
    run.queue.push(
      run.factory.create({
        actor: 'agent',
        code: 'codex_provider_error',
        fatal: true,
        message: error.message,
        retryable: false,
        type: 'error',
      }),
    );
    this.completeRun(run, 'failed', undefined, false);
  }

  private finishRun(run: CodexRun, respondPending = true): void {
    run.terminal = true;
    this.resolvePending(run, 'cancel', respondPending);
    run.unsubscribeError();
    run.unsubscribeMessage();
    run.queue.close();
  }

  private resolvePending(
    run: CodexRun,
    decision: ApprovalDecision,
    sendResponse = true,
  ): void {
    for (const [id, pending] of run.approvals) {
      if (sendResponse) {
        this.client.respond(pending.rpcId, { decision: rawDecision(decision) });
      }
      run.queue.push(
        run.factory.create({
          actor: 'policy',
          approvalId: id,
          decision,
          reason: 'The active run ended before a user decision.',
          type: 'approval.resolved',
        }),
      );
    }
    run.approvals.clear();
  }

  async interrupt(): Promise<void> {
    const run = this.active;
    if (!run) return;
    run.interrupted = true;
    this.resolvePending(run, 'cancel');
    await run.started;
    if (!run.turnId || run.terminal) return;
    await this.client.request('turn/interrupt', {
      threadId: this.providerSessionId,
      turnId: run.turnId,
    });
  }

  private async stopRun(run: CodexRun): Promise<void> {
    run.interrupted = true;
    this.resolvePending(run, 'cancel');
    await run.started;
    if (run.turnId && !run.terminal) {
      await this.client.request('turn/interrupt', {
        threadId: this.providerSessionId,
        turnId: run.turnId,
      });
    }
    if (!run.terminal) this.finishRun(run);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.active) await this.stopRun(this.active);
    this.onClose();
  }
}
