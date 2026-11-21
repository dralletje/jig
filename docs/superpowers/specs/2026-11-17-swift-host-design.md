# Swift host binary, git-based change capture

Status: approved in conversation ("Go ahead with the swift rewrite"). Supersedes, for the host binary,
the "How the binary runs it" section of `2026-11-17-container-actions-design.md`. The image contract,
the images and the CLI surface are unchanged.

## Intent

The user wants a single binary they trust: no Bun at runtime, and a stricter type system. The host
binary (`jig`) is rewritten in Swift and built as one static Linux binary. Actions stay in
whatever language their tool needs, inside their containers.

While porting, the host stops comparing and copying files itself. Git takes the container's output
folder as a work tree, builds the tree, commits it with `commit-tree`, and fast-forwards the repo. That
removes most of the hand-written file handling (the part where the safety bugs were), carries file
modes through, and leaves less code to port.

## Decisions (from the user)

- Swift for the host; one static binary. Actions unchanged.
- Git does the comparing (the flow below).
- The host's ignore rules are respected for now: an image that changes a `.gitignore` file is rejected
  (`IMAGE_FAILED`); new files an image creates at ignored paths are ignored (not committed, never
  written into the host repo).
- Symlinks created by images: deferred. See `AGENTS.md`. Keep whatever behaviour falls out of the flow;
  do not add rules for it and do not raise it.

## Goals

- `jig [--repo <path>] [--message <text>] <image> [args...]`, the same CLI, output JSON,
  error codes and trailers as the TypeScript host it replaces.
- Built with `swift build -c release --swift-sdk x86_64-swift-linux-musl` (Swift 6.4.2 and its Static
  Linux SDK `swift-6.4.2-RELEASE_static-linux-0.1.0`). A script builds it and puts the binary at
  `dist/jig`.
- The existing end-to-end tests (today `app/test/run.test.ts` and `export.test.ts`) keep defining
  correct behaviour, run against the Swift binary as a black box. Swift unit tests cover parsing and
  the commit message format.

## Non-goals

- Changing the image contract, the images, or the build-images script.
- A macOS or arm64 build (later; nothing in the design should block them).
- Installing Swift for other workspaces or CI (a later PR to the Coder template).

## The flow

1. Resolve `--repo` to the repo root. Refuse a dirty tree (`DIRTY_WORKTREE`), including hidden edits
   (`git ls-files -v`: a lowercase tag or `S`). Load `.jig.json` (only `coAuthor`).
2. Resolve the image to its ID, as today (`name@sha256:<id>` runs that ID if it exists; else
   `IMAGE_NOT_FOUND`).
3. Export HEAD into a temp dir with a temporary index (`read-tree HEAD` + `checkout-index -a
   --prefix`), as today.
4. Run the container exactly as today and parse its last-line JSON report (subject non-empty, one
   line).
5. Capture the result with git, using the same temporary index (already equal to HEAD) and the export
   as the work tree: `GIT_INDEX_FILE=<tmp> GIT_WORK_TREE=<dir> git add -A`, then `git write-tree` → T.
   Git applies the host's ignore rules (the export's `.gitignore` files, `.git/info/exclude`,
   `core.excludesFile`), so new ignored files are skipped.
6. Reject before committing (`IMAGE_FAILED`; nothing is written to the work tree, index or refs before the final
   fast-forward, and a rejected run can leave unreachable objects that `git gc` prunes):
   - any change to a path whose last component is `.gitignore`;
   - a `.git` entry the image created anywhere in the export (it would be added as a nested repo). This
     check runs before step 5, so `git add -A` never opens a repository a gitfile points at;
   - any new or changed gitlink (mode `160000`) in T compared with HEAD.
   Submodule gitlinks from HEAD must survive unchanged (their folder is empty in the export, which git
   treats as an uninitialized submodule).
7. T equal to `HEAD^{tree}`: `NO_CHANGES`.
8. `git commit-tree T -p HEAD` with the message from stdin → C. Same message format as today.
9. `git -c core.hooksPath=/dev/null merge --ff-only --no-overwrite-ignore C` in the repo: moves the branch (or detached HEAD) and
   updates index and files. Git refuses to overwrite ignored files and to write through symlinked
   folders. If `HEAD` moved or the work tree changed since step 3, the run fails with `DIRTY_WORKTREE`
   ("the repository changed while the image ran", unused commit id in details); any other refusal is
   `IMAGE_FAILED`.
10. Remove the temp dir and temp index; a cleanup failure is one stderr line, never a failure.
11. Print `{"ok":true,"commit","parent","image","args","filesChanged"}`; `filesChanged` from
    `git diff --name-only -z <parent> C` (sorted).

Behaviour changes from the TypeScript host, all accepted: file modes (the executable bit) now carry
through for created and edited files; no git hooks run (`commit-tree` bypasses the commit hooks, the fast-forward runs with
`core.hooksPath=/dev/null`; this matches "no validation in the binary"); a folder replaced by a file and similar shape changes now work.

## Code shape (builder's call within this)

- A Swift package in `host/` (`Package.swift`, executable product `jig`), Foundation only
  (no third-party packages). `Process` for `git` and `docker`, always with argument arrays, never a
  shell.
- Typed throughout: an `ErrorCode` enum (exhaustive), the output as a `Codable` struct, and a `JSONValue`
  enum for loosely-shaped input (the image report, the config file, error details). The command is built
  by a function, `canonicalCommand(image:args:)`, not a `RefactorCommand` struct.
- `Refactor-Command` must stay byte-identical to today's canonical JSON:
  `{"args":[...],"image":"..."}`, keys sorted, no whitespace, strings escaped the way JavaScript's
  `JSON.stringify` does (`/` not escaped, non-ASCII not escaped, `\b \f \n \r \t \" \\`, other control
  characters as lowercase `\u00xx`). A hand-written encoder for this one shape is fine.
- The TypeScript host goes away: `app/src`, `app/bin`, `packages/git`, and the host-only parts of
  `packages/core` (`commit.ts`, `config.ts`). The images keep using `packages/core`'s action types,
  report and errors.
- The end-to-end tests move to an `e2e/` TypeScript package (or stay in `app/test`) and run
  `dist/jig`, building it first if missing. Tests whose expectations change with this
  design (ignored files are skipped rather than rejected; executable bit kept on created files; a
  `.gitignore` change is rejected) are updated, not dropped.
  (Later: they moved to the Swift `IntegrationTests` target in `host/`; see `2026-11-18-no-bun-design.md`.)
