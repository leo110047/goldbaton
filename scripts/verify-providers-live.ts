import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  ClaudeProvider,
  CodexProvider,
  EvidenceLog,
  type ProviderEvent,
  type ProviderSession,
  readEvidenceEvents,
  recordProviderEvents,
} from '../src/index.js';
import {
  createCodexMarkerPath,
  createNodeWriteCommand,
  matchesExpectedFileAddition,
  type ProposedFileChange,
  waitForProviderResults,
  withTimeout,
} from './provider-live-path.js';

const CLAUDE_TIMER = 'node -e "setTimeout(() => {}, 30000)"';
const FILE_CHANGE_CONTENT = 'FILE_CHANGE_READY';
const CODEX_FILE_CHANGE_CONTENT = `${FILE_CHANGE_CONTENT}\n`;
const TIMEOUT_MS = 120_000;

interface LiveEvidence {
  approvalRequested: boolean;
  approvalResolved: boolean;
  completed: boolean;
  errors: string[];
  fileChanged: boolean;
  interrupted: boolean;
  streamedText: boolean;
}

interface CodexLiveContext {
  approvalMarker: string;
  command: string;
  evidence: LiveEvidence;
  fileMarker: string;
  log: EvidenceLog;
  session: ProviderSession;
}

function emptyEvidence(): LiveEvidence {
  return {
    approvalRequested: false,
    approvalResolved: false,
    completed: false,
    errors: [],
    fileChanged: false,
    interrupted: false,
    streamedText: false,
  };
}

function observe(event: ProviderEvent, evidence: LiveEvidence): void {
  if (event.type === 'text.delta' && event.text.length > 0) {
    evidence.streamedText = true;
  }
  if (event.type === 'approval.requested') evidence.approvalRequested = true;
  if (event.type === 'approval.resolved') evidence.approvalResolved = true;
  if (event.type === 'file.change' && event.status === 'applied') {
    evidence.fileChanged = true;
  }
  if (event.type === 'turn.completed') {
    evidence.completed = true;
    evidence.interrupted = event.outcome === 'interrupted';
  }
  if (event.type === 'error') {
    evidence.errors.push(`${event.code}: ${event.message}`);
  }
}

function debugDetails(event: ProviderEvent): Record<string, unknown> {
  if (event.type === 'tool.call') {
    return { status: event.status, toolName: event.toolName };
  }
  if (event.type === 'approval.requested') {
    return { risk: event.risk, toolName: event.toolName };
  }
  if (event.type === 'file.change') {
    return { change: event.change, path: event.path, status: event.status };
  }
  if (event.type === 'error') {
    return { code: event.code, message: event.message };
  }
  if (event.type === 'turn.completed') return { outcome: event.outcome };
  return {};
}

function debugEvent(provider: string, event: ProviderEvent): void {
  if (process.env.GOLDBATON_PROVIDERS_LIVE_DEBUG !== '1') return;
  process.stderr.write(
    `[providers-live:${provider}] ${JSON.stringify({ ...debugDetails(event), type: event.type })}\n`,
  );
}

