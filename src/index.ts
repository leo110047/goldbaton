export const projectMetadata = {
  name: 'goldbaton',
  phase: 2,
} as const;

export {
  EvidenceLog,
  readEvidenceEvents,
  recordProviderEvents,
} from './evidence/evidence-log.js';
export { ProviderEventFactory } from './provider/event-factory.js';
export {
  ProviderEventValidationError,
  parseProviderEvent,
} from './provider/schema.js';
export type {
  Actor,
  ApprovalDecision,
  ApprovalResponse,
  ApprovalRisk,
  CreateSessionRequest,
  FileChangeEvent,
  JsonValue,
  Provider,
  ProviderCapabilities,
  ProviderErrorEvent,
  ProviderEvent,
  ProviderEventPayload,
  ProviderProfile,
  ProviderSession,
  SendMessageRequest,
  TokenUsage,
} from './provider/types.js';
export { ClaudeProvider } from './providers/claude/provider.js';
export { CodexProvider } from './providers/codex/provider.js';
