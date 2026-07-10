# goldbaton Repository Instructions

## Product

goldbaton is a local-first TypeScript control plane for Claude Code, Codex CLI,
and future local-model providers. It owns the human interface, provider
translation, evidence, replay, and cross-provider coordination. Native provider
CLIs remain responsible for agent behavior and permissions.

## Current Scope

- The repository is in Phase 1: provider risk spikes only.
- Keep spike harnesses isolated under `spikes/`. Do not turn them into the
  production Provider interface before Phase 2 begins.
- Do not add server APIs, persistence, or UI before the corresponding
  implementation-plan phase begins.
- Node 24 is the supported runtime baseline. Bun 1.3.11 is a verified
  compatibility target, not the production contract.

## Architecture Constraints

- Provider-specific assumptions must remain behind the future Provider
  interface; Core and UI must consume provider-neutral events.
- Keep API and event contracts usable without the Web UI.
- Treat localhost as an untrusted boundary. Future HTTP and WebSocket surfaces
  require connection tokens, origin checks, and schema validation.
- Text sent to models is canonical English. `zh-TW` content is display-only.

## Commands

- `npm run check`: Biome format/lint plus TypeScript type checking.
- `npm run build`: compile TypeScript into `dist/`.
- `npm start`: run the compiled current-phase entrypoint.
- `npm run spike:codex`: regenerate Codex bindings and run the live app-server
  spike.
- `npm run spike:claude`: run the live Claude Agent SDK spike.
- `npm run spike:verify`: run checks, build, and the complete Node/Bun provider
  spike matrix.

## Code Quality

- Keep functions at 50 lines or fewer, cognitive complexity at 12 or fewer,
  and parameters at 4 or fewer.
- Unused imports and variables are errors.
- Do not bypass checks with `@ts-ignore`, `@ts-nocheck`, `as unknown as`,
  `biome-ignore`, or whole-file `eslint-disable` directives.
- Add tests with behavior in the phase that introduces that behavior. Do not
  add placeholder tests that only make a command pass.
