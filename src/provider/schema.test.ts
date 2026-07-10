import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderEventFactory } from './event-factory.js';
import { ProviderEventValidationError, parseProviderEvent } from './schema.js';

const context = {
  provider: 'test-provider',
  runId: 'run-1',
  sessionId: 'session-1',
};

test('creates versioned provider-neutral events with ordered metadata', () => {
  const ids = ['event-1', 'event-2'][Symbol.iterator]();
  const factory = new ProviderEventFactory({
    ...context,
    createId: () => ids.next().value ?? 'unexpected',
    now: () => new Date('2026-07-10T00:00:00.000Z'),
  });

  const first = factory.create({
    actor: 'human',
    content: 'Review the current diff.',
    type: 'message.input',
  });
  const second = factory.create({
    actor: 'agent',
    text: 'I will inspect it.',
    type: 'text.delta',
  });

  assert.equal(first.schemaVersion, 1);
  assert.equal(first.sequence, 1);
  assert.equal(first.eventId, 'event-1');
  assert.equal(first.occurredAt, '2026-07-10T00:00:00.000Z');
  assert.equal(second.sequence, 2);
  assert.equal(parseProviderEvent(second), second);
});

test('requires actor and risk class on approval requests', () => {
  const valid = {
    actor: 'agent',
    approvalId: 'approval-1',
    eventId: 'event-1',
    input: { command: 'npm test' },
    occurredAt: '2026-07-10T00:00:00.000Z',
    provider: 'test-provider',
    risk: 'execute',
    runId: 'run-1',
    schemaVersion: 1,
    sequence: 1,
    sessionId: 'session-1',
    toolName: 'shell',
    type: 'approval.requested',
  };

  assert.equal(parseProviderEvent(valid), valid);
  assert.throws(
    () => parseProviderEvent({ ...valid, actor: 'system' }),
    ProviderEventValidationError,
  );
  const { risk: _risk, ...withoutRisk } = valid;
  assert.throws(
    () => parseProviderEvent(withoutRisk),
    ProviderEventValidationError,
  );
});

test('rejects unknown event types and invalid timestamps', () => {
  const base = {
    actor: 'agent',
    eventId: 'event-1',
    occurredAt: '2026-07-10T00:00:00.000Z',
    provider: 'test-provider',
    runId: 'run-1',
    schemaVersion: 1,
    sequence: 1,
    sessionId: 'session-1',
  };

  assert.throws(
    () => parseProviderEvent({ ...base, type: 'provider.raw' }),
    /Unsupported provider event type/,
  );
  assert.throws(
    () =>
      parseProviderEvent({
        ...base,
        occurredAt: 'not-a-date',
        text: 'hello',
        type: 'text.delta',
      }),
    /occurredAt/,
  );
});

test('rejects provider-specific fields outside the unified schema', () => {
  const event = {
    actor: 'agent',
    eventId: 'event-1',
    occurredAt: '2026-07-10T00:00:00.000Z',
    provider: 'test-provider',
    rawProviderPayload: { method: 'private/protocol/detail' },
    runId: 'run-1',
    schemaVersion: 1,
    sequence: 1,
    sessionId: 'session-1',
    text: 'hello',
    type: 'text.delta',
  };

  assert.throws(() => parseProviderEvent(event), /Unexpected field/);
});
