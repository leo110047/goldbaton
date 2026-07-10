import type { ProviderEventFactory } from '../../provider/event-factory.js';
import { toJsonValue } from '../../provider/json.js';
import type { ProviderEvent, TokenUsage } from '../../provider/types.js';
import {
  isRecord,
  numberField,
  recordField,
  stringField,
} from '../../provider/wire.js';
import type { CodexWireMessage } from './client.js';

export interface CodexTranslationContext {
  complete: (outcome: string, durationMs: number | undefined) => void;
  emit: (event: ProviderEvent) => void;
  factory: ProviderEventFactory;
  requestApproval: (message: CodexWireMessage) => void;
  setUsage: (usage: TokenUsage) => void;
}

function translateTextDelta(
  params: Record<string, unknown>,
  context: CodexTranslationContext,
): void {
  const text = stringField(params, 'delta');
  if (!text) return;
  context.emit(
    context.factory.create({ actor: 'agent', text, type: 'text.delta' }),
  );
}

function toolName(item: Record<string, unknown>): string | undefined {
  if (item.type === 'commandExecution') return 'shell';
  if (item.type === 'mcpToolCall') {
    const server = stringField(item, 'server');
    const tool = stringField(item, 'tool');
    return server && tool ? `mcp__${server}__${tool}` : undefined;
  }
  if (item.type === 'dynamicToolCall') {
    const namespace = stringField(item, 'namespace');
    const tool = stringField(item, 'tool');
    return tool ? [namespace, tool].filter(Boolean).join(':') : undefined;
  }
  if (item.type === 'collabAgentToolCall') {
    const tool = stringField(item, 'tool');
    return tool ? `collaboration:${tool}` : undefined;
  }
  if (item.type === 'webSearch') return 'webSearch';
  return undefined;
}

function toolInput(item: Record<string, unknown>): unknown {
  if (item.type === 'commandExecution') {
    return {
      command: item.command ?? null,
      commandActions: item.commandActions ?? [],
      cwd: item.cwd ?? null,
    };
  }
  if (item.type === 'webSearch') {
    return { action: item.action ?? null, query: item.query ?? null };
  }
  return item.arguments ?? item.prompt ?? {};
}

function toolOutput(item: Record<string, unknown>): unknown {
  if (item.type === 'commandExecution') {
    return {
      exitCode: item.exitCode ?? null,
      output: item.aggregatedOutput ?? null,
    };
  }
  return item.result ?? item.error ?? item.contentItems ?? null;
}

function translateTool(
  item: Record<string, unknown>,
  phase: 'completed' | 'started',
  context: CodexTranslationContext,
): void {
  const id = stringField(item, 'id');
  const name = toolName(item);
  if (!id || !name) return;
  const rawStatus = stringField(item, 'status');
  const failed = rawStatus === 'failed' || rawStatus === 'declined';
  const durationMs = numberField(item, 'durationMs');
  context.emit(
    context.factory.create({
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(phase === 'completed'
        ? { output: toJsonValue(toolOutput(item), 'Codex tool output') }
        : {}),
      actor: 'agent',
      input: toJsonValue(toolInput(item), 'Codex tool input'),
      status: phase === 'started' ? 'started' : failed ? 'failed' : 'completed',
      toolCallId: id,
      toolName: name,
      type: 'tool.call',
    }),
  );
}

function fileChangeKind(value: unknown): 'add' | 'delete' | 'update' {
  if (!isRecord(value)) return 'update';
  if (value.type === 'add' || value.type === 'delete') return value.type;
  return 'update';
}

function translateFileChanges(
  item: Record<string, unknown>,
  phase: 'completed' | 'started',
  context: CodexTranslationContext,
): void {
  if (!Array.isArray(item.changes)) return;
  const rawStatus = stringField(item, 'status');
  const failed = rawStatus === 'failed' || rawStatus === 'declined';
  const status =
    phase === 'started' ? 'proposed' : failed ? 'failed' : 'applied';
  for (const value of item.changes) {
    if (isRecord(value)) translateFileChange(item, value, status, context);
  }
}

