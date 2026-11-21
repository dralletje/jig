# `verify`: replay a refactor commit and check it matches its command

Status: approved in conversation ("Verify would work how?", then "Go ahead" on the explained design).
See `AGENTS.md` (no Bun; symlinks deferred; publishing topics deferred).

## Why

A reviewer of a branch with refactor commits wants to skip reading the mechanical ones. `verify`
proves each such commit is exactly what its recorded command produces on its parent, so only the
hand-written commits (and the choice of commands) need human review. It proves the commit matches its
command, not that the command was the right one to run.

## Goals / non-goals

- Goals: `verify <commit>`, `verify <range>`, `verify <commit> --on <new-base>`; read-only on the repo;
  works with a dirty working tree; same sandboxes as a run.
- Non-goals: fixing or re-creating commits (no "re-run after rebase" that commits); verifying
  hand-written commits; a timeout (callers use `timeout`, as for runs).
- Anti-goals: `verify` must never write the work tree, index, refs or config of the repo; a verdict
  of `identical` must never be given for trees that differ.

## Approaches

1. **Replay inside the existing run pipeline** (chosen): reuse `Workspace` (temp index export of any
   commit), the sandbox, `ImageReport.parse`, `checkLeftovers`/`checkCapture` and the effect hash; stop
   before `commit-tree`. One code path for the capture means a verify sees exactly what a run would have
   committed.
2. Re-run then diff with `git diff` text: weaker (text diff is not the tree identity) and duplicates the
   capture checks.
3. Only recompute the effect hash from a stored report: can't detect a commit whose files were edited
   by hand after the run. Rejected.

## Command line

```
jig verify [--repo <path>] [--sandbox docker|rootlesskit|wasm] [--on <base>] <commit-or-range>
```

- `verify` is the first argument; the existing run form is unchanged (an image named `verify` is not a
  real concern; the builder may require `./verify` or similar for that edge only if trivial).
- `<commit-or-range>`: anything `git rev-parse --verify <x>^{commit}` accepts → one commit; anything with
  `..` → `git rev-list --reverse --no-merges <range>` (oldest first).
- `--on <base>` only with a single commit.

## Per commit

1. Read the trailers of the commit with git (e.g. `%(trailers:key=…,valueonly)`; the last trailer block
   only). No `Refactor-Command` → in a range: `skipped` (reason `no Refactor-Command`); for a single
   commit: error `INVALID_ARGS` with instructions. More than one parent → `skipped` / error alike.
   Unparsable `Refactor-Command` JSON → verdict `invalid` (in a range) / error (single).
2. Resolve the recorded pinned image with the chosen sandbox (as a run does; a wasm pin under an image
   sandbox already says to use `--sandbox wasm`).
3. Export the parent's tree (or `--on` base's) through a temporary index (`Workspace.export(commit:)`).
4. Run the image with the recorded args, parse the report, run `checkLeftovers` and `checkCapture`
   (with the parent's/base's tree), capture the tree with `write-tree`. No commit, no fast-forward.
   An image failure during replay → verdict `failed` with the error code and instructions.
5. Compare:
   - `identical`: replayed tree == commit's tree, and kind, status, subject and effect hash all equal
     the recorded `Refactor-Kind`/`Refactor-Status`/subject/`Refactor-Effect`.
   - `same-effect`: trees differ but the effect hash (and kind, status) equal the recorded ones.
   - `different`: anything else.
   With `--on`, the replayed tree is not compared with the commit's tree (different base): the verdict
   is `same-effect` or `different` only.
6. Interruption: same lifecycle as a run (sandbox cleanup, temp dirs removed, exit 130/143/129 with
   the INTERNAL failure JSON).

## Output

One JSON object on stdout, schema `urn:jig:verify:1` (added to `schemas/` with examples):

```json
{"schema":"urn:jig:verify:1","ok":true,"commits":[
  {"commit":"<sha>","verdict":"identical","command":{"image":"…","args":["…"]},
   "recordedEffect":"sha256:…","replayedEffect":"sha256:…","filesDiffering":[]}
]}
```

- Per-commit fields: `commit`, `verdict` (`identical|same-effect|different|failed|skipped|invalid`),
  plus as applicable `command`, `recordedEffect`, `replayedEffect`, `filesDiffering` (paths where the
  replayed tree and the commit's tree differ, sorted), `mismatches` (which of kind/status/subject/effect
  differ, with recorded and replayed values), `reason`/`code`/`instructions` (failed, skipped, invalid).
- `ok`: true when every non-skipped commit is `identical` (with `--on`: `same-effect`), and at least one
  commit was verified. Exit 0 when `ok`, 1 otherwise.
- Errors before any replay (bad args, unknown commit, not a repo, single commit without trailers) use
  the existing `urn:jig:output:1` error shape and exit 1.
- In a range, a failing commit doesn't stop the others.

## Tests

- Unit: argument parsing, trailer parsing, verdict computation, JSON output (and schema examples).
- Integration (probe image, docker; rootlesskit/wasm where available like the existing suites):
  verify a fresh run → identical; hand-edit the commit's tree (amend, message kept) → `same-effect` (the
  recorded effect still matches; only the tree differs) with that file listed, not ok; a probe mode with non-deterministic output (e.g. writes a random file but reports a fixed
  effect) → same-effect; range over refactor + hand-written commits → hand-written skipped, ok;
  `--on` after a rebase that moved code → same-effect; dirty work tree untouched and HEAD/refs/index
  unchanged after verify; interruption leaves no temp dir or container.

## Left to the builder

Exact Swift types and file layout (likely `Verify.swift` in `RefactorCLI`, sharing a "replay" function
with `runImage` by extracting the export → run → capture steps), the trailer-parsing method, and the
probe image modes needed.
