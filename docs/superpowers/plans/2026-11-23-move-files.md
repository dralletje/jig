# move-files and duplicate-files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two typescript-image actions, `move-files` and `duplicate-files`, that move or copy a group of
files and rewrite import specifiers with our own algorithm. `move-file` and `rename-files` then run on the
same core.

**Architecture:** A new `relocate.ts` core:

1. It takes a map of old to new root-relative paths and a mode (`move` | `duplicate`).
2. It finds every reference in the importers with `ts.createSourceFile` (no program).
3. It resolves each reference with `ts.resolveModuleName` under the importer's tsconfig options, parsed
   once per tsconfig.
4. It writes the new specifiers in the same style and extension form.
5. It checks each one against a resolution host that sees the world after the change.

It refuses the whole action on any doubtful reference. The helpers are shared with `import-style.ts`
through `shared.ts`.

**Tech Stack:**
- TypeScript 6.0.3 library on Node 26, with type stripping;
- `node:test`;
- `@jig/core` and `@jig/test-utils`.

**Spec:** `docs/superpowers/specs/2026-11-23-move-files-design.md`. Read it first; it is the source of
truth for the rules and refusals.

## Global Constraints

- **Kind:** both new actions are `refactor`. The subject is `refactor(typescript move-files): <describe>`.
- **Flags:**
  - all three are required, of type `globs`/`path`/`path`;
  - `--files` globs are from the repo root;
  - every match must be under `--from`.
- **Errors:**
  - wrong arguments are INVALID_ARGS;
  - doubtful references are REFACTOR_UNAVAILABLE, listing every problem as
    `<path>:<line>: <reason>. <instructions>`;
  - a doubtful reference refuses the whole action, and nothing is written.
- **Never write** tsconfig.json or package.json. A group containing `tsconfig*.json`, `jsconfig.json` or
  `package.json` is INVALID_ARGS.
- **Files not rewritten** move or copy byte for byte, never through a UTF-8 string.
- **No type-checking pass:** no `getProgram()` and no language service in the core.
- **Style** (repo memory and owner rules):
  - strings written inline at their use;
  - repeated guards written out, not hidden in helpers;
  - error messages say what to do next (see `import-style.ts` for the tone).
- **Tests:** run `sh scripts/test-packages.sh --test-name-pattern=<name>`. Do not run the full Swift suite.
- **Typecheck:** run `pnpm -C packages/engine-typescript typecheck`, or the repo's equivalent.
- **Commits:** end with exactly the line
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, and no Claude-Session line.

## Review Focus

- **A folder whose files import each other through an index folder** (`./lib` for `lib/index.ts`): it
  stays `./lib` after the move. This is a Task 3 test.
- **A pattern that picks some files under `--from`:** a moved file importing an unmoved sibling
  (`./helper`) gets `../../old/helper`-style paths, and the sibling importing a moved file is rewritten.
  This is a Task 3 test.
- **Moving into another tsconfig project** whose `paths` lack the alias a moved file uses: refused,
  naming the import. This is a Task 3 test.
- **`--to` inside `--from`** (`src/a` to `src/a/v2`) with `--files 'src/a/**'`: the destinations are new
  paths, so it works, and nothing is moved twice. This is a Task 3 test.
- **A binary file** (bytes that are not valid UTF-8) in the group arrives identical, for move and for
  duplicate. These are Task 1 and Task 3 tests.

---

### Task 1: Byte-exact file copies in the engine

**Files:**
- Modify: `packages/engine-typescript/src/engine.ts` (overlay, `changes()`)
- Modify: `packages/core/src/*` only if the `FileChange` type needs `Uint8Array` in `after`
- Test: `packages/engine-typescript/test/engine.test.ts`

**Interfaces:**
- Produces:
  - `TsEngine.copyFile(from: string, to: string): void` records that `to` gets `from`'s bytes as on
    disk.
  - `engine.read(to)` still returns the text, so later edits can rewrite it.
  - A later `write(to, text)` replaces the copy with the text.
  - `changes()` emits the bytes for a pure copy.
  - Moving is `copyFile(a, b)` then `write(a, null)`.

- [ ] **Step 1: Failing test** `copyFile keeps bytes that are not UTF-8`. Write
  `Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00])` to `img.png`, then `copyFile("img.png",
  "x/img.png")`, `write("img.png", null)` and `writeChanges`. Assert that `readFileSync(x/img.png)`
  deep-equals the original bytes, and that `img.png` is gone.
- [ ] **Step 2:** Run it. It fails because `copyFile` doesn't exist.
- [ ] **Step 3: Implement.** Keep copies apart from the text overlay (for example a `copies:
  Map<to, from>` that `write(to, …)` clears). `read`, `existsAbs` and the listings must see the copy.
  `getProjectVersion` must bump on a copy.
