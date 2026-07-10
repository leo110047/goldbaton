import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCodexCommand } from './codex-command.mjs';

const outputDirectory = resolve('spikes/codex/generated');
const requiredBinding = resolve(outputDirectory, 'ServerRequest.ts');
const launch = createCodexCommand([
  'app-server',
  'generate-ts',
  '--experimental',
  '--out',
  outputDirectory,
]);

rmSync(outputDirectory, { force: true, recursive: true });

const result = spawnSync(launch.command, launch.args, {
  encoding: 'utf8',
  stdio: 'pipe',
});

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  throw new Error(`codex generate-ts exited with status ${result.status}`);
}

if (!existsSync(requiredBinding)) {
  throw new Error(`codex generate-ts did not create ${requiredBinding}`);
}

process.stdout.write(`generated Codex bindings at ${outputDirectory}\n`);
