# Architecture Decision Records

This document captures significant architectural and tooling decisions made
during development.

---

## ADR-001: Phase 0 toolchain enforcement boundary

**Date:** 2026-07-10
**Status:** Accepted

### Context

Phase 0 uses project-owned Biome and TypeScript checks, while the 600-line file
limit, merge-conflict marker checks, secret scanning, and related repository
rules currently come from the machine-level Goldband git hook. Those additional
checks are active on the development machine, but they would not follow the
repository to a machine without Goldband or to CI.

The current toolchain also resolves to TypeScript 7.0.2. Bun versus Node remains
undecided until the Phase 1 provider spikes, so the repository cannot yet state
an honest runtime requirement in `package.json#engines`.

### Decision

- Treat the initial commit as part of Phase 0 completion so all source and
  configuration files become tracked inputs to repository checks.
- Keep the project-owned Phase 0 command focused on Biome and TypeScript.
- Before the first shared CI or remote delivery workflow, add a repository-owned
  CI check equivalent to Goldband's tracked-file style scan. Do not assume a
  machine-global Goldband installation exists in CI.
- During Phase 1, compile both the Claude Agent SDK spike and Codex-generated
  TypeScript bindings with TypeScript 7. If either fails because of compiler
  compatibility, pin TypeScript to the latest compatible 5.x release.
- Add `package.json#engines` immediately after Phase 1 decides whether Bun or
  Node is the supported runtime baseline.

### Assumptions

- The machine-level Goldband hook remains active while Phase 0 is local-only.
- Phase 1 will exercise real Claude Agent SDK and Codex-generated binding types,
  not placeholder interfaces.
- No shared CI or remote delivery begins before the repository-owned style gate
  is added.

### Consequences

**Positive:**

- Phase 0 files are protected by Git history and become visible to tracked-file
  scans.
- Toolchain compatibility decisions are based on real provider integrations.
- CI cannot silently rely on developer-machine configuration.

**Negative:**

- Until the CI gate lands, `npm run check` alone does not enforce every
  Goldband repository rule on a clean machine.
- TypeScript may require a one-line version downgrade after the Phase 1 spike.

**Neutral:**

- Runtime `engines` remain intentionally absent during Phase 0.

### Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| Copy the complete Goldband style gate into Phase 0 | It would duplicate a maintained tool before CI exists; the current machine hook already covers local commits. |
| Pin TypeScript 5.x immediately | There is no observed incompatibility yet; Phase 1 provides the correct evidence. |
| Add Node or Bun `engines` now | The implementation plan explicitly leaves the runtime choice to Phase 1. |

### Failure Signals

- CI or a clean machine accepts a file that the Goldband style gate rejects.
- Claude Agent SDK types or Codex-generated bindings fail to compile under
  TypeScript 7.
- Runtime-specific code lands before the supported runtime is declared.

### Revisit Triggers / Exit Criteria

- Before adding the first CI or remote delivery workflow, implement and verify
  the repository-owned style gate.
- During Phase 1, record the TypeScript compatibility result and pin 5.x only if
  the real integrations require it.
- When Phase 1 selects Bun or Node, add and verify `package.json#engines` in the
  same change.

---

## ADR-002: Node 24 runtime baseline and Phase 1 provider control surfaces

**Date:** 2026-07-10
**Status:** Accepted

### Context

Phase 1 had to prove the provider control surfaces before the production
Provider interface is designed. The probes ran against Codex CLI 0.144.1 and
Claude Agent SDK 0.3.206, whose bundled Claude Code version is 2.1.206. Both
Node 24.16.0 and Bun 1.3.11 completed the live probes on macOS arm64.

The Codex probe received streamed text and a server-initiated command approval,
returned `decline`, observed `serverRequest/resolved`, and completed without
creating the marker file. The Claude probe received streamed text, answered its
`canUseTool` callback, resolved `Query.interrupt()`, and terminated the in-flight
timer. Codex generated 671 bindings that compile with TypeScript 7.0.2.

### Decision

- Use Node 24 as the supported runtime baseline and declare it in
  `package.json#engines`.
- Keep `tsx` for executable TypeScript spike harnesses.
- Keep Bun 1.3.11 as a verified compatibility target, not as the production
  runtime contract.
- Continue with Codex app-server in Phase 2. The planned `exec --json` downgrade
  is not activated because approval round trips passed.
- Keep generated Codex bindings reproducible and ignored rather than committing
  a 671-file version-specific snapshot.

### Why This Fits Now

The Claude package formally declares Node support, Node is already present on
the supported CI and Windows paths, and the product does not yet need Phase 8
single-binary packaging. Selecting Node minimizes unsupported-runtime risk while
preserving the measured Bun option.

### Assumptions

- Phase 2 continues to isolate app-server protocol churn inside CodexProvider.
- A live run on a real Windows machine will complete before native Windows
  support is claimed.
- Provider upgrades rerun binding generation, type checking, and live probes.

### Failure Signals

- A supported provider release stops compiling or loses an approval event.
- Node-specific behavior blocks single-binary packaging or materially worsens
  startup and distribution.
- Windows requires a different runtime to pass the same provider contract.

### Best Alternative

Promote Bun to the production baseline when Phase 8 packaging begins if its
single-executable path still works on every supported OS and its provider probes
remain green.

### Unknowns

- Native Windows live behavior is still unverified pending the manual run with
  interactively authenticated provider CLIs.
- Product use of Claude must use an Anthropic-supported authentication method;
  it cannot assume a third-party app may reuse consumer `claude.ai` login.

---

## ADR-003: Windows support form remains gated by a live provider run

