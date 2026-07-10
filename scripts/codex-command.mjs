/**
 * Build a shell-free Codex CLI launch command for the current platform.
 * Windows npm binaries are .cmd shims, so cmd.exe must invoke the shim.
 *
 * @param {string[]} args
 * @param {NodeJS.Platform} platform
 * @param {string | undefined} comspec
 */
export function createCodexCommand(
  args,
  platform = process.platform,
  comspec = process.env.ComSpec,
) {
  if (platform === 'win32') {
    return {
      args: ['/d', '/s', '/c', 'codex.cmd', ...args],
      command: comspec || 'cmd.exe',
    };
  }
  return { args, command: 'codex' };
}
