# Progress

The live log for the `aura-v1` branch. See `CLAUDE.md` → "Progress and resuming". The "Now" block is always current; the log below it is append-only.

## Now
- Step: 0.1 → write `docs/aura/NOTES.md` "What exists" (routes, tables, jobs since `5cb2b21`, mapped to /v1)
- State: in progress
- Next action: read `src/routes/`, `src/services/`, `src/worker.ts`, `db/migrations/` and the diff `5cb2b21..49a0eaf`, then write NOTES.md
- Uncommitted work: none
- Waiting on Nathan:
  - Node 24 vs the installed Node 20.20.0, and installing pnpm 11.25.0 (affects his other projects; ask before changing anything global)
  - The fork: is `karkys` OK with it? Nothing gets pushed until then.

## Log
- 2026-10-24 · 0.1 · `git status` on `master`: clean (fresh clone, no `web/` changes). `master` already at `49a0eaf`. Created `aura-v1`.
- 2026-10-24 · 0.1 · Copied the handoff into the repo (`CLAUDE.md`, `docs/aura/*`, `openapi/v1.yaml`, `openapi/CHANGES.md`, this file).
