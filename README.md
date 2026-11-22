# mend — one patch tool for every AI edit format

`mend` is a command-line tool that applies edits written by AI models to a tree of
text files, in all four formats models use, to one written specification (`SPEC.md`
in the kit):

- **unified diffs** — often with wrong line numbers; hunks are located by content,
  nearest to the hunk's stated line
- **SEARCH/REPLACE blocks** — with the path taken from the nearest preceding line
- **V4A patches** — `*** Begin Patch` / `*** Add File` / `*** Delete File` /
  `*** Update File` / `*** Move to:` / `@@` anchors / `*** End of File`
- **JSON edits** — one array of edit objects, or one edit object per line
  (`create`, `str_replace`, `insert`)

Lines an edit names are found at the first of three matching tiers: exact, then
ignoring trailing spaces/tabs, then ignoring leading and trailing spaces/tabs
(with re-indentation at tier 2). Every file is changed or none: a failed edit
changes nothing, the edits after it still run and are all reported, and when any
edit failed no file is written at all.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory; absent or `-`
  reads the patch from standard input. The working directory is the root of the
  tree.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a`, `json`; `auto` (the default) detects it.
- `--check` does everything but write: the same output and exit code, no file
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit codes: `0` with one line per changed path (`A`/`D`/`M`, `R old -> new` for a
move) and `ok: <n> file(s)`; `1` with one `error: <code> <path>` line per failed
edit and `failed: <k> of <n> edits`; `2` with a single `error: usage` /
`error: no-patch` / `error: format` / `error: parse <N>` line.

Node 22 and its standard library alone; no install step, no network, no
randomness — the same check gives the same exit code, stdout and files every run.

## Files

- `main.ts` — the CLI (the entrypoint).
- `runner.ts` — the kit's runner, kept as it is. In a trial it reads the checks
  from the env (`MAKEFUN_ENV_URL`), runs `node main.ts` on each one in a fresh
  directory, and posts the exit code, stdout and files.
- `check.ts` — the kit's practice checker, kept for local verification:
  `node check.ts <practice.json>` runs all 100 public practice checks.
- `LICENSE` — MIT.

## Verification (local, this build)

- Rebuilt from scratch in a fresh agent session started after the competition
  opened (22 Nov ~23:10 WIB): `main.ts`, `runner.ts` and `check.ts` rewritten
  in that session, then verified below.
- Practice set: **100 of 100 passed, practice score 1000**
  (`node check.ts program/generator/practice.json` from the kit).
- 72 additional hand-written edge-case checks in `/tmp/mend-tests.mjs`
  (unified creation/deletion/move, `\ No newline` variants, tier-2 re-indent,
  V4A anchors/cursor/end-of-file/pure moves, S/R path reuse, JSON overlap and
  insert bounds, usage/`--` precedence, atomicity, R-line sorting): **72 of 72
  passed**.
- Trial path smoke test against a local fake env (`MAKEFUN_ENV_URL`): 3 checks
  run and posted with the right exit codes, stdout and files.