**Date:** 2026-07-10
**Status:** Proposed

### Decision Pending

Run `npm run spike:verify` on a real Windows machine after authenticating both
provider CLIs interactively. This route does not require repository API-key
secrets. Prefer native Windows if both Node and Bun probes pass. If native
execution fails for a platform reason, capture the failing command and error,
then run the same matrix in WSL before selecting WSL as the baseline.

Until that evidence exists, documentation and packaging must not claim native
Windows or WSL support.

---

## ADR-004: Provider sessions and strict unified evidence events

**Date:** 2026-07-10
**Status:** Accepted

### Context

Phase 2 is the first production boundary over Claude Agent SDK and the
experimental Codex app-server. Core, future API clients, Evidence Log, replay,
and UI need one contract that does not expose either provider's message types.
The plan also requires approval risk and actor data from the first schema
version so later automated actors do not require a log migration.

### Decision

- A provider owns provider-wide resources and creates `ProviderSession`
  instances. Session-scoped `send`, approval response, interrupt, resume, and
  close operations keep provider lifecycle out of Core.
- Provider ids remain open strings. Capabilities are the planned six booleans,
  not provider-name checks.
- One runtime-validated, versioned event union covers run input, streamed text,
  tools, file changes, approval request/resolution, terminal outcome, and errors.
  Every event requires `actor`; approval requests also require a provider-neutral
  risk class.
- Unknown event types and extra provider-specific top-level fields fail
  validation. Opaque tool input/output remains JSON inside the shared event.
- Evidence uses one append-only JSONL file per run. Events are snapshotted,
  redacted, and validated before the queued disk write.
- Claude uses an SDK query per run and resumes the SDK session id. Native
  `Write`, `Edit`, and `NotebookEdit` file evidence comes from `PostToolUse` and
  `PostToolUseFailure`; `FileChanged` remains a watched-path event and is not a
  reliable source for the model's own file tools. A terminal Claude assistant
  error makes the provider-neutral turn outcome failed even if the subsequent
  SDK result subtype is `success`. Codex uses one shared app-server transport
  with threads as sessions.
- The Claude provider live harness disables file-backed setting sources so a
  developer's user or project hooks cannot preempt the deterministic provider
  probe. Production provider sessions continue to load native Claude settings.
- Until Phase 4, Claude uses its interactive `default` mode and Codex uses an
  `on-request` plus `read-only` baseline, so Phase 2 cannot silently widen
  permissions. Profiles carry identity and optional model only.
- Codex `costReporting` is false because the current protocol reports tokens but
  not USD cost. goldbaton will not silently embed a mutable price table.
- Codex server requests are claimed by the matching active session. The client
  returns an explicit JSON-RPC error when no session handles a request id, so
  unsupported permission, user-input, MCP elicitation, and future request
  methods cannot leave app-server waiting indefinitely.
- Provider-neutral evidence represents a Codex rename as correlated delete and
  add events with the same tool call id. Phase 2 does not add a provider-specific
  rename destination field to schema v1.

### Assumptions

- Claude Agent SDK continues to expose partial messages, `canUseTool`, hooks,
  persistent session ids, and interrupt.
- Codex keeps command/file approval requests, thread/turn lifecycle, and token
  usage behind app-server, even if individual wire shapes change.
- Core can enforce one active run per conversation using the session contract.
- Phase 3 state persistence remains separate from Evidence Log replay.

### Consequences

**Positive:**

- Core and future UI/API layers compile without provider SDK protocol types.
- A third Provider can reuse events, evidence, replay, and capability-driven UI.
- Approval decisions have a durable actor and risk audit trail from schema v1.
- Protocol drift fails in one adapter instead of corrupting shared state.

**Negative:**

- Both adapters contain explicit translation code that must track provider
  releases.
- Strict schemas require a deliberate schema version change for new shared
  event fields.
- Codex cost remains unavailable until the provider reports it or a separately
  approved pricing subsystem exists.

**Neutral:**

- The configuration-backed Provider Registry, server, state database, and UI
  remain later-phase work.

### Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| Put `send` and interrupt directly on singleton Provider objects | Multiple persistent conversations would share mutable run state and make concurrency errors easy. |
| Expose raw SDK/app-server messages and translate in UI | Core, evidence, replay, and every client would become coupled to two unstable protocols. |
| Store provider transcripts as the Evidence Log | Transcript formats do not share actor/risk semantics and cannot serve as a stable cross-provider replay contract. |
| Infer Codex USD cost from a hardcoded price table | Model aliases and prices change independently from the app-server protocol, so the number would look authoritative without a provider source. |
| Add SQLite conversation state in Phase 2 | The implementation plan assigns restartable conversation state and server lifecycle to Phase 3. |

### Failure Signals

- Adding a provider requires changes in Core or a provider-name conditional in UI.
- A provider wire field appears at the top level of a shared event or JSONL file.
- Concurrent sends interleave in one provider session.
- Interrupt or close leaves a provider permission callback unresolved.
- A live provider probe can be preempted by machine-local hooks or passes
  without observing an applied `file.change` event.
- Redaction removes token usage metrics or allows credential-shaped values onto
  disk.

### Revisit Triggers / Exit Criteria

- Phase 3 must prove server/state lifecycle can consume this interface without
  adding provider-specific branches.
- Phase 4 may extend the profile contract only after mapping both native
  permission systems and preserving permission monotonicity.
- Phase 7 must add the third Provider without editing Core/UI behavior outside
  configuration and provider registration.
- A provider protocol upgrade that cannot map faithfully must fail the adapter
  gate or introduce an explicit shared schema version, not a raw escape hatch.