function assertEvidence(
  provider: string,
  evidence: LiveEvidence,
  requireInterrupt: boolean,
): void {
  assert.deepEqual(
    evidence.errors,
    [],
    `${provider} provider errors: ${evidence.errors.join('; ')}`,
  );
  const required = {
    approvalRequested: evidence.approvalRequested,
    approvalResolved: evidence.approvalResolved,
    completed: evidence.completed,
    fileChanged: evidence.fileChanged,
    streamedText: evidence.streamedText,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (requireInterrupt && !evidence.interrupted) missing.push('interrupted');
  assert.deepEqual(missing, [], `${provider} missing: ${missing.join(', ')}`);
}

async function verifyCodex(
  log: EvidenceLog,
  cwd: string,
): Promise<LiveEvidence> {
  const provider = new CodexProvider();
  const approvalMarker = createCodexMarkerPath(homedir(), process.pid);
  const command = createNodeWriteCommand(approvalMarker);
  const fileMarker = join(cwd, 'codex-file-change.txt');
  const session = await provider.createSession({
    cwd,
    profile: { id: 'providers-live' },
  });
  const evidence = emptyEvidence();
  const operation = (async () => {
    try {
      return await consumeCodex({
        approvalMarker,
        command,
        evidence,
        fileMarker,
        log,
        session,
      });
    } finally {
      await provider.dispose();
    }
  })();
  try {
    return await withTimeout(operation, () => provider.dispose(), TIMEOUT_MS);
  } finally {
    await rm(approvalMarker, { force: true });
  }
}

async function consumeCodex(context: CodexLiveContext): Promise<LiveEvidence> {
  const { approvalMarker, command, evidence, fileMarker, log, session } =
    context;
  const events = recordProviderEvents(
    session.send({
      actor: 'human',
      content: `First output exactly STREAM_READY. Then use apply_patch, not the shell, to create codex-file-change.txt with exactly this content: ${FILE_CHANGE_CONTENT}. After that use the shell to run this exact command: ${command}. Do not use another tool.`,
      runId: 'codex-live',
    }),
    log,
  );
  const proposed = new Map<string, ProposedFileChange[]>();
  for await (const event of events) {
    debugEvent('codex', event);
    observe(event, evidence);
    rememberCodexProposal(event, proposed, fileMarker);
    if (event.type === 'approval.requested') {
      await respondToCodexApproval(session, event, proposed, fileMarker);
    }
  }
  assertEvidence('codex', evidence, false);
  assert.equal(
    existsSync(approvalMarker),
    false,
    'Codex created a declined marker',
  );
  assert.equal(
    (await readFile(fileMarker, 'utf8')).trim(),
    FILE_CHANGE_CONTENT,
  );
  return evidence;
}

function rememberCodexProposal(
  event: ProviderEvent,
  proposed: Map<string, ProposedFileChange[]>,
  fileMarker: string,
): void {
  if (
    event.type !== 'file.change' ||
    event.status !== 'proposed' ||
    !event.toolCallId
  ) {
    return;
  }
  const changes = proposed.get(event.toolCallId) ?? [];
  changes.push({
    change: event.change,
    ...(event.diff ? { diff: event.diff } : {}),
    path: resolve(dirname(fileMarker), event.path),
  });
  proposed.set(event.toolCallId, changes);
}

async function respondToCodexApproval(
  session: ProviderSession,
  event: Extract<ProviderEvent, { type: 'approval.requested' }>,
  proposed: Map<string, ProposedFileChange[]>,
  fileMarker: string,
): Promise<void> {
  const changes = event.toolCallId
    ? (proposed.get(event.toolCallId) ?? [])
    : [];
  const approveFile =
    event.toolName === 'apply_patch' &&
    matchesExpectedFileAddition(changes, fileMarker, CODEX_FILE_CHANGE_CONTENT);
  await session.respondToApproval(event.approvalId, {
    actor: 'human',
    decision: approveFile ? 'approve' : 'deny',
    reason: approveFile
      ? 'Live verification allows this temporary file change.'
      : 'Live verification rejects any unexpected mutation.',
  });
}

async function approveClaudeTool(
  session: ProviderSession,
  event: Extract<ProviderEvent, { type: 'approval.requested' }>,
  fileMarker: string,
): Promise<boolean> {
  if (event.toolName === 'Write') {
    assert.equal(
      typeof event.input === 'object' &&
        event.input !== null &&
        !Array.isArray(event.input) &&
        event.input.file_path === fileMarker &&
        event.input.content === FILE_CHANGE_CONTENT,
      true,
      'Claude requested an unexpected file write',
    );
    await session.respondToApproval(event.approvalId, {
      actor: 'human',
      decision: 'approve',
    });
    return false;
  }
  assert.equal(event.toolName, 'Bash');
  assert.equal(
    typeof event.input === 'object' &&
      event.input !== null &&
      !Array.isArray(event.input) &&
      event.input.command === CLAUDE_TIMER,
    true,
    'Claude requested an unexpected tool input',
  );
  await session.respondToApproval(event.approvalId, {
    actor: 'human',
    decision: 'approve',
  });
  return true;
}

async function verifyClaude(
  log: EvidenceLog,
  cwd: string,
): Promise<LiveEvidence> {
  const provider = new ClaudeProvider({
    queryFactory: (request) =>
      query({
        ...request,
        options: { ...request.options, settingSources: [] },
      }),
  });
  const fileMarker = join(cwd, 'claude-file-change.txt');
  const session = await provider.createSession({
    cwd,
    profile: { id: 'providers-live' },
  });
  const evidence = emptyEvidence();
  const operation = (async () => {
    try {
      return await consumeClaude(session, log, evidence, fileMarker);
    } finally {
      await provider.dispose();
    }
  })();
  return withTimeout(operation, () => provider.dispose(), TIMEOUT_MS);
}

async function consumeClaude(
  session: ProviderSession,
  log: EvidenceLog,
  evidence: LiveEvidence,
  fileMarker: string,
): Promise<LiveEvidence> {
  let interrupt: Promise<void> | undefined;
  const events = recordProviderEvents(
    session.send({
      actor: 'human',
      content: `First output exactly STREAM_READY. Then use Write, not Bash, to create this exact file: ${fileMarker}. Its entire content must be exactly ${FILE_CHANGE_CONTENT}. After that use Bash to run this exact harmless command: ${CLAUDE_TIMER}. Do not use another tool.`,
      runId: 'claude-live',
    }),
    log,
  );
  for await (const event of events) {
    debugEvent('claude', event);
    observe(event, evidence);
    if (event.type === 'approval.requested') {
      const startsTimer = await approveClaudeTool(session, event, fileMarker);
      if (startsTimer) {
        interrupt ??= new Promise((resolve, reject) => {
          setTimeout(() => session.interrupt().then(resolve, reject), 500);
        });
      }
    }
  }
  await interrupt;
  assertEvidence('claude', evidence, true);
  assert.equal(await readFile(fileMarker, 'utf8'), CODEX_FILE_CHANGE_CONTENT);
  return evidence;
}

async function verifyEvidence(directory: string): Promise<void> {
  for (const runId of ['claude-live', 'codex-live']) {
    const events = await readEvidenceEvents(join(directory, `${runId}.jsonl`));
    assert.ok(events.length > 0, `${runId} evidence log was empty`);
    assert.equal(events.at(-1)?.type, 'turn.completed');
  }
}

async function run(): Promise<void> {
  const evidenceDirectory = await mkdtemp(
    join(tmpdir(), 'goldbaton-providers-live-evidence-'),
  );
  const workspaceDirectory = await mkdtemp(
    join(tmpdir(), 'goldbaton-providers-live-workspaces-'),
  );
  const codexCwd = join(workspaceDirectory, 'codex');
  const claudeCwd = join(workspaceDirectory, 'claude');
  await Promise.all([mkdir(codexCwd), mkdir(claudeCwd)]);
  const log = new EvidenceLog(evidenceDirectory);
  try {
    const [codex, claude] = await waitForProviderResults([
      verifyCodex(log, codexCwd),
      verifyClaude(log, claudeCwd),
    ]);
    assert.ok(codex && claude, 'Provider live results were incomplete');
    await log.close();
    await verifyEvidence(evidenceDirectory);
    process.stdout.write(`${JSON.stringify({ claude, codex })}\n`);
  } finally {
    await log.close();
    await Promise.all([
      rm(evidenceDirectory, { force: true, recursive: true }),
      rm(workspaceDirectory, { force: true, recursive: true }),
    ]);
  }
}

run().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
