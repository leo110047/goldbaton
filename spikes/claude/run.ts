import {
  type CanUseTool,
  type Query,
  query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

const TIMER_COMMAND = 'node -e "setTimeout(() => {}, 30000)"';

interface Evidence {
  approvalReplied: boolean;
  approvalRequested: boolean;
  claudeCodeVersion?: string;
  interruptRequested: boolean;
  interruptResolved: boolean;
  resultSubtype?: string;
  sessionId?: string;
  streamedText: boolean;
}

function createEvidence(): Evidence {
  return {
    approvalReplied: false,
    approvalRequested: false,
    interruptRequested: false,
    interruptResolved: false,
    streamedText: false,
  };
}

function runtimeName(): string {
  return process.versions.bun
    ? `bun ${process.versions.bun}`
    : `node ${process.version}`;
}

function createInput(prompt: string): {
  close: () => void;
  messages: AsyncIterable<SDKUserMessage>;
} {
  let release: () => void = () => undefined;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* messages(): AsyncGenerator<SDKUserMessage> {
    yield {
      message: { content: prompt, role: 'user' },
      parent_tool_use_id: null,
      type: 'user',
    };
    await open;
  }
  return { close: release, messages: messages() };
}

function assertEvidence(evidence: Evidence): void {
  const missing = Object.entries({
    approvalReplied: evidence.approvalReplied,
    approvalRequested: evidence.approvalRequested,
    interruptRequested: evidence.interruptRequested,
    interruptResolved: evidence.interruptResolved,
    streamedText: evidence.streamedText,
  })
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`Claude spike missing evidence: ${missing.join(', ')}`);
  }
  if (!evidence.resultSubtype) {
    throw new Error('Claude spike did not receive a terminal result');
  }
}

function observeMessage(
  message: Awaited<ReturnType<Query['next']>>['value'],
  evidence: Evidence,
): void {
  if (!message) {
    return;
  }
  if (message.type === 'system' && message.subtype === 'init') {
    evidence.claudeCodeVersion = message.claude_code_version;
    evidence.sessionId = message.session_id;
  }
  if (
    message.type === 'stream_event' &&
    message.event.type === 'content_block_delta' &&
    message.event.delta.type === 'text_delta' &&
    message.event.delta.text.length > 0
  ) {
    evidence.streamedText = true;
  }
  if (message.type === 'result') {
    evidence.resultSubtype = message.subtype;
  }
}

function reportEvidence(evidence: Evidence): void {
  assertEvidence(evidence);
  process.stdout.write(
    `${JSON.stringify({
      ...evidence,
      provider: 'claude',
      runtime: runtimeName(),
    })}\n`,
  );
}

async function run(): Promise<void> {
  const evidence = createEvidence();
  const input = createInput(
    `First output exactly STREAM_READY. Then use Bash to run this exact harmless command: ${TIMER_COMMAND}. Do not use another tool.`,
  );
  let agentQuery: Query | undefined;
  let interruptPromise: Promise<void> | undefined;
  const canUseTool: CanUseTool = async (toolName, toolInput) => {
    evidence.approvalRequested = true;
    if (toolName !== 'Bash' || toolInput.command !== TIMER_COMMAND) {
      evidence.approvalReplied = true;
      return {
        behavior: 'deny',
        interrupt: true,
        message: 'Claude spike refused an unexpected tool request.',
      };
    }
    interruptPromise ??= new Promise((resolve, reject) => {
      setTimeout(() => {
        evidence.interruptRequested = true;
        agentQuery
          ?.interrupt()
          .then(() => {
            evidence.interruptResolved = true;
            resolve();
          })
          .catch(reject);
      }, 500);
    });
    evidence.approvalReplied = true;
    return { behavior: 'allow', updatedInput: toolInput };
  };
  agentQuery = query({
    options: {
      canUseTool,
      cwd: process.cwd(),
      includePartialMessages: true,
      maxTurns: 2,
      permissionMode: 'default',
      persistSession: false,
      settingSources: [],
      tools: ['Bash'],
    },
    prompt: input.messages,
  });
  const hardTimeout = setTimeout(() => agentQuery?.close(), 120_000);
  try {
    for await (const message of agentQuery) {
      observeMessage(message, evidence);
      if (message.type === 'result') {
        break;
      }
    }
    await interruptPromise;
    reportEvidence(evidence);
  } finally {
    clearTimeout(hardTimeout);
    input.close();
    agentQuery.close();
  }
}

run().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
