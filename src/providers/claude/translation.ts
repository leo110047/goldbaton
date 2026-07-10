import type { ProviderEventFactory } from '../../provider/event-factory.js';
import { toJsonValue } from '../../provider/json.js';
import type { ProviderEvent, TokenUsage } from '../../provider/types.js';
import {
  isRecord,
  numberField,
  recordField,
  stringField,
} from '../../provider/wire.js';

export interface ClaudeTranslationContext {
  emit: (event: ProviderEvent) => void;
  failed: () => boolean;
  factory: ProviderEventFactory;
  interrupted: () => boolean;
  markFailed: () => void;
  setProviderSessionId: (id: string) => void;
}

function translateStreamDelta(
  message: Record<string, unknown>,
  context: ClaudeTranslationContext,
): void {
  const event = recordField(message, 'event');
  const delta = event ? recordField(event, 'delta') : undefined;
  if (
    event?.type === 'content_block_delta' &&
    delta?.type === 'text_delta' &&
    typeof delta.text === 'string' &&
    delta.text.length > 0
  ) {
    context.emit(
      context.factory.create({
        actor: 'agent',
        text: delta.text,
        type: 'text.delta',
      }),
    );
  }
}

function translateToolUse(
  block: Record<string, unknown>,
  context: ClaudeTranslationContext,
): void {
  const id = stringField(block, 'id');
  const name = stringField(block, 'name');
  if (block.type !== 'tool_use' || !id || !name) return;
  context.emit(
    context.factory.create({
      actor: 'agent',
      input: toJsonValue(block.input ?? null, 'Claude tool input'),
      status: 'started',
      toolCallId: id,
      toolName: name,
      type: 'tool.call',
    }),
  );
}

function translateAssistant(
  message: Record<string, unknown>,
  context: ClaudeTranslationContext,
): void {
  const body = recordField(message, 'message');
  if (Array.isArray(body?.content)) {
    for (const block of body.content) {
      if (isRecord(block)) translateToolUse(block, context);
    }
  }
  const error = stringField(message, 'error');
  if (error) {
    context.markFailed();
    context.emit(
      context.factory.create({
        actor: 'agent',
        code: error,
        fatal: false,
        message: `Claude assistant error: ${error}`,
        retryable: ['overloaded', 'rate_limit', 'server_error'].includes(error),
        type: 'error',
      }),
    );
  }
}

function usageFromResult(
  message: Record<string, unknown>,
): TokenUsage | undefined {
  const usage = recordField(message, 'usage');
  if (!usage) return undefined;
  const inputTokens = numberField(usage, 'input_tokens') ?? 0;
  const outputTokens = numberField(usage, 'output_tokens') ?? 0;
  const cacheReadTokens = numberField(usage, 'cache_read_input_tokens') ?? 0;
  const cacheCreationTokens =
    numberField(usage, 'cache_creation_input_tokens') ?? 0;
  const cachedInputTokens = cacheReadTokens + cacheCreationTokens;
  return {
    cachedInputTokens,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens + cachedInputTokens,
  };
}

function translateResult(
  message: Record<string, unknown>,
  context: ClaudeTranslationContext,
): void {
  const subtype = stringField(message, 'subtype') ?? 'unknown';
  const errors = Array.isArray(message.errors)
    ? message.errors.filter(
        (error): error is string => typeof error === 'string',
      )
    : [];
  for (const error of errors) {
    context.emit(
      context.factory.create({
        actor: 'agent',
        code: subtype,
        fatal: false,
        message: error,
        retryable: false,
        type: 'error',
      }),
    );
  }
  const costUsd = numberField(message, 'total_cost_usd');
  const durationMs = numberField(message, 'duration_ms');
  const usage = usageFromResult(message);
  context.emit(
    context.factory.create({
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(usage ? { usage } : {}),
      actor: 'agent',
      outcome: context.interrupted()
        ? 'interrupted'
        : subtype === 'success' &&
            message.is_error !== true &&
            !context.failed()
          ? 'completed'
          : 'failed',
      type: 'turn.completed',
    }),
  );
}

function updateSession(
  message: Record<string, unknown>,
  context: ClaudeTranslationContext,
): void {
  const sessionId = stringField(message, 'session_id');
  if (sessionId) {
    context.factory.setProviderSessionId(sessionId);
    context.setProviderSessionId(sessionId);
  }
}

export function translateClaudeMessage(
  value: unknown,
  context: ClaudeTranslationContext,
): boolean {
  if (!isRecord(value)) {
    throw new Error('Claude SDK emitted a non-object message');
  }
  updateSession(value, context);
  if (value.type === 'stream_event') translateStreamDelta(value, context);
  if (value.type === 'assistant') translateAssistant(value, context);
  if (value.type === 'result') {
    translateResult(value, context);
    return true;
  }
  return false;
}
