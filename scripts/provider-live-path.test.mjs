import assert from 'node:assert/strict';
import { basename, dirname } from 'node:path';
import test from 'node:test';
import {
  createCodexMarkerPath,
  createNodeWriteCommand,
  matchesExpectedFileAddition,
  waitForProviderResults,
  withTimeout,
} from './provider-live-path.ts';

test('places the Codex approval marker outside workspace and system temp', () => {
  const home =
    process.platform === 'win32' ? 'C:\\Users\\tester' : '/Users/tester';
  const marker = createCodexMarkerPath(home, 42);

  assert.equal(dirname(marker), home);
  assert.equal(basename(marker), '.goldbaton-provider-live-codex-42');
});

test('quotes the marker as JavaScript and shell input', () => {
  const command = createNodeWriteCommand('/Users/test user/marker');

  assert.match(command, /^node -e /);
  assert.match(command, /test user/);
  assert.doesNotThrow(() => JSON.parse(command.slice('node -e '.length)));
});

test('approves only the exact proposed file addition', () => {
  const expected = {
    change: 'add',
    diff: 'FILE_CHANGE_READY\n',
    path: '/workspace/codex-file-change.txt',
  };

  assert.equal(
    matchesExpectedFileAddition(
      [expected],
      '/workspace/codex-file-change.txt',
      'FILE_CHANGE_READY\n',
    ),
    true,
  );
  assert.equal(
    matchesExpectedFileAddition(
      [expected, { ...expected, path: '/workspace/unexpected.txt' }],
      '/workspace/codex-file-change.txt',
      'FILE_CHANGE_READY\n',
    ),
    false,
  );
  assert.equal(
    matchesExpectedFileAddition(
      [{ ...expected, diff: 'UNEXPECTED\n' }],
      '/workspace/codex-file-change.txt',
      'FILE_CHANGE_READY\n',
    ),
    false,
  );
});

test('rejects at the deadline without waiting for cleanup', async () => {
  let cleanupStarted = false;
  const never = new Promise(() => undefined);
  const deadline = withTimeout(
    never,
    () => {
      cleanupStarted = true;
      return never;
    },
    0,
  );
  const didNotReject = new Promise((_, reject) => {
    setImmediate(() => reject(new Error('deadline remained pending')));
  });

  await assert.rejects(
    Promise.race([deadline, didNotReject]),
    /Provider live verification timed out/,
  );
  assert.equal(cleanupStarted, true);
});

test('waits for every provider before surfacing a failure', async () => {
  let codexSettled = false;
  const codex = new Promise((resolve) => {
    setImmediate(() => {
      codexSettled = true;
      resolve('codex');
    });
  });

  await assert.rejects(
    waitForProviderResults([codex, Promise.reject(new Error('claude failed'))]),
    /claude failed/,
  );
  assert.equal(codexSettled, true);
});
