# jig — design

Date: 2026-11-17

## Intent

A command-line tool that **AI agents** use to perform mechanical refactors
(rename a symbol, move symbols to another file, …) through a real refactoring
engine, **validate** the result, and record each as its **own reproducible git
commit** with a bot co-author (`Co-Authored-By: codemodder <…>`). Reviewers
can tell mechanical commits apart from hand-written ones, and, once `verify`
exists, check them by re-running them.

Agents use it going forward ("rename `Foo` to `Bar` now") and retrospectively.
In the retrospective case, after doing work by hand, an agent goes back over
its commits and replaces the mechanical parts with tool-made commits. **How
those commits get placed in history is the agent's job, not the tool's**
(rebase, cherry-pick, `commit-tree`, …). The tool only produces a correct,
reproducible commit on top of the current checkout.

## Goals

- Two actions to start, for JS/TS/JSX/TSX:
  - **rename**: rename a declaration and every reference to it, across files.
  - **extract**: move one or more top-level declarations from a file into
    another file (new or existing), and fix imports and exports everywhere.
- Every commit the tool makes is validated before it is created.
- Every commit is **reproducible**: it records the exact command (and engine
  version) so that re-running it on the commit's parent produces the same
  tree. The `verify` command that does this check is TODO, but the data must
  be there, and the output must be deterministic, from day one.
- **Configurable per action**: each action declares which engine and which
  validators it uses, and a project can override them. TypeScript is the only
  engine for now. The design must allow others (e.g. LSP-based for other
  languages) without touching the git or commit code.
- Agent-first interface: non-interactive, JSON output, stable error codes.

## Non-goals (for now)

- Inserting commits into earlier history / rewriting history (agents do it).
- A `verify` command (TODO).
- Languages other than JS/TS.
- Generic jscodeshift / ast-grep codemods.
- Pushing, or anything that touches remotes.

## Anti-goals (a failure even if it "works")

- Committing a refactor that failed validation, or that silently covered only
  part of the symbol's uses.
- A commit whose recorded command, re-run on its parent, gives a different
  result (non-determinism).
