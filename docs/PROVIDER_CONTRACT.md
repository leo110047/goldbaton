# Phase 2 Provider contract

Phase 2 defines the only production extension point between goldbaton Core and
provider-specific runtimes. Core consumes this contract without importing
Claude Agent SDK or Codex app-server protocol types.

## Public lifecycle

`Provider` owns provider-wide resources and exposes:

- `id`: an open string, not a `claude | codex` closed union.
- `capabilities()`: six provider-neutral feature flags.
- `createSession(request)`: starts or resumes one provider session.
- `dispose()`: closes every session and provider-wide transport.

`ProviderSession` owns one conversation and exposes:

- `send(message)`: starts one run and returns an async event stream.
- `respondToApproval(id, response)`: resolves a pending approval as
  `approve | approve-session | deny | cancel` with an explicit actor.
- `interrupt()`: interrupts the active provider turn.
- `close()`: ends the local session handle and cancels unresolved approvals.

One session accepts only one active run. A concurrent `send()` fails clearly
instead of interleaving provider turns.

`ProviderProfile` intentionally contains only `id` and optional `model` in this
phase. Provider-neutral permission profile mapping belongs to Phase 4. Until
then, both adapters use interactive, non-bypass defaults and load native provider
configuration normally.

## Capabilities

| Capability | Claude | Codex |
|---|---:|---:|
| Streaming | yes | yes |
| Tool use | yes | yes |
| Approvals | yes | yes |
| Resumable sessions | yes | yes |
| Interrupt | yes | yes |
| Cost reporting | yes | no |

Codex reports token usage but its current app-server contract does not report a
USD cost, so `costReporting` is false rather than inferred from a price table.

## Unified event schema

Every event is runtime-validated and includes:

- `schemaVersion: 1`
- globally unique `eventId`
- per-run positive `sequence`
- ISO UTC `occurredAt`
- provider, local session, optional provider session, and run identifiers
- `actor: human | policy | agent`
- one closed event payload from the table below

| Event | Purpose |
|---|---|
| `run.started` | Captures the selected profile and initiating actor. |
| `message.input` | Captures canonical model input. |
| `text.delta` | Streams assistant text. |
| `tool.call` | Records started, completed, or failed tool lifecycle. |
| `file.change` | Records proposed, applied, or failed file changes. |
| `approval.requested` | Carries tool, JSON input, allowed decisions, and risk class. |
| `approval.resolved` | Records decision and deciding actor. |
| `turn.completed` | Records terminal outcome, duration, usage, and provider cost when available. |
| `error` | Records explicit code, message, fatality, and retryability. |

Approval risk is one of `read`, `write`, `execute`, `network`, `external`, or
`unknown`. It describes the action category for display and evidence. It is not
a policy engine and never grants permission.

The parser rejects missing fields, unknown event types, invalid JSON values,
invalid timestamps, and extra provider-specific top-level fields. That keeps
Core, replay, and future UI consumers on one contract.

## Provider translations

### Claude

`ClaudeProvider` uses the official Agent SDK. It:

- resumes with the SDK session id and keeps SDK persistence enabled;
- loads normal user, project, and local Claude settings;
- requests partial messages for text streaming;
- turns `canUseTool` into data-driven approval events;
- observes PostToolUse and PostToolUseFailure hooks for tool lifecycle and
  structured `Write`, `Edit`, and `NotebookEdit` file evidence;
- maps SDK result usage and USD cost into the terminal event, combining cache
  reads and cache creation into provider-neutral `cachedInputTokens`;
- marks the terminal outcome as failed when the SDK emits an assistant error,
  even if the following result reports the `success` subtype;
- treats an SDK stream that ends without a result as an explicit failed turn.

### Codex

`CodexProvider` owns one stdio app-server client and creates or resumes threads
inside it. It:

- regenerates no production bindings and contains its narrow wire validation
  inside `src/providers/codex/`;
- starts persistent threads with `on-request`, user-reviewed approvals and a
  `read-only` Phase 2 baseline so writes require an explicit decision;
- translates agent deltas, command/MCP/dynamic tools, web-search queries and
  actions, file changes, token usage, command approvals, file approvals, errors,
  and terminal turns;
- represents a Codex rename as correlated provider-neutral delete and add file
  events so evidence retains both paths without a provider-specific schema field;
- routes `respondToApproval()` back to the original JSON-RPC request id;
- returns a JSON-RPC error for every server request that no active session
  handles, rather than leaving app-server waiting indefinitely;
- uses typed `turn/interrupt` parameters.

Codex app-server remains experimental. Binding generation and the Phase 1 live
spike remain upgrade gates for detecting protocol drift.

## Evidence Log

`EvidenceLog` writes one `<runId>.jsonl` file per run with append-only ordering.
It snapshots and runtime-validates each event before queueing the write. Files
use owner-only creation modes where the platform supports them.

Redaction happens before serialization and covers secret-bearing keys, private
keys, provider API keys, GitHub tokens, AWS access keys, and bearer tokens.
Token usage fields such as `inputTokens` remain numeric and are not mistaken for
credentials. `recordProviderEvents()` writes each event before yielding it to a
downstream consumer.

Evidence Log is not the conversation state database. Phase 3 will add queryable
state for conversation lifecycle and pending approvals; restart recovery must
not depend on replaying JSONL.

## Phase boundary

Phase 2 does not add server APIs, WebSocket messages, UI, SQLite state, policy
routing, bootstrap, or a configuration-backed Provider Registry. The contract
is exported from `src/index.ts` so those later layers can use it without reaching
into adapter internals.

## Verification

Credential-free contract checks:

```bash
npm test
npm run check
npm run build
npm run providers:verify:live
```

`providers:verify:live` consumes a small number of provider tokens. It verifies
the production adapters, approval decisions, interrupt, and JSONL Evidence Log.
The Claude live harness disables file-backed setting sources so user or project
hooks cannot preempt the deterministic probe; normal provider sessions still load
native settings as described above. The Codex probe approves a patch only when
the correlated proposed file event is exactly the expected single-file addition
with the expected path and content.
Provider upgrades must also regenerate Codex bindings and rerun the live Phase 1
spikes. Native Windows support remains unverified until the documented manual
matrix runs on a real Windows machine.
