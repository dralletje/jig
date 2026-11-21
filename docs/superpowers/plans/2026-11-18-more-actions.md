# More Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an action kind (refactor, sweep or rewrite) traced in commits, example repos, eleven new typescript-image actions, and published-codemod images.

**Architecture:**
- Actions follow the existing `Action` pattern in `packages/engine-typescript` and the `main.ts` registry.
- Sweeps take `--files`; targeted refactors take `--file --symbol`.
- Kinds flow from the image report to the commit's `Refactor-Kind` trailer.
- Codemod images reuse the image contract with a small `packages/action-codemod` entrypoint.

**Tech Stack:** TypeScript on Node 26.13.1 (type stripping, `node:test`), TypeScript 6.0.3 language service, Swift 6.4.2 (host, integration tests), docker, POSIX sh. For codemods: jscodeshift plus one pinned codemod package.

**Spec:** `docs/superpowers/specs/2026-11-18-more-actions-design.md`. Every action's exact behaviour, refusals and kind are defined there. The image contract and host behaviour are in the earlier specs in `docs/superpowers/specs/`.

## Global Constraints

- **No Bun.** Node 26.13.1 is at `~/.local/share/node/node-v26.13.1-linux-x64/bin` and Swift 6.4.2 at `~/.local/share/swiftly/toolchains/6.4.2/usr/bin`; neither is on PATH. Docker is rootless. Do not add rules or text about symlinks created by images (AGENTS.md).
- **TypeScript source:** erasable syntax only, `.ts` import extensions, `import type`.
- **Processes:** argument arrays only, never a shell. Shell scripts are POSIX sh and pass shellcheck.
- **Action ids, flags, kinds and subjects:** exactly as the spec names them. The subject format is `<kind>(<action id>): <description>`.
- **Determinism:** process files, edits and listings in sorted order, so the same input always gives the same output (replay must hold).
- **Refusals:** each action refuses with `REFACTOR_UNAVAILABLE` and a specific reason rather than produce a wrong result. Sweeps never refuse the whole run for one bad file unless the spec says so; skipped items go in report details.
- **Verification:** every task ends with `pnpm typecheck` (exit 0), `sh scripts/test-packages.sh` (all pass), and `swift test` in `host/` (all pass, integration included).
- **Branch:** one feature branch; each task commits with a message ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Inlining must preserve evaluation order and bindings.** Covered by tests in Task 7:
   - an argument with side effects used twice;
   - an argument evaluated before other parts of the enclosing expression;
   - a body local that shadows a call-site name;
   - a free variable shadowed at the call site.
2. **Barrel removal with aliased re-exports** (`export { a as b }`), `export *` chains, and a name re-exported by two barrels. Covered in Task 2.
3. **Import rewrites keep side-effect imports** (`import "./x"`) and type-only imports intact, and never merge a type and a value import wrongly. Covered in Tasks 2, 3, 4, 9.
4. **Sweeps leave files outside `--files` untouched, except importers that must change** (spec per action). Covered in each sweep task.
5. **Replay:** every new action gives the same tree when run twice from the same parent. One Swift integration replay test per image (Tasks 1 and 12).

---

### Task 1: Action kinds and example repos

- **Files:**
  - core: `Report` gains `kind`; the `Action` type gains a `kind` field; `main.ts` reports `action.kind`.
  - The existing actions get their kinds and prefixes: rename, extract, lift-out and move-file are `refactor`; organize-imports and format are `sweep`.
  - host Swift: `ImageReport.ok(subject:kind:)`, the `Refactor-Kind` trailer in `commitMessage`, and `kind` in `successJSON`.
  - `examples/webapp`, `examples/monorepo`, `examples/react-app` (initial versions per the spec).
  - `makeRepo` accepts `examples/<name>`, and so does the Swift integration fixture helper.
  - README sections on kinds and examples.
- **Tests:**
  - Swift unit tests: a missing kind gives `refactor`; an invalid kind gives `IMAGE_FAILED`; the trailer order is `Refactor-Command`, `Refactor-Kind`, `Co-Authored-By`.
  - Integration: a rename commit carries `Refactor-Kind: refactor`; a format commit carries `Refactor-Kind: sweep` and a subject starting with `sweep(format):`.
  - Every existing test that checks a sweep subject is updated.
