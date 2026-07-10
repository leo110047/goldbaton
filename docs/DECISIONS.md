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
