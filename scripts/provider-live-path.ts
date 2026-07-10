import { join } from 'node:path';

export interface ProposedFileChange {
  change: 'add' | 'delete' | 'update';
  diff?: string;
  path: string;
}

export function createCodexMarkerPath(
  homeDirectory: string,
  processId: number,
): string {
  return join(homeDirectory, `.goldbaton-provider-live-codex-${processId}`);
}

export function createNodeWriteCommand(file: string): string {
  const script = `require('fs').writeFileSync(${JSON.stringify(file)}, '')`;
  return `node -e ${JSON.stringify(script)}`;
}

export function matchesExpectedFileAddition(
  changes: readonly ProposedFileChange[],
  expectedPath: string,
  expectedContent: string,
): boolean {
  if (changes.length !== 1) return false;
  const [change] = changes;
  return (
    change?.change === 'add' &&
    change.path === expectedPath &&
    change.diff === expectedContent
  );
}

export async function waitForProviderResults<T>(
  operations: readonly Promise<T>[],
): Promise<T[]> {
  const results = await Promise.allSettled(operations);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
}

export async function withTimeout<T>(
  operation: Promise<T>,
  cleanup: () => Promise<void>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('Provider live verification timed out'));
      void cleanup().catch(() => undefined);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
