export type Actor = 'agent' | 'human' | 'policy';

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ProviderCapabilities {
  approvals: boolean;
  costReporting: boolean;
  interrupt: boolean;
  sessions: boolean;
  streaming: boolean;
  toolUse: boolean;
}

export interface ProviderProfile {
  id: string;
  model?: string;
}

export interface CreateSessionRequest {
  cwd: string;
  profile: ProviderProfile;
  resumeSessionId?: string;
}

export interface SendMessageRequest {
  actor: Actor;
  content: string;
  runId: string;
}

export type ApprovalDecision =
  | 'approve'
  | 'approve-session'
  | 'cancel'
  | 'deny';

export interface ApprovalResponse {
  actor: Actor;
  decision: ApprovalDecision;
  reason?: string;
}

export type ApprovalRisk =
  | 'execute'
  | 'external'
  | 'network'
  | 'read'
  | 'unknown'
  | 'write';

export interface TokenUsage {
  cachedInputTokens?: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
}

interface ProviderEventBase {
  actor: Actor;
  eventId: string;
  occurredAt: string;
  provider: string;
  providerSessionId?: string;
  runId: string;
  schemaVersion: 1;
  sequence: number;
  sessionId: string;
}

export interface RunStartedEvent extends ProviderEventBase {
  profileId: string;
  type: 'run.started';
}

export interface MessageInputEvent extends ProviderEventBase {
  content: string;
  type: 'message.input';
}

export interface TextDeltaEvent extends ProviderEventBase {
  text: string;
  type: 'text.delta';
}

export interface ToolCallEvent extends ProviderEventBase {
  durationMs?: number;
  input?: JsonValue;
  output?: JsonValue;
  status: 'completed' | 'failed' | 'started';
  toolCallId: string;
  toolName: string;
  type: 'tool.call';
}

export interface FileChangeEvent extends ProviderEventBase {
  change: 'add' | 'delete' | 'update';
  diff?: string;
  path: string;
  status: 'applied' | 'failed' | 'proposed';
  toolCallId?: string;
  type: 'file.change';
}

export interface ApprovalRequestedEvent extends ProviderEventBase {
  allowedDecisions?: ApprovalDecision[];
  approvalId: string;
  input: JsonValue;
  reason?: string;
  risk: ApprovalRisk;
  toolCallId?: string;
  toolName: string;
  type: 'approval.requested';
}

export interface ApprovalResolvedEvent extends ProviderEventBase {
  approvalId: string;
  decision: ApprovalDecision;
  reason?: string;
  type: 'approval.resolved';
}

export interface TurnCompletedEvent extends ProviderEventBase {
  costUsd?: number;
  durationMs?: number;
  outcome: 'completed' | 'failed' | 'interrupted';
  type: 'turn.completed';
  usage?: TokenUsage;
}

export interface ProviderErrorEvent extends ProviderEventBase {
  code: string;
  fatal: boolean;
  message: string;
  retryable: boolean;
  type: 'error';
}

export type ProviderEvent =
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | FileChangeEvent
  | MessageInputEvent
  | ProviderErrorEvent
  | RunStartedEvent
  | TextDeltaEvent
  | ToolCallEvent
  | TurnCompletedEvent;

type ProviderEventMetadataKey = Exclude<keyof ProviderEventBase, 'actor'>;

export type ProviderEventPayload = ProviderEvent extends infer Event
  ? Event extends ProviderEvent
    ? Omit<Event, ProviderEventMetadataKey>
    : never
  : never;

export interface ProviderSession {
  readonly id: string;
  readonly providerSessionId: string | undefined;
  close(): Promise<void>;
  interrupt(): Promise<void>;
  respondToApproval(id: string, response: ApprovalResponse): Promise<void>;
  send(message: SendMessageRequest): AsyncIterable<ProviderEvent>;
}

export interface Provider {
  readonly id: string;
  capabilities(): ProviderCapabilities;
  createSession(request: CreateSessionRequest): Promise<ProviderSession>;
  dispose(): Promise<void>;
}
