import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodexCommand } from './codex-command.mjs';

test('launches the native executable on POSIX', () => {
  assert.deepEqual(createCodexCommand(['app-server'], 'darwin'), {
    args: ['app-server'],
    command: 'codex',
  });
});

test('launches the npm cmd shim through cmd.exe on Windows', () => {
  assert.deepEqual(
    createCodexCommand(['app-server', '--stdio'], 'win32', 'C:\\cmd.exe'),
    {
      args: ['/d', '/s', '/c', 'codex.cmd', 'app-server', '--stdio'],
      command: 'C:\\cmd.exe',
    },
  );
});
