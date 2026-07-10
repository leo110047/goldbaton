import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inspectAgentInstructions,
  inspectFile,
  inspectPath,
  inspectText,
} from './check-repository.mjs';

test('accepts ordinary source text', () => {
  assert.deepEqual(
    inspectText('src/main.ts', 'export const ready = true;\n'),
    [],
  );
});

test('rejects complete merge-conflict blocks', () => {
  const text = [
    '<<<<<<< HEAD',
    'ours',
    '=======',
    'theirs',
    '>>>>>>> main',
  ].join('\n');
  assert.match(inspectText('src/main.ts', text).join('\n'), /merge-conflict/);
});

test('rejects source files over 600 lines', () => {
  const text = Array.from({ length: 601 }, () => 'const value = 1;').join('\n');
  assert.match(inspectText('src/large.ts', text).join('\n'), /maximum is 600/);
});

test('rejects credential-shaped text', () => {
  const credential = ['sk', 'ant', 'api03', 'ABCDEFGHIJKLMNOPQRSTUV'].join('-');
  assert.match(
    inspectText('src/config.ts', credential).join('\n'),
    /Anthropic/,
  );
});

test('rejects sensitive paths while allowing examples', () => {
  assert.deepEqual(inspectPath('.env.example'), []);
  assert.match(inspectPath('.env.local').join('\n'), /environment files/);
  assert.match(inspectPath('certs/service.key').join('\n'), /private-key/);
});

test('skips tracked paths removed from the working tree', () => {
  assert.deepEqual(inspectFile('missing-renamed-file.ts'), []);
});

test('requires identical phase-free agent entry points', () => {
  const rules = '# Agent Rules\n\nRead `rules/core.md`.\n';

  assert.deepEqual(inspectAgentInstructions(rules, rules), []);
  assert.match(
    inspectAgentInstructions(rules, `${rules}\nClaude only.\n`).join('\n'),
    /byte-identical/,
  );
  assert.match(
    inspectAgentInstructions('Phase 3 rules', 'Phase 3 rules').join('\n'),
    /phase labels/,
  );
});
