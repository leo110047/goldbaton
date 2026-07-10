import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CODE_EXTENSIONS = new Set([
  '.bash',
  '.cjs',
  '.js',
  '.jsx',
  '.mjs',
  '.py',
  '.sh',
  '.ts',
  '.tsx',
  '.zsh',
]);
const SECRET_PATTERNS = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['OpenAI API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['AWS access key', /\bAKIA[A-Z0-9]{16}\b/],
  [
    'credential assignment',
    /(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token)\s*[=:]\s*['"][A-Za-z0-9_./+=-]{20,}['"]/i,
  ],
];

export function inspectPath(file) {
  const name = basename(file);
  const issues = [];
  if (/^\.env(?:$|\.)/.test(name) && !name.endsWith('.example')) {
    issues.push('environment files are not allowed');
  }
  if (/(?:\.pem|\.key|id_rsa|id_ed25519|\.p12|\.pfx)$/.test(name)) {
    issues.push('credential or private-key files are not allowed');
  }
  if (name === '.DS_Store' || file.split(/[\\/]/).includes('node_modules')) {
    issues.push('generated or OS-noise paths are not allowed');
  }
  return issues;
}

export function inspectText(file, text) {
  const issues = [];
  const lineCount = text.split(/\r?\n/).length;
  if (CODE_EXTENSIONS.has(extname(file)) && lineCount > 600) {
    issues.push(`source file has ${lineCount} lines; maximum is 600`);
  }
  if (/^<<<<<<<(?: .*)?$[\s\S]*^=======$[\s\S]*^>>>>>>>(?: .*)?$/m.test(text)) {
    issues.push('merge-conflict marker block found');
  }
  for (const [name, pattern] of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      issues.push(`potential ${name} found`);
    }
  }
  return issues;
}

function isBinary(buffer) {
  return buffer.subarray(0, 8192).includes(0);
}

export function inspectFile(file) {
  if (!existsSync(file)) {
    return [];
  }
  const issues = inspectPath(file);
  const buffer = readFileSync(file);
  const byteLimit = isBinary(buffer) ? 512 * 1024 : 1024 * 1024;
  if (statSync(file).size > byteLimit) {
    issues.push(`file exceeds ${byteLimit} bytes`);
  }
  if (!isBinary(buffer)) {
    issues.push(...inspectText(file, buffer.toString('utf8')));
  }
  return issues.map((message) => `${file}: ${message}`);
}

function listRepositoryFiles() {
  const result = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || 'git ls-files failed');
  }
  return result.stdout.split('\0').filter(Boolean);
}

function main() {
  const issues = listRepositoryFiles().flatMap(inspectFile);
  if (issues.length > 0) {
    process.stderr.write(`${issues.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('repository-owned style and secret gate passed\n');
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