- **Commit:** `feat: action kinds (refactor/sweep/rewrite) and example repos`.

### Task 2: typescript-remove-barrels

- **Behaviour:** spec item 1. Put the action in its own file, `packages/engine-typescript/src/barrels.ts`.
- **Examples:** `webapp` gains nested barrels, an aliased re-export, `export *` chains, a barrel that also declares code, a side-effect import and a type-only import through a barrel. `monorepo` gains a cross-package barrel that must be left alone.
- **Tests:** exact rewritten imports; barrels deleted only when nothing imports them; Review Focus 2 and 3; a second run gives `NO_CHANGES`.
- **Commit:** `feat(refactor): typescript-remove-barrels` (kind `refactor`, decided by the user).

### Task 3: typescript-add-import-extensions

- **Behaviour:** spec item 2, in its own file.
- **Tests:**
  - `./a` → `./a.ts`, `./dir` → `./dir/index.ts`, `.tsx` targets, and `export … from` and dynamic `import("./x")` with a string literal.
  - The tsconfig flag is set when needed; the action refuses when neither `noEmit` nor `emitDeclarationOnly` is set.
  - A second run gives `NO_CHANGES`.
- **Commit:** `feat(sweep): typescript-add-import-extensions`.

### Task 4: typescript-subpath-imports

- **Behaviour:** spec item 3, in its own file.
- **Tests:**
  - `@/x` → `#/x`, with `package.json` `imports` added and merged with existing keys.
  - An alias whose target is outside the package folder is refused.
  - With and without extensions present.
  - The `paths` entry is untouched.
- **Commit:** `feat(sweep): typescript-subpath-imports`.

### Task 5: typescript-default-to-named

- **Behaviour:** spec item 4, in its own file.
- **Tests:**
  - A function, class and const default export become named.
  - Importers use a named import, with `as` where the local name differs.
  - Re-exports of a default (`export { default } from`, `export { default as X } from`) are rewritten.
  - An anonymous default is refused and listed; `--keep` files are skipped.
- **Commit:** `feat(sweep): typescript-default-to-named`.

### Task 6: typescript-params-to-object

- **Behaviour:** spec item 5, in its own file.
- **Tests:**
  - A function with three params called from two files: the declaration and both calls are rewritten.
  - Optional and default params are handled.
  - Refusals: used as a callback value, overloads, rest param.
- **Commit:** `feat(refactor): typescript-params-to-object`.

### Task 7: typescript-inline-function

- **Behaviour:** spec item 6, in its own file (`inline.ts`). This is the hardest task: implement it exactly as the spec's safety rules say, and refuse anything outside them.
- **Tests:**
  - **Single-expression bodies:** inlined in an expression position with parentheses where needed; simple arguments substituted.
  - **Multi-statement bodies:** inlined at an expression statement, at a `const x = f()` and at a `return f()`.
  - **Review Focus 1:**
    - A side-effecting argument used twice is hoisted to one `const`, so it is evaluated once.
    - A call in `a() + f(b())` with a non-simple argument is left (it is not the first thing evaluated) and listed.
    - A body local is renamed when it clashes at the call site.
    - When a free variable is shadowed at the call site, that call site is left.
  - **Refusals:** recursive, `this`, `arguments`, early `return`, async, generator.
  - **Two modes, all or nothing:**
    - One call (`--at path:line[:col]`) unpacks that call, keeps the declaration, and fails with `REFACTOR_UNAVAILABLE` (nothing written) when that call is unsafe.
    - Definition mode (`--file --symbol`) unpacks every call and removes the declaration. It fails with `REFACTOR_UNAVAILABLE` listing every blocking use when the function is exported, is used other than as a direct call, or has any unsafe call.
    - There is no partial result in either mode.
- **Commit:** `feat(refactor): typescript-inline-function`.

### Task 8: typescript-infer-return-types

