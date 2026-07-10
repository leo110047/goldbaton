import { parseJsonValue } from './schema.js';
import type { JsonValue } from './types.js';

export function toJsonValue(value: unknown, label: string): JsonValue {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} was not JSON serializable: ${message}`);
  }
  if (serialized === undefined) {
    throw new Error(`${label} was not JSON serializable`);
  }
  const parsed: unknown = JSON.parse(serialized);
  return parseJsonValue(parsed);
}
