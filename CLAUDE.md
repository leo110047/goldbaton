# goldbaton Repository Instructions

## Product

goldbaton is a local-first TypeScript control plane for Claude Code, Codex CLI,
and future local-model providers. It owns the human interface, provider
translation, evidence, replay, and cross-provider coordination. Native provider
CLIs remain responsible for agent behavior and permissions.

## Current Scope

- The repository is in Phase 0: toolchain and project skeleton only.
- Do not add provider integrations, server APIs, persistence, or UI before the
  corresponding implementation-plan phase begins.
- Bun versus Node remains a Phase 1 decision. Keep Phase 0 source compatible
  with both runtimes and avoid runtime-specific APIs unless the spike proves
  they are required.

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
- `npm start`: run the compiled Phase 0 entrypoint.

## Code Quality

- Keep functions at 50 lines or fewer, cognitive complexity at 12 or fewer,
  and parameters at 4 or fewer.
- Unused imports and variables are errors.
- Do not bypass checks with `@ts-ignore`, `@ts-nocheck`, `as unknown as`,
  `biome-ignore`, or whole-file `eslint-disable` directives.
- Add tests with behavior in the phase that introduces that behavior. Do not
  add placeholder tests that only make a command pass.
