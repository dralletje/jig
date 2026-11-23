# move-files and duplicate-files

> **Replaced (2026-11-23, at the owner's request):** `move-files` and `duplicate-files` were dropped in
> favour of one action, `duplicate-folder --from <folder> --to <folder>`, which copies every file under
> `--from` to a new folder `--to` (it must not exist, and must not be inside `--from`). There are no
> pattern-based actions any more. The relocate core below is unchanged and still backs `duplicate-folder`,
> `move-file` and `rename-files`; the `--files` parts of this document describe the removed actions.

## Why

The owner wants to copy or move a folder (more generally, a set of files picked by a pattern) and have
the imports follow:

- imports between the moved files keep pointing at each other at the new place;
- imports from the moved files to files outside the group are adjusted to the new location;
- outside files importing a moved file are updated (move only).

A duplicate leaves outside imports on the originals.

TypeScript's `getEditsForFileRename` was considered and set aside:

- it costs about 110 ms per file in a 3000-file project when files go one by one;
- it restyles specifiers (`"../shared"` becomes `"../../shared.ts"` when a file mixes styles);
- duplicate would be a move with edits thrown away.

Instead, this is our own algorithm. It is built on the TypeScript library (the parser and
`ts.resolveModuleName`), but with no program and no language service.

## Approaches considered

1. **TypeScript rename edits for move, our resolver for duplicate.** Two mechanisms that can disagree.
2. **TypeScript rename edits for both, plus a filter that restores each import's extension form.**
   - Fast for whole folders.
   - Slow for patterns (per-file).
   - Partly undoes TypeScript's choices.
3. **Our own algorithm for both (chosen).**
   - One pass over the imports, whatever the group's shape.
   - Duplicate is natural.
   - One rule set shared with the `imports-to-*` sweeps.
   - Explicit refusals.
   - It has to handle every reference kind itself.

## Decided

- It lives in the **typescript image** (the owner's call), next to `imports-to-*`.

- Two actions, both of kind **`refactor`**:
  - `move-files --files <globs> --from <folder> --to <folder>`
  - `duplicate-files --files <globs> --from <folder> --to <folder>`

- **Flags:**
  - `--files`: comma-separated globs from the repo root, as everywhere else. Every match must be
    under `--from`, or the action is refused.
  - A matched file `--from/x/y.ts` goes to `--to/x/y.ts`.
  - A whole-folder copy is `--files 'src/old/**' --from src/old --to src/new`.

- **The group** is every file the engine lists (the repo's files) matching `--files`, of any type: `.ts`,
  `.css`, `.json`, images.
  - Files that are not rewritten move or copy **byte for byte**. The engine's text overlay must not
    round-trip them through UTF-8.

- **Refused**, with INVALID_ARGS and before anything is written:
  - no match;
  - a match outside `--from`;
  - `--from` equal to `--to`;
  - a destination that already exists;
  - the group contains a `tsconfig*.json`, `jsconfig.json` or `package.json` (a first version;
    moving a config changes how everything under it resolves).

- **Importers scanned:**
  - move: every TS/JS source file in the repo (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`, `.d.ts`
    included, nothing under `node_modules`);
  - duplicate: only the copies.

- **References found** without a program, from `ts.createSourceFile`:
  - every form `importSpecifiers` in `import-style.ts` finds;
  - `/// <reference path>`;
  - import types and `@import` tags in JSDoc in JS files.

- **Resolution:** `ts.resolveModuleName` with the importer's project options.
  - Options come from the nearest tsconfig, parsed once per tsconfig, without building a program.
  - The resolution mode is the one the importer's file format implies.
  - A relative specifier that TypeScript does not resolve but that names an existing file exactly
    (`./styles.css`) resolves to that file.

- **For each reference** in importer `I` (new place `I'`) resolving to `T` (new place `T'`):
  - It is touched only when `I` or `T` moves. For duplicate, `T'` is the copy when `T` is in the group,
    else `T` itself.
  - **The style stays:**
    - relative stays relative (from `I'` to `T'`);
    - an alias stays the same `paths` key;
    - a subpath stays the same package.json `imports` key.
  - **The extension form stays:** file name, no extension, `.js` for `.ts`, or the index folder
    (`spelledPath`).
  - **The new specifier must resolve** from `I'` to `T'` in the world after the change:
    - a host that sees the moved files at their new paths and, for move, not at their old ones;
    - the options of `I'`'s nearest tsconfig.
  - A specifier whose text would not change is not edited.

- **Doubtful cases refuse the whole action** (REFACTOR_UNAVAILABLE), listing every problem with file,
  line, reason and what to do. A partial move would leave broken imports. The doubtful cases are:
  - a reference to rewrite that does not resolve;
  - a package-style specifier (bare name, `baseUrl`, workspace package) that resolves into the group;
  - an exact `paths`/`imports` key into the group;
  - "resolves by another path than it names";
  - an alias or subpath whose folder does not contain `T'`;
  - a new specifier that would not resolve to `T'`;
  - a quote that cannot hold the new text;
  - a moved source file that would leave the `include`/`files` of the tsconfig that covered it.
- **Packages never change.** A package that does not resolve (no `node_modules` in the image) is
  simply skipped.
- **No type-checking pass.** The resolution check is the safety net; speed is the point.
- tsconfig.json and package.json are **never edited**.
- **Summary:**
  - files moved or copied;
  - imports rewritten per file;
  - for duplicate, that outside importers still point at the originals.
- `move-file` and `rename-files` switch to the same core (one group of one file, or of the renamed
  files). This gives the owner's earlier "our own move-file" idea and fixes the extension restyling.
  Their flags stay the same. Their existing tests show any behaviour difference; differences are
  reported, not silently accepted.

## Speed target

A 50-file folder with 3000 outside importers moves in about a second, including loading. That is
measured with a benchmark like `bench-group.ts`.

## Left to the builder

- how the engine carries byte-exact copies;
- module layout (a `relocate.ts` core shared by the four actions);
- helpers shared with `import-style.ts` (move them to `shared.ts` rather than copying);
- how JSDoc references are walked.
