export interface CodexCommand {
  args: string[];
  command: string;
}

export function createCodexCommand(
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comspec: string | undefined = process.env.ComSpec,
): CodexCommand {
  if (platform === 'win32') {
    return {
      args: ['/d', '/s', '/c', 'codex.cmd', ...args],
      command: comspec || 'cmd.exe',
    };
  }
  return { args, command: 'codex' };
}
