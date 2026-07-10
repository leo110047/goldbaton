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
