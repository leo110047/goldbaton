import type {
  CanUseTool,
  HookCallback,
  Options,
  PermissionResult,
  PermissionUpdate,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from '../../provider/async-queue.js';
import { ProviderEventFactory } from '../../provider/event-factory.js';
import { toJsonValue } from '../../provider/json.js';
import { classifyToolRisk } from '../../provider/risk.js';
import type {
  ApprovalResponse,
  CreateSessionRequest,
  ProviderEvent,
  ProviderSession,
  SendMessageRequest,
} from '../../provider/types.js';
import { isRecord, numberField, stringField } from '../../provider/wire.js';
import type {
  ClaudeQueryFactory,
  ClaudeQueryHandle,
  ClaudeQueryRequest,
} from './provider.js';
import { translateClaudeMessage } from './translation.js';

interface StreamingPrompt {
  close: () => void;
  messages: AsyncIterable<SDKUserMessage>;
}

interface PendingApproval {
  cleanup: () => void;
  input: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
  suggestions: PermissionUpdate[];
}

interface ApprovalWaitOptions {
  id: string;
  input: Record<string, unknown>;
  run: ClaudeRun;
  signal: AbortSignal;
  suggestions: PermissionUpdate[] | undefined;
}

function fileToolPath(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (toolName === 'NotebookEdit') {
    return stringField(input, 'notebook_path');
  }
  if (toolName === 'Edit' || toolName === 'Write') {
    return stringField(input, 'file_path');
  }
  return undefined;
}

function fileToolChange(
  toolName: string,
  response: Record<string, unknown>,
): 'add' | 'update' {
  return toolName === 'Write' && stringField(response, 'type') === 'create'
    ? 'add'
    : 'update';
}

function fileToolDiff(response: Record<string, unknown>): string | undefined {
  const gitDiff = isRecord(response.gitDiff) ? response.gitDiff : undefined;
  return gitDiff ? stringField(gitDiff, 'patch') : undefined;
}

interface ClaudeRun {
  approvals: Map<string, PendingApproval>;
  completionEmitted: boolean;
  done?: Promise<void>;
  factory: ProviderEventFactory;
  failed: boolean;
  interrupted: boolean;
  prompt?: StreamingPrompt;
  query?: ClaudeQueryHandle;
  queue: AsyncQueue<ProviderEvent>;
  terminal: boolean;
}

function createStreamingPrompt(content: string): StreamingPrompt {
  let release: () => void = () => undefined;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* messages(): AsyncGenerator<SDKUserMessage> {
    yield {
      message: { content, role: 'user' },
      parent_tool_use_id: null,
      type: 'user',
    };
    await open;
  }
  return { close: release, messages: messages() };
}

function permissionResult(
  pending: PendingApproval,
  response: ApprovalResponse,
): PermissionResult {
  if (response.decision === 'approve') {
    return { behavior: 'allow', updatedInput: pending.input };
  }
  if (response.decision === 'approve-session') {
    return {
      behavior: 'allow',
      updatedInput: pending.input,
      updatedPermissions: pending.suggestions,
    };
  }
  return {
    behavior: 'deny',
    interrupt: false,
    message: response.reason ?? `Tool request ${response.decision}.`,
  };
}

export class ClaudeSession implements ProviderSession {
  private active: ClaudeRun | undefined;
  private closed = false;
  private backendSessionId: string | undefined;

  constructor(
    readonly id: string,
    private readonly request: CreateSessionRequest,
    private readonly queryFactory: ClaudeQueryFactory,
    private readonly onClose: () => void,
  ) {
    this.backendSessionId = request.resumeSessionId;
  }

  get providerSessionId(): string | undefined {
    return this.backendSessionId;
  }

  send(message: SendMessageRequest): AsyncIterable<ProviderEvent> {
    return this.stream(message);
  }

  private async *stream(
    message: SendMessageRequest,
  ): AsyncGenerator<ProviderEvent> {
    const run = this.startRun(message);
    run.done = this.execute(run, message);
    try {
      for await (const event of run.queue) yield event;
    } finally {
      if (!run.terminal) await this.stopRun(run);
      if (this.active === run) this.active = undefined;
    }
  }

  private startRun(message: SendMessageRequest): ClaudeRun {
    if (this.closed) throw new Error('Claude session is closed');
    if (this.active)
      throw new Error('Claude session already has an active run');
    const providerSession = this.backendSessionId
      ? { providerSessionId: this.backendSessionId }
      : {};
    const factory = new ProviderEventFactory({
      ...providerSession,
      provider: 'claude',
      runId: message.runId,
      sessionId: this.id,
    });
    const run: ClaudeRun = {
      approvals: new Map(),
      completionEmitted: false,
      factory,
      failed: false,
      interrupted: false,
      queue: new AsyncQueue(),
      terminal: false,
    };
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

  private createCanUseTool(run: ClaudeRun): CanUseTool {
    return async (toolName, input, options) => {
      const approvalId = options.toolUseID;
      if (run.approvals.has(approvalId)) {
        throw new Error(`Duplicate Claude approval id: ${approvalId}`);
      }
      run.queue.push(
        run.factory.create({
          ...(options.decisionReason ? { reason: options.decisionReason } : {}),
          actor: 'agent',
          allowedDecisions: ['approve', 'approve-session', 'deny', 'cancel'],
          approvalId,
          input: toJsonValue(input, 'Claude approval input'),
          risk: classifyToolRisk(toolName),
          toolCallId: approvalId,
          toolName,
          type: 'approval.requested',
        }),
      );
      return this.waitForApproval({
        id: approvalId,
        input,
        run,
        signal: options.signal,
        suggestions: options.suggestions,
      });
    };
  }

  private waitForApproval(
    options: ApprovalWaitOptions,
  ): Promise<PermissionResult> {
    const { id, input, run, signal, suggestions } = options;
    return new Promise((resolve) => {
      const onAbort = () => {
        this.resolveApproval(run, id, {
          actor: 'policy',
          decision: 'cancel',
          reason: 'The Claude SDK aborted this approval request.',
        });
      };
      run.approvals.set(id, {
        cleanup: () => signal.removeEventListener('abort', onAbort),
        input,
        resolve,
        suggestions: suggestions ?? [],
      });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private createHook(run: ClaudeRun): HookCallback {
    return async (input) => {
      if (!isRecord(input)) return {};
      if (input.hook_event_name === 'PostToolUse') {
        this.emitToolResult(run, input, 'completed');
        this.emitFileToolResult(run, input, 'applied');
      }
      if (input.hook_event_name === 'PostToolUseFailure') {
        this.emitToolResult(run, input, 'failed');
        this.emitFileToolResult(run, input, 'failed');
      }
      return {};
    };
  }

  private emitToolResult(
    run: ClaudeRun,
    input: Record<string, unknown>,
    status: 'completed' | 'failed',
  ): void {
    const toolCallId = stringField(input, 'tool_use_id');
    const toolName = stringField(input, 'tool_name');
    if (!toolCallId || !toolName) return;
    const output =
      status === 'completed' ? input.tool_response : (input.error ?? null);
    const durationMs = numberField(input, 'duration_ms');
    run.queue.push(
      run.factory.create({
        ...(durationMs === undefined ? {} : { durationMs }),
        actor: 'agent',
        input: toJsonValue(input.tool_input ?? null, 'Claude tool input'),
        output: toJsonValue(output, 'Claude tool output'),
        status,
        toolCallId,
        toolName,
        type: 'tool.call',
      }),
    );
  }

  private emitFileToolResult(
    run: ClaudeRun,
    input: Record<string, unknown>,
    status: 'applied' | 'failed',
  ): void {
    const toolName = stringField(input, 'tool_name');
    const toolCallId = stringField(input, 'tool_use_id');
    const toolInput = isRecord(input.tool_input) ? input.tool_input : undefined;
    if (!toolName || !toolCallId || !toolInput) return;
    const path = fileToolPath(toolName, toolInput);
    if (!path) return;
    const response = isRecord(input.tool_response) ? input.tool_response : {};
    const diff = fileToolDiff(response);
    run.queue.push(
      run.factory.create({
        ...(diff ? { diff } : {}),
        actor: 'agent',
        change: fileToolChange(toolName, response),
        path,
        status,
        toolCallId,
        type: 'file.change',
      }),
    );
  }

  private createQueryRequest(
    run: ClaudeRun,
    message: SendMessageRequest,
  ): ClaudeQueryRequest {
    run.prompt = createStreamingPrompt(message.content);
    const optionalModel = this.request.profile.model
      ? { model: this.request.profile.model }
      : {};
    const optionalResume = this.backendSessionId
      ? { resume: this.backendSessionId }
      : {};
    const hook = this.createHook(run);
    const options: Options = {
      ...optionalModel,
      ...optionalResume,
      canUseTool: this.createCanUseTool(run),
      cwd: this.request.cwd,
      hooks: {
        PostToolUse: [{ hooks: [hook] }],
        PostToolUseFailure: [{ hooks: [hook] }],
      },
      includePartialMessages: true,
      permissionMode: 'default',
      persistSession: true,
    };
    return { options, prompt: run.prompt.messages };
  }

  private async execute(
    run: ClaudeRun,
    message: SendMessageRequest,
  ): Promise<void> {
    try {
      run.query = this.queryFactory(this.createQueryRequest(run, message));
      for await (const sdkMessage of run.query) {
        const terminal = translateClaudeMessage(sdkMessage, {
          emit: (event) => run.queue.push(event),
          failed: () => run.failed,
          factory: run.factory,
          interrupted: () => run.interrupted,
          markFailed: () => {
            run.failed = true;
          },
          setProviderSessionId: (id) => {
            this.backendSessionId = id;
          },
        });
        if (terminal) {
          run.completionEmitted = true;
          break;
        }
      }
      if (!run.completionEmitted) this.emitMissingTerminal(run);
    } catch (error) {
      this.emitFailure(run, error);
    } finally {
      run.terminal = true;
      this.resolvePending(run, 'cancel');
      run.prompt?.close();
      run.query?.close();
      run.queue.close();
    }
  }

  private emitFailure(run: ClaudeRun, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    run.queue.push(
      run.factory.create({
        actor: 'agent',
        code: 'claude_provider_error',
        fatal: true,
        message,
        retryable: false,
        type: 'error',
      }),
    );
    run.queue.push(
      run.factory.create({
        actor: 'agent',
        outcome: run.interrupted ? 'interrupted' : 'failed',
        type: 'turn.completed',
      }),
    );
    run.completionEmitted = true;
  }

  private emitMissingTerminal(run: ClaudeRun): void {
    if (run.interrupted) {
      run.queue.push(
        run.factory.create({
          actor: 'agent',
          outcome: 'interrupted',
          type: 'turn.completed',
        }),
      );
      run.completionEmitted = true;
      return;
    }
    this.emitFailure(
      run,
      new Error('Claude SDK stream ended without a terminal result'),
    );
  }

  async respondToApproval(
    id: string,
    response: ApprovalResponse,
  ): Promise<void> {
    const run = this.active;
    if (!run || !this.resolveApproval(run, id, response)) {
      throw new Error(`Unknown Claude approval: ${id}`);
    }
  }

  private resolveApproval(
    run: ClaudeRun,
    id: string,
    response: ApprovalResponse,
  ): boolean {
    const pending = run.approvals.get(id);
    if (!pending) return false;
    pending.cleanup();
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
    pending.resolve(permissionResult(pending, response));
    return true;
  }

  async interrupt(): Promise<void> {
    const run = this.active;
    if (!run) return;
    run.interrupted = true;
    this.resolvePending(run, 'cancel');
    await run.query?.interrupt();
  }

  private resolvePending(
    run: ClaudeRun,
    decision: ApprovalResponse['decision'],
  ): void {
    for (const id of [...run.approvals.keys()]) {
      this.resolveApproval(run, id, {
        actor: 'policy',
        decision,
        reason: 'The active run ended before a user decision.',
      });
    }
  }

  private async stopRun(run: ClaudeRun): Promise<void> {
    run.interrupted = true;
    this.resolvePending(run, 'cancel');
    run.prompt?.close();
    run.query?.close();
    await run.done;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.active) await this.stopRun(this.active);
    this.onClose();
  }
}