- [ ] **Step 4:** Run the engine tests. All pass.
- [ ] **Step 5:** Commit: `engine: byte-exact file copies`.

### Task 2: Share the specifier helpers

**Files:**
- Modify: `packages/engine-typescript/src/import-style.ts` (remove the moved helpers and import them)
- Modify: `packages/engine-typescript/src/shared.ts` (receive them)

**Interfaces:**
- Produces (exported from `shared.ts`, signatures unchanged from `import-style.ts`):
  - `importSpecifiers`, `matchesPathsKey`, `bestWildcardKey`, `styleOf`, `Style`;
  - `nearestPackageJson`, `importsOf`, `usesExactKey`, `namedPaths`;
  - `stem`, `spelledPath`, `slashed`, `outside`.
- `nearestPackageJson`, `importsOf`, `usesExactKey` and `namedPaths` take a reader. Give them a
  `read: (rel: string) => string | null` and `absPath`/`relPath` functions instead of a `TsEngine`, so the
  core can pass a view of the world after the change. Keep `import-style.ts` behaviour identical.

- [ ] **Step 1:** Move the helpers and adapt `import-style.ts`.
- [ ] **Step 2:** Run `sh scripts/test-packages.sh --test-name-pattern=imports-to` and the typecheck.
  All 40 import-style tests pass.
- [ ] **Step 3:** Commit: `typescript: share the specifier helpers`.

### Task 3: The relocate core, move-files and duplicate-files

**Files:**
- Create: `packages/engine-typescript/src/relocate.ts`
- Modify: `packages/engine-typescript/src/main.ts`. Add `moveFilesAction` and `duplicateFilesAction`
  after `moveFileAction`.
- Create: `examples/move-files/`, a small project:
  - `tsconfig.json` with `paths` `@/*` mapped to `./src/*`, `allowImportingTsExtensions`, `noEmit`, and
    `moduleResolution` `bundler`;
  - `package.json` with `imports` `#/*` mapped to `./src/*`;
  - `src/feature/{index.ts, a.ts, sub/b.ts, styles.css, logo.png}`, `src/shared.ts`, `src/user.ts`, using
    relative (with and without `.ts`), alias, subpath, index-folder, `import()`, `require`,
    `/// <reference path>`, and a JSDoc import type in one `.js` file.
- Test: `packages/engine-typescript/test/move-files.test.ts`
- Modify: `packages/engine-typescript/test/help.test.ts`, if it counts actions.

**Interfaces:**
- Consumes: `TsEngine.copyFile` (Task 1) and the `shared.ts` helpers (Task 2).
- Produces:

```ts
export type Relocation = { mode: "move" | "duplicate"; moves: Map<string, string> }; // root-relative old → new
export type Relocated = { files: string[]; rewritten: { file: string; imports: number }[] };
/** Plans everything, refuses (REFACTOR_UNAVAILABLE) on any doubtful reference, then applies to the engine. */
export function relocate(engine: TsEngine, r: Relocation): Relocated;
export const moveFilesAction: Action<{ files: string[]; from: string; to: string }, TsEngine>;
export const duplicateFilesAction: Action<{ files: string[]; from: string; to: string }, TsEngine>;
```

The rules are in the spec, under "For each reference" and "Doubtful cases". Implementation notes:
- Options per tsconfig: `ts.findConfigFile` from the importer's folder, then
  `ts.parseJsonConfigFileContent` once per tsconfig. Also keep the parsed `fileNames` for the
  include/files check.
- Mode: `ts.getImpliedNodeFormatForFile`, passed into `createSourceFile` as
  `{ languageVersion, impliedNodeFormat }`, then `getModeForUsageLocation`.
- JSDoc: walk `node.jsDoc` (with `setParentNodes: true`) for `JSDocImportTag` and `ImportTypeNode`.
- `referencedFiles` gives `/// <reference path>`. Treat it as a relative path that names the file
  exactly.
- **The host after the change:** for paths in the moves, an old path exists only in duplicate mode; a
  new path exists, with the old content. Everything else uses `engine.read`.
- **Order:**
  1. plan every edit;
  2. if there is any problem, throw;
  3. for each move, `copyFile(old, new)`;
  4. write the rewritten text of each changed importer, at its new path for moved importers;
  5. in move mode, `write(old, null)`.

