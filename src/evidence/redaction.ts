const REDACTED = '[REDACTED]';
const SECRET_KEY =
  /(?:api[-_]?key|authorization|cookie|credentials?|password|private[-_]?key|secret|token)$/i;
const SECRET_VALUES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
];

function redactString(value: string): string {
  return SECRET_VALUES.reduce(
    (redacted, pattern) => redacted.replace(pattern, REDACTED),
    value,
  );
}

function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      SECRET_KEY.test(key) ? REDACTED : redactSecrets(child),
    ]),
  );
}

export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (typeof value === 'object' && value !== null) {
    return redactRecord(value as Record<string, unknown>);
  }
  return value;
}
