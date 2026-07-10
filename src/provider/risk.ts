import type { ApprovalRisk } from './types.js';

const READ_TOOLS = new Set(['glob', 'grep', 'ls', 'read', 'view']);
const WRITE_TOOLS = new Set(['edit', 'multiedit', 'notebookedit', 'write']);
const NETWORK_TOOLS = new Set(['webfetch', 'websearch']);
const EXECUTE_TOOLS = new Set([
  'bash',
  'computer',
  'computeruse',
  'skill',
  'task',
]);

export function classifyToolRisk(toolName: string): ApprovalRisk {
  const normalized = toolName.toLowerCase();
  if (normalized.startsWith('mcp__')) return 'external';
  if (READ_TOOLS.has(normalized)) return 'read';
  if (WRITE_TOOLS.has(normalized)) return 'write';
  if (NETWORK_TOOLS.has(normalized)) return 'network';
  if (EXECUTE_TOOLS.has(normalized)) return 'execute';
  return 'unknown';
}