- [ ] **Step 1: Failing tests** in `move-files.test.ts`. Each one checks the tree with `readTree`,
  checks the report subject, and, where noted, that `errors(dir, file)` is empty after the change.
  1. `move-files moves a folder and every reference follows`:
     - `--files 'src/feature/**' --from src/feature --to src/deep/feature2`;
     - in `src/user.ts`: `"./feature/a.ts"` → `"./deep/feature2/a.ts"`, `"@/feature/a"` →
       `"@/deep/feature2/a"`, `"#/feature/a.ts"` → `"#/deep/feature2/a.ts"`;
     - inside the group, `"./sub/b"` is unchanged;
     - `"../shared"` → `"../../shared"` (stays without extension);
     - `logo.png` bytes are identical, and `src/feature` has no files left;
     - the subject is `refactor(typescript move-files): src/feature/** from src/feature to src/deep/feature2`;
     - no errors in `src/user.ts`.
  2. `duplicate-files copies a folder and leaves outside importers on the originals`:
     - the same flags;
     - `src/user.ts` is unchanged, and the originals are unchanged;
     - the copies' internal imports are unchanged; their outside imports are adjusted as in 1;
     - the `.png` copy is byte-identical;
     - the summary says outside importers still use the originals.
  3. `an index folder import stays a folder import`: `"./feature"` in user.ts → `"./deep/feature2"`.
  4. `a pattern moves some files; the files left behind and the moved ones still find each other`
     (`--files 'src/feature/a.ts'`).
  5. `--to inside --from works` (`--from src/feature --to src/feature/v2`).
  6. `a JSDoc import type and a triple-slash reference follow the move`.
  7. Refusals: `rejects` with these codes and message fragments.
     - INVALID_ARGS:
       - no match;
       - a match outside `--from`;
       - `--from` equal to `--to`;
       - an existing destination (named);
       - a group containing `package.json` (named).
     - REFACTOR_UNAVAILABLE, with the tree unchanged:
       - an alias whose folder does not contain the new place (named, with line);
       - moving into a folder with its own tsconfig lacking `@/*`;
       - a relative import in a moved file that does not resolve;
       - a bare package specifier resolving into the group through `baseUrl`.
  8. `packages that do not resolve are left alone`: `import x from "left-pad"` in a moved file is
     unchanged.
  9. `a 50-file folder with 3000 importers moves in under 3 seconds`, generated in a temp repo like
     `bench-group.ts`. Assert `< 3000` ms of wall time around `main` (a loose bound for CI; aim for about
     1 s locally).
- [ ] **Step 2:** Run `sh scripts/test-packages.sh --test-name-pattern='move-files|duplicate-files'`.
  It fails because the action is unknown.
- [ ] **Step 3:** Implement `relocate.ts` and the two actions, and register them in `main.ts`.
- [ ] **Step 4:** Run the tests and the typecheck. All pass.
- [ ] **Step 5:** Commit: `typescript: move-files and duplicate-files`.

### Task 4: move-file and rename-files on the core

**Files:**
- Modify: `packages/engine-typescript/src/files.ts`. `applyFileMove` is replaced: `move-file` calls
  `relocate(engine, { mode: "move", moves: new Map([[file, to]]) })`.
- Modify: `packages/engine-typescript/src/rename-files.ts`. One `relocate` call with all the renames, not
  a loop.
- Test: the existing `actions.test.ts` (move-file), `rename-files.test.ts`, and `case-insensitive.test.ts`.

- [ ] **Step 1: Failing test** in `actions.test.ts`:
  `move-file keeps each import's extension form in a file that mixes them`. Use `a.ts` with
  `"../shared"`, `"../other.ts"` and `"./sub/b"`, and move it from `src/lib/a.ts` to `src/lib/deep/a.ts`.
  Expect `"../../shared"`, `"../../other.ts"` and `"../sub/b"`, with no `.ts` added.
- [ ] **Step 2:** Run it. It fails because TypeScript adds `.ts`.
- [ ] **Step 3:** Switch both actions to `relocate`. Keep their flags, summaries and kinds.
- [ ] **Step 4:** Run `sh scripts/test-packages.sh` (all package tests). All pass, except where an
  existing test pinned TypeScript's restyling. For each such test, change the expectation only when the
  new output keeps the old style and form. List every changed expectation in the commit body and in your
  report.
- [ ] **Step 5:** Commit: `typescript: move-file and rename-files use the relocate core`.

### Task 5: Docs, images and an end-to-end check

**Files:**
- Modify: `README.md`. Add rows for `move-files` and `duplicate-files` in the typescript table and the
  `refactor` row of the Kinds table, plus a short paragraph on what they refuse.
- Modify: `AGENTS.md`, only if it lists actions.

- [ ] **Step 1:** Update the docs.
- [ ] **Step 2:** Rebuild the images (`sh scripts/build-images.sh`) and run them on a copy of
  `examples/move-files` in a git repo:
  `jig --repo <copy> localhost/jig/typescript:local move-files --files 'src/feature/**' --from src/feature --to src/deep/feature2`.
  Expect `ok: true` and one commit. Then run `duplicate-files` the same way.
- [ ] **Step 3:** Commit: `README: move-files and duplicate-files`.
