# goldbaton Core Rules

These rules come from failure modes that can corrupt evidence, widen authority,
or make provider support claims untrustworthy. Fix the root cause when a rule or
gate blocks a change; never bypass the rule.

## 1. Provider boundary

- Provider SDK types, generated app-server types, wire parsing, and
  provider-specific branching stay inside `src/providers/<provider>/`.
- Shared modules and public exports must not expose raw provider payloads or
  provider-specific top-level fields.
- Shared events are a closed, runtime-validated contract. Intentional schema
  changes require an explicit schema version decision and behavior tests.
- Provider identifiers remain open strings. Shared behavior dispatches by
  capabilities and event contracts, not by a closed provider-name switch.

## 2. Native permission authority

- Do not bypass, weaken, or silently widen native provider permission policy.
- Every provider server request with an ID must receive a response or an
  explicit protocol error. Unsupported requests must fail closed, never hang.
- Approval requests and decisions must preserve their request ID, tool-call
  correlation, actor, allowed decisions, and risk category.
- A live verifier may approve a file mutation only when the correlated proposal
  exactly matches the expected operation, path, and content. Tool name alone is
  never sufficient approval evidence.

## 3. Evidence integrity

- Snapshot, redact, and runtime-validate every event before queueing a disk
  write.
- Preserve append-only ordering within each run. One failed append must not
  poison later appends, and settled run queues must not remain retained.
- Reject unsafe run identifiers and writes after close.
- Never persist raw credentials, authorization headers, private keys, or raw
  provider transcripts. Redaction must preserve non-secret usage metrics.
- Terminal provider errors remain errors. Do not relabel them as completed or
  replace the root error with a secondary missing-evidence assertion.

## 4. Local control-plane security

- Treat localhost and child-process messages as untrusted input.
- HTTP and WebSocket connections require a connection token, allowed-origin
  validation, and runtime schema validation before state changes or side
  effects.
- Unknown fields, event types, request methods, and invalid timestamps fail
  closed.

## 5. Verification truth

- Tests must be capable of catching the incident or contract regression they
  claim to cover. A type check or trivial assertion is not runtime evidence.
- Changes to provider translation, approval, interrupt, file-change, or process
  lifecycle behavior require the relevant live probe before making support
  claims.
- Check authentication in the same execution boundary as the live SDK. A
  sandbox that cannot read host credentials can produce a false logged-out
  result.
- Platform support claims require evidence from that target platform. Do not
  infer native support from another operating system or compatibility runtime.
- Timeouts must reject independently of cleanup. Concurrent provider cleanup
  must not delete shared state until every provider operation settles.

## 6. Productize, do not patch

Before adding a branch, constant, fallback, or compatibility path, ask:

1. Is this a reusable class of behavior or one observed instance?
2. Will the rule survive a provider or protocol change?
3. Does it create a second source of truth?

Do not add magic provider cases in shared code, duplicate provider state, or
fallbacks that hide a broken contract. Fix the owning boundary instead.

## 7. Work and gate safety

- Preserve user-owned and unrelated working-tree changes. Do not discard work
  to recover from a failed approach.
- Never weaken or skip tests, assertions, schemas, lint rules, repository gates,
  or hooks to obtain a green result.
- After two failed fixes for the same signal, stop changing code and re-derive
  the root cause from fresh evidence.
- Do not create automatic WIP commits. Commit or push only with explicit user
  authorization.

## 8. Durable language

- Canonical text sent to models is English. `zh-TW` content is display-only.
- Permanent scripts, commands, environment variables, and output labels use
  capability names that remain understandable without project-history context.
- Comments state the invariant and why it exists, not the dated incident,
  temporary state, or one triggering example.
