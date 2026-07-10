import type {
  Actor,
  ApprovalDecision,
  ApprovalRisk,
  JsonValue,
  ProviderEvent,
} from './types.js';

const ACTORS = new Set<Actor>(['agent', 'human', 'policy']);
const DECISIONS = new Set<ApprovalDecision>([
  'approve',
  'approve-session',
  'cancel',
  'deny',
]);
const RISKS = new Set<ApprovalRisk>([
  'execute',
  'external',
  'network',
  'read',
  'unknown',
  'write',
]);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BASE_FIELDS = [
  'actor',
  'eventId',
  'occurredAt',
  'provider',
  'providerSessionId',
  'runId',
  'schemaVersion',
  'sequence',
  'sessionId',
  'type',
];
const EVENT_FIELDS: Record<string, string[]> = {
  'approval.requested': [
    'allowedDecisions',
    'approvalId',
    'input',
    'reason',
    'risk',
    'toolCallId',
    'toolName',
  ],
  'approval.resolved': ['approvalId', 'decision', 'reason'],
  error: ['code', 'fatal', 'message', 'retryable'],
  'file.change': ['change', 'diff', 'path', 'status', 'toolCallId'],
  'message.input': ['content'],
  'run.started': ['profileId'],
  'text.delta': ['text'],
  'tool.call': [
    'durationMs',
    'input',
    'output',
    'status',
    'toolCallId',
    'toolName',
  ],
  'turn.completed': ['costUsd', 'durationMs', 'outcome', 'usage'],
};

export class ProviderEventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderEventValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ProviderEventValidationError(`${label} must be an object`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProviderEventValidationError(
      `${label} must be a non-empty string`,
    );
  }
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ProviderEventValidationError(
      `${label} must be a non-negative number`,
    );
  }
  return value;
}

function optionalString(value: unknown, label: string): void {
  if (value !== undefined) {
    requireString(value, label);
  }
}

