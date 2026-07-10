# goldbaton North Star

goldbaton is a provider-neutral control plane. It coordinates native agent
runtimes without replacing their behavior, permissions, or protocol ownership.

## Supreme invariants

1. **One shared contract.** Core, evidence, replay, and clients consume one
   provider-neutral event contract. Provider SDK and wire details stop at the
   adapter boundary.
2. **Native authority stays native.** Claude Code, Codex CLI, and future
   providers remain responsible for agent behavior and permissions. goldbaton
   translates and records decisions; it does not bypass them.
3. **Evidence is trustworthy or absent.** Evidence is snapshotted, redacted,
   runtime-validated, append-only, and ordered before consumers may rely on it.
   Raw credentials and provider transcripts are never evidence.
4. **Local does not mean trusted.** Every process, HTTP, and WebSocket boundary
   validates identity, origin, message shape, and correlation before acting.
5. **Runtime behavior requires runtime proof.** Code reading and type checking
   cannot prove a provider, approval, interrupt, file-change, or platform path.
   Claims about those paths require the corresponding live evidence.

## Completion standard

A change is not complete if it leaks provider details into shared code, weakens
native permission authority, writes untrusted evidence, opens a fail-open local
boundary, or claims behavior that was not exercised at the real boundary.
