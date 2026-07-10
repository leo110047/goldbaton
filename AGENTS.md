# goldbaton Agent Entry Point

Read these shared rules before changing the repository:

1. `rules/00-north-star.md` — the product invariants that outrank every other
   instruction.
2. `rules/core.md` — the failure-derived rules for provider boundaries,
   approvals, evidence, verification, and work safety.

## Hard stops

- Provider-specific types and payloads must not cross into shared contracts.
- Native provider permissions must not be bypassed, widened, or silently
  approved.
- Evidence must be redacted and validated before any disk write.
- HTTP and WebSocket boundaries must fail closed on authentication, origin, or
  schema errors.
- Provider and platform behavior must not be claimed without runtime evidence
  from the relevant live path.

`rules/00-north-star.md` wins when instructions conflict. `AGENTS.md` and
`CLAUDE.md` must remain byte-identical and must be updated together.