- Mixing anything other than the refactor into the commit (e.g. the
  user's uncommitted changes).

## Approaches considered

- **A. TypeScript language service directly (chosen).** Use the `typescript`
  package's `LanguageService`: `findRenameLocations` for rename,
  `getEditsForRefactor` with the built-in "Move to file" refactor (TS ≥ 5.2,
  `interactiveRefactorArguments: { targetFile }`) for extract. This is the
  same engine as VS Code's F2 and "Move to a new file". It runs in-process,
  with no server, and is scope-aware (shadowing, re-exports, `import type`,
  path aliases).
- **B. Language servers (LSP).** Multi-language in principle, but means
  managing a server process per run, and "move to file" support differs a lot
  between servers. Deferred. The engine interface keeps it possible later.
- **C. ts-morph.** Nice rename API but no move-to-file; we would hand-write
  import rewiring, which is where the bugs are. Rejected.
- jscodeshift was dropped: it works per file with no type information, so it
  cannot do a correct cross-file rename.

The user picked A, with the requirement that engine and validation are
configurable per action, starting with TypeScript.

## Decided by the user

- Built for agents; used both going forward and retrospectively.
- Engine: TypeScript language service, behind a per-action configurable engine.
- Commits carry a replayable command; `verify` is TODO.
- No history rewriting in the tool: it commits on top of the current checkout.

## Reproducibility model (revision 2026-11-17, supersedes conflicting text below)

Decided by the user:
- A commit names the refactor, not engine and tool versions. Action ids are
  `typescript-rename` and `typescript-extract`, and "we will know what it
  points to". The only trailers are `Refactor-Command` and `Co-Authored-By`.
  `Refactor-Engine` and `Refactor-Tool` are dropped.
- The future replay model: start a container image (pinned by digest) with
  the parent commit's checkout at `/workspace`, with **no network**, run the
  recorded command, and compare trees. The image plus the command is all that
  is needed. Building the image and `verify` are TODO.

The container setup is explicitly later. v1 is a quick POC: the engine
uses the real filesystem, including `node_modules`, and makes no attempt to
be hermetic.

## Design

### CLI shape

```
jig rename  --file <path> --symbol <name> --to <newName> [common]
jig extract --file <path> --symbols <a,b,...> --to <targetPath> [common]

common:
  --repo <path>     target repository (default: cwd)
  --kind <kind>     disambiguate the symbol (function|class|interface|type|enum|variable)
  --dry-run         do everything except commit; print the diff, leave tree as it was
  --message <text>  optional extra explanation appended to the commit body
```

Paths are relative to the repo root.

Output: one JSON object on stdout:
- Success: `{ ok: true, action, commit, parent, filesChanged, validation, diff? }`.
- Failure: `{ ok: false, error: { code, message, details } }`, with a
  non-zero exit code.

Stable `error.code` values let agents react, e.g. `SYMBOL_NOT_FOUND`,
`AMBIGUOUS_SYMBOL`, `VALIDATION_FAILED`, `DIRTY_WORKTREE`,
`REFACTOR_UNAVAILABLE`, `ENGINE_CONFLICT`, `NO_CHANGES`.

### Flow

1. Precondition: the working tree and index are clean (`DIRTY_WORKTREE`
   otherwise; untracked files ignored only if gitignored). Detached HEAD is
   fine, since agents may check out an old commit to build a commit there.
2. Load config from the checked-out tree.
3. Engine computes edits. Apply them to the working tree.
4. Run validators. On failure: restore the tree exactly (`git checkout -- .`
   plus removing files the refactor created), return `VALIDATION_FAILED`.
5. Stage exactly the changed/created/deleted files, commit with the format
   below. With `--dry-run`: return the diff and restore instead.

Running in place, rather than in a temporary worktree, means the repo's own
`node_modules` are used as-is.

### Addressing symbols

Symbols are addressed by **file + name**, not by line/column. Positions are
not stable across commits, and the command must replay. A top-level
declaration with that name in that file is the target.
- None → `SYMBOL_NOT_FOUND`.
- Several (e.g. a type and a value with the same name) → `AMBIGUOUS_SYMBOL`,
  listing candidates. `--kind` disambiguates.
- v1: only **top-level** declarations, for both actions.

### Actions, engines, configuration

An action is a module with:
- `id`
- a parameter schema
- which **engine** it uses
- `run(engineContext, params) → FileEdits`
- `describe(params)`, which gives the commit subject
- a default list of **validators**

Actions register in a registry, so adding one means adding one file.

Engines implement a small interface: load the project(s) at a directory and
produce edits as plain `{ file, edits[] | create | delete }`. The
`typescript` engine works like this:

- **Projects:** it loads **every** project in the repo. That means all
  `tsconfig*.json` files not under `node_modules`, or the list in the config's
  `tsconfigs`. The target repos are monorepos (mimas, hydra), so this matters
  from v1. It builds one `LanguageService` per project and runs the
  operation in each project that contains the file. Edits are merged and
  de-duplicated by file+span; conflicting edits on the same span give
  `ENGINE_CONFLICT`.
- **rename:** `findRenameLocations(file, pos, findInStrings=false,
  findInComments=false, providePrefixAndSuffixTextForRename=true)`, after
  `getRenameInfo().canRename` is checked. Prefix/suffix text keeps shorthand
  properties and import/export specifiers correct.
- **extract:** `getEditsForRefactor(file, formatOptions, range,
  "Move to file", "Move to file", prefs, { targetFile })`, with the range
  covering the chosen declarations. Declarations that are not adjacent are
  moved one call at a time into the same target, each against the updated
  program.
- **TypeScript version:** it uses the target repo's own `typescript` if
  that is ≥ 5.2 and < 7, otherwise a copy bundled with the tool, pinned to
  `typescript@6.0.3`. TypeScript 7 (the native port, current `latest` as of
  2026-11) has no `createLanguageService`; checked 2026-11-17. The exact
  version used goes into the commit trailer.
- **Determinism:** fixed format options and user preferences live in code,
  not inherited from the environment. They are recorded in the trailer
  only if a config overrides them. Files are processed and edits applied in
  sorted order.

Project config, `.jig.json` at the repo root (optional),
read from the tree being refactored:

```json
{
  "coAuthor": "codemodder <codemodder@users.noreply.github.com>",
  "tsconfigs": ["tsconfig.json", "packages/*/tsconfig.json"],
  "ignoreUncovered": ["scripts/**"],
  "actions": {
    "rename":  { "engine": "typescript", "validators": ["typecheck"] },
    "extract": { "engine": "typescript", "validators": ["typecheck", { "command": "pnpm test" }] }
  }
}
```

### Validation

Built-in validators:
- **completeness** (always on):
  - Rename found at least one location, and the engine allowed it.
  - Extract produced edits, and the symbols are gone from the source and
    present in the target.
  - **Coverage:** any git-tracked JS/TS file that contains the symbol name
    as a whole word but belongs to none of the loaded projects fails
    validation, unless it matches `ignoreUncovered`. This prevents silently
    partial renames.
- **typecheck** (default): compares TypeScript diagnostics before and after
  across all loaded projects. It passes if there are no *new* errors,
  comparing by `(file, diagnostic code)` as a multiset, with files mapped
  for moves. Messages are not compared, because renames change them.
- **command** (opt-in): an arbitrary shell command that must exit 0, run in
  the refactored tree.

### Commit format

```
refactor(rename): Foo → Bar in src/foo.ts

<optional --message text>

Refactor-Command: {"action":"rename","params":{"file":"src/foo.ts","symbol":"Foo","to":"Bar"}}
Refactor-Engine: typescript@5.x.y
Refactor-Tool: jig@0.1.0
Co-Authored-By: codemodder <codemodder@users.noreply.github.com>
```

- `Refactor-Command` is canonical JSON (sorted keys), so `verify` can parse
  and replay it exactly.
- Author and committer are the user's normal git identity; the bot is the
  co-author.
- The co-author can be configured.

### Code layout (proposal)

```
src/
  cli.ts            arg parsing, JSON output, error codes
  config.ts         .jig.json loading + defaults
  actions/          registry.ts, rename.ts, extract.ts
  engines/          engine.ts (interface), typescript.ts
  validators/       completeness.ts, typecheck.ts, command.ts
  git.ts            clean check, restore, stage, commit
  run.ts            orchestrates: config → engine → apply → validate → commit
test/
  fixtures/         small TS projects (incl. a 2-package monorepo)
  *.test.ts         node --test, against real temp git repos
```

Tests should include a reproducibility test: run an action and get commit X;
reset to X's parent; run the parsed `Refactor-Command`; check that the tree
equals X's tree. This is a cheap preview of `verify`.

## TODO (out of v1 scope, keep the door open)

- Container image for replay: run with `/workspace` = parent checkout, no
  network, and the recorded command. Record its digest in the commit once it
  exists.

- `jig verify <commit>`: parse `Refactor-Command`, replay on the
  parent, compare trees. For reviewers and CI.
- Help for inserting refactor commits into earlier history (tree-preserving
  re-parenting, safety checks for pushed commits and other refs).
- More actions (rename file, inline, change signature …).
- An LSP-based engine for other languages.
- Renaming non-top-level symbols (locals, class members).

## Left to the builder

- Argument parsing library (or none), internal module boundaries beyond the
  sketch, exact JSON field names beyond those listed.
- Exact fixed format options.
- Test fixture contents.
