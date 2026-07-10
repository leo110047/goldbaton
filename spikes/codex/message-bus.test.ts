import assert from 'node:assert/strict';
import { getActiveResourcesInfo } from 'node:process';
import test from 'node:test';
import { MessageBus } from './message-bus.js';

function activeTimeouts(): number {
  return getActiveResourcesInfo().filter((type) => type === 'Timeout').length;
}

test('fails every waiter, clears timers, and rejects future waits', async () => {
  const timeoutCount = activeTimeouts();
  const bus = new MessageBus();
  const first = bus.waitFor(() => false, 'first unreachable message');
  const second = bus.waitFor(() => false, 'second unreachable message');

  bus.fail(new Error('app-server failed'));

  await Promise.all([
    assert.rejects(first, /app-server failed/),
    assert.rejects(second, /app-server failed/),
    assert.rejects(
      bus.waitFor(() => false, 'wait after failure'),
      /app-server failed/,
    ),
  ]);
  assert.equal(activeTimeouts(), timeoutCount);
});