function optionalNumber(value: unknown, label: string): void {
  if (value !== undefined) {
    requireNumber(value, label);
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ['boolean', 'string'].includes(typeof value)) {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

export function parseJsonValue(value: unknown): JsonValue {
  if (!isJsonValue(value)) {
    throw new ProviderEventValidationError('value must be valid JSON data');
  }
  return value;
}

function requireJson(value: unknown, label: string): void {
  try {
    parseJsonValue(value);
  } catch {
    throw new ProviderEventValidationError(`${label} must be valid JSON data`);
  }
}

function requireMember<T extends string>(
  value: unknown,
  values: ReadonlySet<T>,
  label: string,
): T {
  if (typeof value !== 'string' || !values.has(value as T)) {
    throw new ProviderEventValidationError(`${label} has an unsupported value`);
  }
  return value as T;
}

function validateBase(event: Record<string, unknown>): void {
  if (event.schemaVersion !== 1) {
    throw new ProviderEventValidationError('schemaVersion must be 1');
  }
  requireString(event.eventId, 'eventId');
  requireString(event.provider, 'provider');
  requireString(event.runId, 'runId');
  requireString(event.sessionId, 'sessionId');
  optionalString(event.providerSessionId, 'providerSessionId');
  requireMember(event.actor, ACTORS, 'actor');
  const sequence = requireNumber(event.sequence, 'sequence');
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new ProviderEventValidationError(
      'sequence must be a positive integer',
    );
  }
  const timestamp = requireString(event.occurredAt, 'occurredAt');
  if (!ISO_TIMESTAMP.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    throw new ProviderEventValidationError(
      'occurredAt must be an ISO timestamp',
    );
  }
}

function rejectUnexpectedFields(
  value: Record<string, unknown>,
  allowedFields: string[],
  label: string,
): void {
  const allowed = new Set(allowedFields);
  const unexpected = Object.keys(value).find((field) => !allowed.has(field));
  if (unexpected) {
    throw new ProviderEventValidationError(
      `Unexpected field ${label}.${unexpected}`,
    );
  }
}

function validateEventFields(event: Record<string, unknown>): void {
  const type = typeof event.type === 'string' ? event.type : '';
  const fields = EVENT_FIELDS[type];
  if (fields)
    rejectUnexpectedFields(event, [...BASE_FIELDS, ...fields], 'event');
}

function validateToolCall(event: Record<string, unknown>): void {
  requireString(event.toolCallId, 'toolCallId');
  requireString(event.toolName, 'toolName');
  requireMember(
    event.status,
    new Set(['completed', 'failed', 'started']),
    'status',
  );
  if (event.input !== undefined) requireJson(event.input, 'input');
  if (event.output !== undefined) requireJson(event.output, 'output');
  optionalNumber(event.durationMs, 'durationMs');
}

function validateFileChange(event: Record<string, unknown>): void {
  requireString(event.path, 'path');
  requireMember(event.change, new Set(['add', 'delete', 'update']), 'change');
  requireMember(
    event.status,
    new Set(['applied', 'failed', 'proposed']),
    'status',
  );
  optionalString(event.diff, 'diff');
  optionalString(event.toolCallId, 'toolCallId');
}

function validateApprovalRequest(event: Record<string, unknown>): void {
  requireString(event.approvalId, 'approvalId');
  requireString(event.toolName, 'toolName');
  requireJson(event.input, 'input');
  requireMember(event.risk, RISKS, 'risk');
  optionalString(event.reason, 'reason');
  optionalString(event.toolCallId, 'toolCallId');
  if (event.allowedDecisions !== undefined) {
    if (!Array.isArray(event.allowedDecisions)) {
      throw new ProviderEventValidationError(
        'allowedDecisions must be an array',
      );
    }
    for (const decision of event.allowedDecisions) {
      requireMember(decision, DECISIONS, 'allowedDecisions');
    }
  }
}

function validateUsage(value: unknown): void {
  if (value === undefined) return;
  const usage = requireRecord(value, 'usage');
  requireNumber(usage.inputTokens, 'usage.inputTokens');
  requireNumber(usage.outputTokens, 'usage.outputTokens');
  requireNumber(usage.totalTokens, 'usage.totalTokens');
  optionalNumber(usage.cachedInputTokens, 'usage.cachedInputTokens');
  optionalNumber(usage.reasoningTokens, 'usage.reasoningTokens');
  rejectUnexpectedFields(
    usage,
    [
      'cachedInputTokens',
      'inputTokens',
      'outputTokens',
      'reasoningTokens',
      'totalTokens',
    ],
    'usage',
  );
}

function validateTurnCompleted(event: Record<string, unknown>): void {
  requireMember(
    event.outcome,
    new Set(['completed', 'failed', 'interrupted']),
    'outcome',
  );
  optionalNumber(event.costUsd, 'costUsd');
  optionalNumber(event.durationMs, 'durationMs');
  validateUsage(event.usage);
}

function validateError(event: Record<string, unknown>): void {
  requireString(event.code, 'code');
  requireString(event.message, 'message');
  if (
    typeof event.fatal !== 'boolean' ||
    typeof event.retryable !== 'boolean'
  ) {
    throw new ProviderEventValidationError(
      'error fatal and retryable fields must be booleans',
    );
  }
}

function validatePayload(event: Record<string, unknown>): void {
  switch (event.type) {
    case 'run.started':
      requireString(event.profileId, 'profileId');
      return;
    case 'message.input':
      requireString(event.content, 'content');
      return;
    case 'text.delta':
      requireString(event.text, 'text');
      return;
    case 'tool.call':
      return validateToolCall(event);
    case 'file.change':
      return validateFileChange(event);
    case 'approval.requested':
      return validateApprovalRequest(event);
    case 'approval.resolved':
      requireString(event.approvalId, 'approvalId');
      requireMember(event.decision, DECISIONS, 'decision');
      optionalString(event.reason, 'reason');
      return;
    case 'turn.completed':
      return validateTurnCompleted(event);
    case 'error':
      return validateError(event);
    default:
      throw new ProviderEventValidationError(
        `Unsupported provider event type: ${String(event.type)}`,
      );
  }
}

function assertProviderEvent(value: unknown): asserts value is ProviderEvent {
  const event = requireRecord(value, 'provider event');
  validateBase(event);
  validatePayload(event);
  validateEventFields(event);
}

export function parseProviderEvent(value: unknown): ProviderEvent {
  assertProviderEvent(value);
  return value;
}
