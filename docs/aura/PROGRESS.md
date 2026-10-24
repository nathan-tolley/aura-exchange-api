# Progress

The live log for the `aura-v1` branch. See `CLAUDE.md` → "Progress and resuming". The "Now" block is always current; the log below it is append-only.

## Now
- Step: 0.1 → run `pnpm install` and `pnpm check` on the untouched branch, record the result in NOTES.md → Checks
- State: in progress
- Next action: get pnpm 11.25.0 available (corepack or a local install, without changing the global Node), then `pnpm install` and `pnpm check`
- Uncommitted work: none
- Waiting on Nathan:
  - Node 24 vs the installed Node 20.20.0, and installing pnpm 11.25.0 (affects his other projects; ask before changing anything global)
  - The fork: is `karkys` OK with it? Nothing gets pushed until then.
  - DECISIONS.md open question 10: prediction markets and options (keep on `/api` only for now).

## Log
- 2026-10-24 · 0.1 · `git status` on `master`: clean (fresh clone, no `web/` changes). `master` already at `49a0eaf`. Created `aura-v1`.
- 2026-10-24 · 0.1 · Copied the handoff into the repo (`CLAUDE.md`, `docs/aura/*`, `openapi/v1.yaml`, `openapi/CHANGES.md`, this file).
- 2026-10-24 · 0.1 · Wrote `docs/aura/NOTES.md` → What exists (routes, tables, jobs, code-vs-plan differences, contract gaps). Added open question 10 to DECISIONS.md.