- **Behaviour:** spec item 7, in its own file.
- **Tests:**
  - Exported functions and methods gain the inferred types.
  - Non-exported ones are skipped by default; `--exported-only false` includes them.
  - Skipped and listed: a type containing an unwritten `any`, and an `import("…")` type that would need a new import.
- **Commit:** `feat(sweep): typescript-infer-return-types`.

### Task 9: typescript-namespace-to-named and typescript-import-type

- **Behaviour:** spec items 8 and 9, in one file for import-shape rewrites (`imports.ts`).
- **Tests:**
  - namespace-to-named: converted where only `x.name` is used; skipped where `x` is used on its own; clashes renamed.
  - import-type: whole imports and individual specifiers; mixed imports split correctly; side-effect imports untouched.
- **Commit:** `feat(sweep): typescript-namespace-to-named and typescript-import-type`.

### Task 10: typescript-rename-files

- **Behaviour:** spec item 10, in its own file, reusing move-file's edit logic.
- **Tests:**
  - All four cases (kebab, camel, pascal, snake).
  - Importers rewritten.
  - `index.*` skipped; a collision skipped and listed.
  - A second run gives `NO_CHANGES`.
- **Commit:** `feat(sweep): typescript-rename-files`.

### Task 11: typescript-remove-console

- **Behaviour:** spec item 11, kind `rewrite`, subject `rewrite(typescript-remove-console): …`.
- **Tests:**
  - A statement `console.log(...)` is removed.
  - A `console.log` used as a value is kept and listed.
  - `--methods log,debug` covers both methods.
  - Comments on the removed line are handled without leaving stray blank lines.
- **Commit:** `feat(rewrite): typescript-remove-console`.

### Task 12: Published codemod images

- **Files:**
  - `packages/action-codemod` (entrypoint per the spec).
  - `containers/codemod-<name>/Containerfile` for one pinned React codemod package that runs offline. Record the package and version in the README.
  - `scripts/build-images.sh` builds it.
  - `examples/react-app` gets code the transform changes.
- **Tests:**
  - Node unit tests of the entrypoint's argument handling and its file matching.
  - The image carries a table of transform → kind, chosen by what each transform does; tests check that the reported kind matches it.
  - Swift integration: run the codemod image on `examples/react-app` through the binary, with the transform's `Refactor-Kind` and replay to the same tree.
  - An unknown `--transform` is `INVALID_ARGS`.
- **Commit:** `feat: published codemod images (codemod-<name>)`.

### Task 13: typescript-template-string

- **Behaviour:** spec item 12, kind `refactor`. Shares an `--at` position parser with Tasks 14 and 15: put `parseAt(raw): { path, line, column? }` and `nodeAt(engine, at, predicate)` in `shared.ts`, which errors when there are zero or several candidates and no column is given.
- **Tests:**
  - `"Hi " + name + "!"` becomes `` `Hi ${name}!` ``.
  - Nested parentheses and a number operand are handled.
  - Refused: at a position with no concatenation, or where TypeScript does not offer it.
  - A line with two concatenations without a column is `INVALID_ARGS`; with a column it works.
- **Commit:** `feat(refactor): typescript-template-string`.

### Task 14: typescript-remove-unused-variable

- **Behaviour:** spec item 13, kind `refactor`.
- **Tests:**
  - Removes a single declarator, one declarator of several, and one destructured element.
  - Refusals: a referenced variable, an exported or module-level variable, a parameter, and an initializer with a call (side effect).
  - Leaves no blank-line debris.
- **Commit:** `feat(refactor): typescript-remove-unused-variable`.

### Task 15: typescript-convert-function

- **Behaviour:** spec item 14, kind `refactor`, `--to arrow|function`.
- **Tests:**
  - `--to arrow`: a declaration becomes a `const` arrow; a function expression becomes an arrow. Refusals: `this`, `arguments`, a generator, `new` usage, overloads, a default export, use before the declaration.
  - `--to function`: an arrow `const` becomes a declaration, keeping generics, parameter and return types. Refusals: `this`/`arguments` in the arrow, a type-annotated variable, multiple declarators.
  - Round trip: `--to arrow` then `--to function` gives the original text for a simple function.
- **Commit:** `feat(refactor): typescript-convert-function`.
