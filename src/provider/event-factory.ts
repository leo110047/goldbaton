import { randomUUID } from 'node:crypto';
import { parseProviderEvent } from './schema.js';
import type { ProviderEvent, ProviderEventPayload } from './types.js';

export interface ProviderEventFactoryOptions {
  createId?: () => string;
  now?: () => Date;
  provider: string;
  providerSessionId?: string;
  runId: string;
  sessionId: string;
}

export class ProviderEventFactory {
  private readonly createId: () => string;
  private readonly now: () => Date;
  private providerSessionId: string | undefined;
  private sequence = 0;

  constructor(private readonly options: ProviderEventFactoryOptions) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.providerSessionId = options.providerSessionId;
  }

  setProviderSessionId(providerSessionId: string): void {
    this.providerSessionId = providerSessionId;
  }

  create(payload: ProviderEventPayload): ProviderEvent {
    const providerSession = this.providerSessionId
      ? { providerSessionId: this.providerSessionId }
      : {};
    return parseProviderEvent({
      ...payload,
      ...providerSession,
      eventId: this.createId(),
      occurredAt: this.now().toISOString(),
      provider: this.options.provider,
      runId: this.options.runId,
      schemaVersion: 1,
      sequence: (this.sequence += 1),
      sessionId: this.options.sessionId,
    });
  }
}
