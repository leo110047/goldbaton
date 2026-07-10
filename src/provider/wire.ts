export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function recordField(
  value: Record<string, unknown>,
  field: string,
): Record<string, unknown> | undefined {
  const candidate = value[field];
  return isRecord(candidate) ? candidate : undefined;
}

export function stringField(
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  const candidate = value[field];
  return typeof candidate === 'string' ? candidate : undefined;
}

export function numberField(
  value: Record<string, unknown>,
  field: string,
): number | undefined {
  const candidate = value[field];
  return typeof candidate === 'number' && Number.isFinite(candidate)
    ? candidate
    : undefined;
}
