import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseProviderEvent } from '../provider/schema.js';
import type { ProviderEvent } from '../provider/types.js';
import { redactSecrets } from './redaction.js';

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function validateRunId(runId: string): void {
  if (!RUN_ID.test(runId)) {
    throw new Error(`Invalid runId for evidence log: ${runId}`);
  }
}

function serialize(event: ProviderEvent): string {
  const redacted = parseProviderEvent(redactSecrets(event));
  return `${JSON.stringify(redacted)}\n`;
}

export class EvidenceLog {
  private closed = false;
  private readonly pending = new Map<string, Promise<void>>();
  private readonly ready: Promise<string | undefined>;

  constructor(private readonly rootDirectory: string) {
    this.ready = mkdir(rootDirectory, { mode: 0o700, recursive: true });
  }

  append(event: ProviderEvent): Promise<void> {
    if (this.closed) throw new Error('Evidence log is closed');
    const validated = parseProviderEvent(event);
    validateRunId(validated.runId);
    const line = serialize(validated);
    const previous = this.pending.get(validated.runId) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        await this.ready;
        await appendFile(
          join(this.rootDirectory, `${validated.runId}.jsonl`),
          line,
          { encoding: 'utf8', flag: 'a', mode: 0o600 },
        );
      });
    this.track(validated.runId, write);
    return write;
  }

  private track(runId: string, write: Promise<void>): void {
    this.pending.set(runId, write);
    const release = (): void => {
      if (this.pending.get(runId) === write) this.pending.delete(runId);
    };
    void write.then(release, release);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.pending.values());
  }
}

export async function readEvidenceEvents(
  file: string,
): Promise<ProviderEvent[]> {
  const content = await readFile(file, 'utf8');
  return content
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return parseProviderEvent(JSON.parse(line));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid evidence line ${index + 1}: ${message}`);
      }
    });
}

export async function* recordProviderEvents(
  events: AsyncIterable<ProviderEvent>,
  log: EvidenceLog,
): AsyncGenerator<ProviderEvent> {
  for await (const event of events) {
    await log.append(event);
    yield event;
  }
}