function translateFileChange(
  item: Record<string, unknown>,
  value: Record<string, unknown>,
  status: 'applied' | 'failed' | 'proposed',
  context: CodexTranslationContext,
): void {
  const path = stringField(value, 'path');
  if (!path) return;
  const diff = stringField(value, 'diff');
  const kind = isRecord(value.kind) ? value.kind : undefined;
  const movePath =
    kind?.type === 'update' ? stringField(kind, 'move_path') : undefined;
  if (movePath) {
    emitFileChange(item, { change: 'delete', path }, status, context);
    emitFileChange(
      item,
      { change: 'add', ...(diff ? { diff } : {}), path: movePath },
      status,
      context,
    );
    return;
  }
  emitFileChange(
    item,
    {
      change: fileChangeKind(value.kind),
      ...(diff ? { diff } : {}),
      path,
    },
    status,
    context,
  );
}

interface FileChangePayload {
  change: 'add' | 'delete' | 'update';
  diff?: string;
  path: string;
}

function emitFileChange(
  item: Record<string, unknown>,
  payload: FileChangePayload,
  status: 'applied' | 'failed' | 'proposed',
  context: CodexTranslationContext,
): void {
  const toolCallId = stringField(item, 'id');
  context.emit(
    context.factory.create({
      ...(payload.diff ? { diff: payload.diff } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      actor: 'agent',
      change: payload.change,
      path: payload.path,
      status,
      type: 'file.change',
    }),
  );
}

function translateItem(
  params: Record<string, unknown>,
  phase: 'completed' | 'started',
  context: CodexTranslationContext,
): void {
  const item = recordField(params, 'item');
  if (!item) return;
  if (item.type === 'fileChange') {
    translateFileChanges(item, phase, context);
    return;
  }
  translateTool(item, phase, context);
}

function tokenUsage(value: unknown): TokenUsage | undefined {
  const usage = isRecord(value) ? recordField(value, 'last') : undefined;
  if (!usage) return undefined;
  const inputTokens = numberField(usage, 'inputTokens') ?? 0;
  const outputTokens = numberField(usage, 'outputTokens') ?? 0;
  const totalTokens = numberField(usage, 'totalTokens') ?? 0;
  const cachedInputTokens = numberField(usage, 'cachedInputTokens') ?? 0;
  const reasoningTokens = numberField(usage, 'reasoningOutputTokens') ?? 0;
  return {
    cachedInputTokens,
    inputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
  };
}

function translateError(
  params: Record<string, unknown>,
  context: CodexTranslationContext,
): void {
  const error = recordField(params, 'error');
  const message = error ? stringField(error, 'message') : undefined;
  context.emit(
    context.factory.create({
      actor: 'agent',
      code: 'codex_turn_error',
      fatal: params.willRetry !== true,
      message: message ?? 'Codex turn failed without an error message.',
      retryable: params.willRetry === true,
      type: 'error',
    }),
  );
}

export function translateCodexMessage(
  message: CodexWireMessage,
  context: CodexTranslationContext,
): boolean {
  const method = stringField(message, 'method');
  const params = recordField(message, 'params');
  if (!method || !params) return false;
  switch (method) {
    case 'item/agentMessage/delta':
      translateTextDelta(params, context);
      return false;
    case 'item/started':
      translateItem(params, 'started', context);
      return false;
    case 'item/completed':
      translateItem(params, 'completed', context);
      return false;
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      context.requestApproval(message);
      return true;
    case 'error':
      translateError(params, context);
      return false;
    case 'thread/tokenUsage/updated':
      updateUsage(params, context);
      return false;
    case 'turn/completed':
      completeTurn(params, context);
      return false;
    default:
      return false;
  }
}

function updateUsage(
  params: Record<string, unknown>,
  context: CodexTranslationContext,
): void {
  const usage = tokenUsage(params.tokenUsage);
  if (usage) context.setUsage(usage);
}

function completeTurn(
  params: Record<string, unknown>,
  context: CodexTranslationContext,
): void {
  const turn = recordField(params, 'turn');
  context.complete(
    turn ? (stringField(turn, 'status') ?? 'failed') : 'failed',
    turn ? numberField(turn, 'durationMs') : undefined,
  );
}
