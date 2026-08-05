# Contributing

Thanks for looking at Agentic Workspace. This is a local-first Electron app that spawns real
CLI processes on the user's machine, so the bar for changes in the main process is higher than
the usual UI patch — read [ARCHITECTURE.md](ARCHITECTURE.md) first.

## Setup

```bash
npm install
npm run dev
```

Requires Node `>=22.13.0` (the app uses `node:sqlite`) and Git on PATH. Agent CLIs
(`claude`, `codex`, `gemini`, `kiro-cli`, `aider`, `ollama`, …) are optional — the app detects
what you have and reports the rest as missing.

## Before you open a PR

```bash
npm run typecheck   # must be clean
npm test            # typecheck + node:test suite; must stay green
```

CI packages the app on Windows, macOS, and Linux, so a change that only builds on your
platform will be caught there.

## Adding a test

Test files are **enumerated explicitly** in `package.json` → `test:workflows`. Adding
`tests/my-thing.test.ts` is not enough — append it to that script or nothing will ever run it.

Tests use `node:test` against real repository classes on an in-memory `node:sqlite` database.
Prefer that over mocks: the bugs this project has actually hit were lifecycle and ordering
bugs that a mock would have hidden.

## Conventions

- **TypeScript everywhere**, no `any` to get past the typechecker.
- **Shared types live in `src/contracts/`.** If the renderer needs to know a shape, it belongs
  there — do not redeclare it locally.
- **Renderer layout:** `src/renderer/<feature>/<Feature>Module.tsx` + `<feature>.css`.
  Design tokens stay in `globals.css`; recolor in place rather than deleting override layers.
- **Comments explain *why*.** The valuable comments in this codebase describe non-obvious
  ordering constraints (why the pid table is snapshotted before signalling, why a guard exists
  on a DB write). Keep that style; skip comments that restate the line.
- **Commit messages:** `feat:`, `fix:`, `test:`, `docs:`, `chore:` — imperative and specific.

## Rules for the main process

These are not style preferences; violating them creates real vulnerabilities or orphaned
processes.

1. **Never `spawn` with `shell: true`, and never build a command string.** Always
   `spawn(executable, args[])`. User prompts must stay single argv elements.
2. **Never widen the preload API into a generic invoke.** Add a specific, typed method for a
   specific channel; the allow-list *is* the security boundary.
3. **Never store a secret in SQLite.** Encrypt via `ProviderSecretVault` and persist only the
   reference.
4. **Guard async DB writes with `shuttingDown`.** Child processes outlive `before-quit` and
   will call back into a closed handle otherwise.
5. **Keep a spawning/terminating process visible in bookkeeping.** A run that is in neither
   `queued` nor `running` counts against no limit and cannot be stopped.
6. **Git operations stay local and reversible.** `push` is deliberately absent; adding
   outbound Git needs explicit confirmation UX and protected-branch handling.

## Claiming a feature

Known gaps are documented in [docs/unfinished-features.md](docs/unfinished-features.md) with
file:line evidence, and per-feature plans live in `docs/feature/`. Completed plans move to
`docs/feature/done/`. Pick from there rather than guessing what's missing.

If you find a bug, the most useful PR shape is: a failing test that reproduces it, then the
fix. And check sibling call sites — the bugs here have tended to have more than one instance.

## Scope

This app is intentionally local-only: no hosted backend, no telemetry, no account system.
Features requiring a server are out of scope unless the user runs the server themselves.
