import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProviderEventFactory } from '../provider/event-factory.js';
import { EvidenceLog, readEvidenceEvents } from './evidence-log.js';

async function createTemporaryLog(): Promise<{
  directory: string;
  log: EvidenceLog;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'goldbaton-evidence-'));
  return { directory, log: new EvidenceLog(directory) };
}

function createFactory(runId = 'run-1'): ProviderEventFactory {
  return new ProviderEventFactory({
    createId: () => crypto.randomUUID(),
    now: () => new Date('2026-07-10T00:00:00.000Z'),
    provider: 'test-provider',
    runId,
    sessionId: 'session-1',
  });
}

test('writes one append-only JSONL file per run in sequence order', async () => {
  const { directory, log } = await createTemporaryLog();
  const factory = createFactory();
  const events = [
    factory.create({ actor: 'agent', text: 'one', type: 'text.delta' }),
    factory.create({ actor: 'agent', text: 'two', type: 'text.delta' }),
  ];

  await Promise.all(events.map((event) => log.append(event)));
  await log.close();

  const stored = await readEvidenceEvents(join(directory, 'run-1.jsonl'));
  assert.deepEqual(
    stored.map((event) => event.sequence),
    [1, 2],
  );
});

test('redacts secret keys and credential-shaped strings before disk write', async () => {
  const { directory, log } = await createTemporaryLog();
  const factory = createFactory('run-secrets');
  const secret = ['sk', 'ant', 'api03', 'ABCDEFGHIJKLMNOPQRSTUV'].join('-');
  const customSecret = 'plain-custom-secret-that-needs-key-redaction';
  const event = factory.create({
    actor: 'agent',
    approvalId: 'approval-1',
    input: {
      authorization: `Bearer ${secret}`,
      command: `send --token=${secret}`,
      nested: { apiKey: secret, myApiKey: customSecret },
    },
    risk: 'external',
    toolName: 'mcp__example__send',
    type: 'approval.requested',
  });

  await log.append(event);
  await log.close();

  const raw = await readFile(join(directory, 'run-secrets.jsonl'), 'utf8');
  assert.doesNotMatch(raw, new RegExp(secret));
  assert.doesNotMatch(raw, new RegExp(customSecret));
  assert.match(raw, /\[REDACTED\]/);
});

test('recovers a run after a failed append and releases its settled tail', async () => {
  const { directory, log } = await createTemporaryLog();
  const evidenceFile = join(directory, 'run-recovery.jsonl');
  const factory = createFactory('run-recovery');
  const first = factory.create({
    actor: 'agent',
    text: 'first',
    type: 'text.delta',
  });
  const second = factory.create({
    actor: 'agent',
    text: 'second',
    type: 'text.delta',
  });

  try {
    await mkdir(evidenceFile);
    await assert.rejects(log.append(first));
    await rm(evidenceFile, { recursive: true });

    await log.append(second);
    await log.close();

    const stored = await readEvidenceEvents(evidenceFile);
    assert.deepEqual(stored, [second]);
    const pending = Reflect.get(log, 'pending');
    assert.ok(pending instanceof Map);
    assert.equal(pending.size, 0);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('rejects unsafe run identifiers instead of writing outside the root', async () => {
  const { log } = await createTemporaryLog();
  const event = createFactory('../escape').create({
    actor: 'agent',
    text: 'unsafe',
    type: 'text.delta',
  });

  assert.throws(() => log.append(event), /Invalid runId/);
});

test('preserves token usage fields while redacting credential tokens', async () => {
  const { directory, log } = await createTemporaryLog();
  const event = createFactory('run-usage').create({
    actor: 'agent',
    outcome: 'completed',
    type: 'turn.completed',
    usage: {
      cachedInputTokens: 2,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 17,
    },
  });

  await log.append(event);
  await log.close();

  const [stored] = await readEvidenceEvents(join(directory, 'run-usage.jsonl'));
  assert.equal(stored?.type, 'turn.completed');
  if (stored?.type === 'turn.completed') {
    assert.equal(stored.usage?.inputTokens, 10);
  }
});

test('snapshots an event before queued writes and refuses append after close', async () => {
  const { directory, log } = await createTemporaryLog();
  const event = createFactory('run-snapshot').create({
    actor: 'agent',
    text: 'original',
    type: 'text.delta',
  });
  if (event.type !== 'text.delta') throw new Error('Expected a text event');

  const pending = log.append(event);
  event.text = 'mutated-after-append';
  await pending;
  await log.close();

  const [stored] = await readEvidenceEvents(
    join(directory, 'run-snapshot.jsonl'),
  );
  assert.equal(
    stored?.type === 'text.delta' ? stored.text : undefined,
    'original',
  );
  assert.throws(() => log.append(event), /closed/);
});
