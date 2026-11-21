# Minimal image report v1

## Why

Report v1 tries to do too much for a first version. It has a status, structured misses, a position-free effect hash, declaration paths, locations, `verify --on` and a `same-effect` verdict. Every image (including the coming `fs` image) has to produce all of it. This cuts the protocol down to what a commit actually needs. The other parts can come back once a real use asks for them.

## Goals

- An image reports only a kind, a subject and a summary, or a failure.
- Verifying a commit still proves it is exactly what the image does on its parent.
- The kind stays machine-checked, so `git log --grep '^Refactor-Kind: rewrite'` lists the commits that need review.

## Non-goals

- Keeping old reports, commits or trailers readable. No consumers exist yet, so v1 is replaced in place (same `urn:jig:report:1`), not versioned.
- Verifying rebased or cherry-picked commits (`verify --on`). It goes, along with the effect hash it needed.

## Approaches

1. **Keep `kind`, drop the rest (picked).** It's one field with three values and one trailer. It tells a reviewer whether a commit claims to keep behaviour (`refactor`, `sweep`) or to change it (`rewrite`).
2. **Drop `kind` too, and put the convention in the subject text.** That's simpler, but nothing would check it, so the review signal goes.
3. **Keep `status` and the misses as well.** Partial results are real, but the summary text can describe them for the person reading it.

## The protocol

- **Success:** `{schema, ok: true, kind, subject, summary}`.
  - `kind` is one of `refactor`, `sweep` or `rewrite`.
  - `subject` starts with `<kind>(`, as today.
- **Failure:** `{schema, ok: false, code, instructions}` (unchanged).
- **Removed:** `status`, `effect`, `locations` and `misses`, the effect hash and canonical JSON, declaration paths, and the sorting rules.
  - Partial results are described in `summary`.
- **Commit:**
  - The message is the subject, a blank line, then the summary. The "Misses" block goes.
  - The trailers are `Refactor-Command`, `Refactor-Kind` and the co-author. `Refactor-Status` and `Refactor-Effect` go.
- **`jig verify`:** replays the command on the commit's parent.
  - `identical` means the tree, the kind and the subject match.
  - Anything else is `different`.
  - `--on` and `same-effect` go.
- **Output (`output-1`):** keeps what the run itself adds, such as the commit and `notes`. It drops the fields that came from the removed report fields.
- **Verify output (`verify-1`):** keeps the verdict values `identical` and `different`.

## Touches

- **TypeScript:** `packages/core` (report building and its types), every action in `packages/engine-typescript`, `action-prettier` and `action-codemod`, and their tests.
- **Swift:** `swift/report` (`ImageReport`, `CommitMessage`, `Verify` and `Output`; `CanonicalJSON` is removed if nothing else uses it), `swift/git` trailer tests, the cli `verify` command (removes `--on`), the integration tests and the probe image.
- **Schemas** (with their examples), and the README sections "Image report v1" and "Declaration paths". The READMEs in `swift/report` and `swift/cli` also change.

## Left to the builder

- Where to put the removed parts' tests: delete them, don't port them.
- Whether `TODO.md` entries about effects get removed or reworded.
