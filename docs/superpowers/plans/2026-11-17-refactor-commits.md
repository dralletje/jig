# jig v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Bun CLI that agents call to run a validated `rename` or `extract` refactor on a JS/TS repo and commit it as a reproducible commit co-authored by `codemodder`.

**Architecture:**
- The TypeScript language service (one per tsconfig in the repo) runs on top of a shared in-memory overlay of files. Actions mutate the overlay.
- The orchestrator (`run.ts`) then diffs the overlay against disk, writes the changes, runs validators, and either commits with replay trailers or restores the tree exactly.
- Actions, engines and validators are looked up by id from config, so new ones are one file each.

**Tech Stack:** Bun 1.3.13, TypeScript, `typescript@6.0.3` (bundled; pinned exactly), `node:util` `parseArgs`, `bun test`, git CLI via `Bun.spawn`.

**Spec:** `docs/superpowers/specs/2026-11-17-jig-design.md`

## Global Constraints

- No `.js` files anywhere in the project. Everything is `.ts`, run directly by Bun. `bin/jig` has no extension and starts with `#!/usr/bin/env bun`.
- Project `tsconfig.json` extends `["@dral/tsconfig/reasonable", "@dral/tsconfig/modern"]` (devDependency `@dral/tsconfig@1.8.0`) and adds `"types": ["bun-types"]` and `"include": ["src", "test/*.ts", "bin"]` (NOT `test/fixtures`). Consequences:
  - Relative imports carry the `.ts` extension.
  - Type-only imports use `import type` (`verbatimModuleSyntax`).
  - No enums, namespaces or parameter properties (`erasableSyntaxOnly`).
  - Indexed access may be `undefined` (`noUncheckedIndexedAccess`).
  - `package.json` has `"type": "module"`.
- `package.json` script `"typecheck": "tsc --noEmit"`. Every task's verification also runs `bun run typecheck` and expects no output and exit 0.

- Bundled TypeScript is exactly `typescript@6.0.3`. A target repo's own `typescript` is used only if its version is `>=5.2.0 <7.0.0`. TS 7 has no `createLanguageService`.
- Output is exactly one JSON object on stdout. Exit code 0 only when `ok: true`.
- Error codes (exact strings): `SYMBOL_NOT_FOUND`, `AMBIGUOUS_SYMBOL`, `VALIDATION_FAILED`, `DIRTY_WORKTREE`, `REFACTOR_UNAVAILABLE`, `ENGINE_CONFLICT`, `NO_CHANGES`, `UNKNOWN_ACTION`, `UNKNOWN_ENGINE`, `INVALID_ARGS`.
- Default co-author: `codemodder <codemodder@users.noreply.github.com>`.
- Commit trailers, in this order: `Refactor-Command`, `Refactor-Engine`, `Refactor-Tool`, `Co-Authored-By`.
- `Refactor-Command` is canonical JSON: keys sorted recursively, no whitespace. Shape: `{"action":…,"params":{…}}`.
- Repo-relative paths with `/` separators everywhere in data (params, changes, JSON output).
- Symbols addressed by file + name (+ optional `--kind`), top-level only. Kinds: `function|class|interface|type|enum|variable`.
- Deterministic: fixed format settings `ts.getDefaultFormatCodeSettings("\n")` and fixed preferences `{ allowTextChangesInNewFiles: true, providePrefixAndSuffixTextForRename: true, quotePreference: "auto" }`. Projects, files and edits are processed in sorted order.
- Never mix non-refactor content into the commit: refuse when `git status --porcelain` is non-empty.

## Review Focus

1. **Rename to a name that already exists in scope**: the type errors appear, so the result is `VALIDATION_FAILED` and the tree is byte-identical to before. Test in Task 6.
2. **Shorthand properties and re-exports** (`{ foo }`, `export { foo } from "./a"`): a rename keeps the external name stable where TS's prefix/suffix text says so (`{ foo: bar }`). Test in Task 3.
3. **Extract into an existing target file that already has imports and exports**: the moved code is appended, and importers point at the target. Test in Task 4.
4. **A validation failure after extract created a new file**: the new file is removed and modified files are restored. Test in Task 6.
5. **A symbol referenced from a file outside every tsconfig** (e.g. a `scripts/` file not in `include`): `VALIDATION_FAILED` with the coverage details, unless `ignoreUncovered` matches it. Test in Task 5.

Known v1 limitation (documented, not fixed): `extract` runs the move in the one project that owns the source file. Importers in *other* projects that reach the symbol through a package entry are not rewritten, and the typecheck validator rejects the result. Put this in the README.

---

## Reproducibility revision (supersedes conflicting text in all tasks below)

See the spec's "Reproducibility model" section.
- Action ids are `typescript-rename` and `typescript-extract`, and the CLI subcommands use the same names. Config keys under `actions` use the same ids. `DEFAULT_CONFIG.actions` = `{ "typescript-rename": {engine:"typescript", validators:["typecheck"]}, "typescript-extract": {engine:"typescript", validators:["typecheck"]} }`.
- Commit subject: `refactor(typescript-rename): foo → bar in a.ts`, and `refactor(typescript-extract): foo, keep → foo.ts from a.ts`.
- Trailers, in order: `Refactor-Command`, then `Co-Authored-By`. There is NO `Refactor-Engine` and NO `Refactor-Tool`.
- No hermetic mode (user: POC first, container later). Tasks 3–6 are built inline by the controller, as a POC, without per-task reviews (user: "take shortcuts").

## Monorepo layout (user request, supersedes paths below)

The project is a **pnpm workspace** (`pnpm-workspace.yaml`: `app`, `packages/*`). Packages are named `@jig/<dir>`, depend on each other with `workspace:*`, and have `"exports": { ".": "./src/index.ts" }` (TS source, no build, no .js). Root `tsconfig.base.json` holds the shared compiler options (extends `@dral/tsconfig` as in Global Constraints). Each package has its own `tsconfig.json` extending it, plus a `typecheck` script. Root scripts are `typecheck: pnpm -r typecheck` and `test: bun test`. Tests live in `<pkg>/test/*.test.ts`.

| Plan path below | Actual location |
|---|---|
| `src/errors.ts`, `src/config.ts`, `src/commit.ts`, shared types (`FileChange`, `Diag`, `Decl`, `DeclKind`, `Config`, `Action`, `Validator`, `ValidateCtx`, `ValidationResult`, new `Engine` interface) | `packages/core/src/*` |
| `src/git.ts` | `packages/git/src/index.ts` |
| `src/engines/typescript.ts`, `src/actions/rename.ts`, `src/actions/extract.ts` | `packages/engine-typescript/src/{engine,rename,extract}.ts` |
| `src/validators/{completeness,typecheck,command}.ts`, `src/changes.ts` (writeChanges) | `packages/validators/src/*` (writeChanges → `packages/git`) |
| registries (`engines/registry`, `actions/registry`, `validators/registry`), `src/run.ts`, `src/cli.ts`, `bin/jig` | `app/src/{registry,run,cli}.ts`, `app/bin/jig` |
| `test/helpers.ts`, `test/fixtures/*` | `packages/test-utils/src/index.ts`, `packages/test-utils/fixtures/*` |

`Engine` interface in core (TsEngine implements it; validators and app only see this):
`{ id: string; version: string; read(path): string | null; changes(): FileChange[]; projectFiles(): Set<string>; findTopLevel(file, name, kind?): Decl; diagnostics(): Diag[] }`.
`Action<P, E extends Engine = Engine>` has `run(engine: E, p: P)`. `ValidateCtx.engineBefore` / `reloadEngine()` are typed as `Engine`.

## File Structure

```
package.json            name jig, version 0.1.0, bin, deps: typescript 6.0.3 (exact)
tsconfig.json           strict, module esnext, moduleResolution bundler, types ["bun-types"]
bin/jig    #!/usr/bin/env bun → import "../src/cli.ts"
src/errors.ts           RefactorError + ErrorCode
src/git.ts              git helpers
src/config.ts           .jig.json loading + defaults
src/engines/typescript.ts   TsEngine (projects, overlay, symbol lookup, rename, move, diagnostics)
src/engines/registry.ts     loadEngine(id, repoRoot, config)
src/actions/types.ts        Action interface
src/actions/rename.ts
src/actions/extract.ts
src/actions/registry.ts
src/validators/types.ts     Validator interface
src/validators/completeness.ts   (incl. coverage)
src/validators/typecheck.ts
src/validators/command.ts
src/validators/registry.ts
src/commit.ts           canonicalJson, formatCommitMessage, parseRefactorCommand
src/run.ts              orchestrator
src/cli.ts              argv → run → JSON
test/helpers.ts         makeRepo(fixture), readTree(dir)
test/fixtures/simple/   tsconfig.json, global.d.ts, a.ts, b.ts, c.tsx, scripts/tool.ts (excluded from tsconfig)
test/fixtures/monorepo/ packages/core/{tsconfig.json,src/index.ts,src/util.ts}, packages/app/{tsconfig.json,src/main.ts} (app imports core via "paths" alias "@core/*" → ../core/src/*)
test/*.test.ts
README.md
```

---

### Task 1: Scaffold, errors, git helpers, test helpers

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore` (node_modules), `bin/jig`, `src/errors.ts`, `src/git.ts`, `test/helpers.ts`, `test/fixtures/simple/**`, `test/git.test.ts`

**Interfaces:**
- Produces:
  - `type ErrorCode = "SYMBOL_NOT_FOUND" | … (list in Global Constraints)`
  - `class RefactorError extends Error { code: ErrorCode; details?: unknown; constructor(code, message, details?) }`
  - `git(repo: string, args: string[], opts?: { stdin?: string }): Promise<string>`. It returns stdout and throws an `Error` with stderr on a non-zero exit.
  - `assertClean(repo): Promise<void>`. Throws `DIRTY_WORKTREE` with `details: string[]` (porcelain lines).
  - `headCommit(repo): Promise<string>`
  - `restore(repo: string, createdPaths: string[], createdDirs: string[]): Promise<void>`. Runs `git checkout -- .`, deletes `createdPaths`, then removes `createdDirs` (deepest first) if they are empty.
  - `commitPaths(repo, paths: string[], message: string): Promise<string>`. Runs `git add -A -- <paths>` then `git commit -F -` with the message on stdin, and returns the new HEAD sha.
  - `diff(repo): Promise<string>`. Runs `git diff` against HEAD, including intent-to-add for new files. Run `git add -N` on the created paths first, then reset them afterwards.
  - `trackedFiles(repo): Promise<string[]>` (`git ls-files`, sorted)
  - test: `makeRepo(fixture: string): Promise<string>`. Copies `test/fixtures/<fixture>` to a fresh temp dir, runs `git init -b main`, sets local `user.name=Test`/`user.email=test@example.com`, and makes an `init` commit.
  - test: `readTree(dir): Promise<Record<string,string>>`. Maps every non-`.git` file path to its content.

- [ ] **Step 1:** Run `bun init`-equivalent by hand. Write `package.json` with `"bin": {"jig": "bin/jig"}`, `"dependencies": {"typescript": "6.0.3"}` and `"devDependencies": {"bun-types": "*"}`, then run `bun install`. Write fixture `simple`:
  - `tsconfig.json`: `include: ["*.ts","*.tsx"]`, `jsx: "preserve"`, `strict`, `noEmit`.
  - `global.d.ts`: `declare namespace JSX { interface IntrinsicElements { [k: string]: any } }`.
  - `a.ts`: `export function foo()`, `export function helper()`, `export const keep = 1`, `export interface Shape {}`, `export type Shape2 = Shape`, `export const shared = 1`, `export interface shared {}`.
  - `b.ts`: imports `foo`, `keep`; contains `const o = { foo }`; `export { foo as renamedFoo } from "./a"`.
  - `c.tsx`: imports and uses `foo` in JSX.
  - `scripts/tool.ts`: mentions `foo` in an import from `"../a"`.
- [ ] **Step 2: Write failing tests** in `test/git.test.ts`:
  - `assertClean passes on fresh repo`
  - `assertClean throws DIRTY_WORKTREE on modified file and on untracked file`: `expect(err.code).toBe("DIRTY_WORKTREE")`
  - `restore puts modified files back and removes created files`: compare `readTree` before vs after
  - `commitPaths creates a commit with exact message`: `git log -1 --format=%B` equals the message plus `\n`
- [ ] **Step 3:** Run `bun test test/git.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 4:** Implement `src/errors.ts` and `src/git.ts` per Interfaces, and `test/helpers.ts`.
- [ ] **Step 5:** Run `bun test test/git.test.ts`. Expected: all PASS.
- [ ] **Step 6:** Commit: `feat: scaffold, git helpers, test fixtures`.

### Task 2: Config + TypeScript engine core (projects, overlay, symbol lookup, diagnostics)

**Files:**
- Create: `src/config.ts`, `src/engines/typescript.ts`, `src/engines/registry.ts`, `test/fixtures/monorepo/**`, `test/config.test.ts`, `test/engine.test.ts`

**Interfaces:**
- Consumes: `RefactorError`, `trackedFiles`.
- Produces:
  ```ts
  type ValidatorSpec = string | { command: string };
  interface ActionConfig { engine: string; validators: ValidatorSpec[] }
  interface Config { coAuthor: string; tsconfigs: string[] | null; ignoreUncovered: string[]; actions: Record<string, ActionConfig> }
  loadConfig(repo: string): Promise<Config>   // defaults merged per action
  const DEFAULT_CONFIG: Config  // coAuthor as Global Constraints; tsconfigs null; ignoreUncovered [];
                                // actions.rename = { engine:"typescript", validators:["typecheck"] }, same for extract
  type DeclKind = "function"|"class"|"interface"|"type"|"enum"|"variable";
  interface Decl { file: string; name: string; kind: DeclKind; nameStart: number; start: number; end: number }  // start/end = full statement incl. leading trivia excluded
  interface FileChange { path: string; before: string | null; after: string | null }
  interface Diag { file: string | null; code: number; start: number }
  class TsEngine {
    readonly ts: typeof import("typescript"); readonly version: string; readonly repoRoot: string;
    static load(repoRoot: string, config: Config): Promise<TsEngine>;
    projectFiles(): Set<string>;                 // repo-relative union of all programs' source files (non-node_modules)
    projectsContaining(file: string): Project[];  // program.getSourceFile(abs) exists; sorted by tsconfig path
    ownerProject(file: string): Project;         // containing project whose tsconfig dir is the deepest ancestor of file
    findTopLevel(file: string, name: string, kind?: DeclKind): Decl;  // throws SYMBOL_NOT_FOUND / AMBIGUOUS_SYMBOL (details: Decl[] without positions → {name, kind, line})
    read(file: string): string | null;           // overlay, then disk
    write(file: string, content: string | null): void;  // overlay; null = delete; bumps script version
    applyTextChanges(changes: readonly import("typescript").FileTextChanges[]): void;  // sorted spans, applied end→start
    changes(): FileChange[];                      // overlay vs disk, only real differences, sorted by path
    diagnostics(): Diag[];                        // syntactic+semantic over all projects, deduped by file+start+code
  }
  type Project = { tsconfig: string; service: import("typescript").LanguageService }
  ```
  - `engines/registry.ts`: `loadEngine(id: string, repo: string, config: Config): Promise<TsEngine>`. Unknown id → `UNKNOWN_ENGINE`.

- [ ] **Step 1:** Add fixture `monorepo`:
  - `packages/core/tsconfig.json`: includes `src`.
  - `packages/core/src/util.ts`: `export function formatName(…)`.
  - `packages/core/src/index.ts`: `export * from "./util"`.
  - `packages/app/tsconfig.json`: `paths: {"@core/*": ["../core/src/*"]}`, `baseUrl: "."`, includes `src`.
  - `packages/app/src/main.ts`: `import { formatName } from "@core/util"` and uses it.
- [ ] **Step 2: Write failing tests:**
  - `config.test.ts`:
    - `defaults when no file`: `toEqual(DEFAULT_CONFIG)`.
    - `merges per-action override`: a file setting `actions.extract.validators` to `["typecheck",{"command":"true"}]` keeps the rename defaults.
  - `engine.test.ts`:
    - `loads bundled TS 6.0.3 when repo has none`: `engine.version === "6.0.3"`.
    - `findTopLevel finds function`: kind is `"function"`, and `read(file).slice(d.nameStart, d.nameStart+3) === "foo"`.
    - `findTopLevel ambiguous for shared`: `AMBIGUOUS_SYMBOL`, and `kind:"variable"` resolves it.
    - `findTopLevel missing`: `SYMBOL_NOT_FOUND`.
    - `monorepo: core/src/util.ts is contained by both projects`: `projectsContaining("packages/core/src/util.ts").length === 2`, and `ownerProject` is the core one.
    - `overlay write shows in changes()`: then `write` back the original content and expect `changes()` to be `[]`.
    - `diagnostics empty on clean fixtures`: `toEqual([])` for both fixtures.
- [ ] **Step 3:** Run `bun test test/config.test.ts test/engine.test.ts`. Expected: FAIL.
- [ ] **Step 4:** Implement.
  - TS resolution: `createRequire(join(repo,"package.json")).resolve("typescript")`. If found, read the version from its `package.json`; use it if in `[5.2,7)`, otherwise use the bundled `typescript`.
  - Tsconfig discovery: `config.tsconfigs` (matched with `Bun.Glob` against `trackedFiles`), else every tracked file matching `**/tsconfig*.json` that is not under `node_modules`.
  - Each project: `getParsedCommandLineOfConfigFile`, plus a `LanguageServiceHost` that reads through the shared overlay. Script versions come from one per-file counter.
  - Variable statements give one `Decl` per identifier-named declaration, with the statement's span.
- [ ] **Step 5:** Run the same command. Expected: PASS.
- [ ] **Step 6:** Commit: `feat: config and TypeScript engine core`.

### Task 3: Action interface + rename

**Files:**
- Create: `src/actions/types.ts`, `src/actions/rename.ts`, `src/actions/registry.ts`, `test/rename.test.ts`

**Interfaces:**
- Consumes: `TsEngine`, `Decl`, `RefactorError`.
- Produces:
  ```ts
  interface Action<P extends Record<string, unknown>> {
    id: string;
    parseParams(raw: Record<string, string | undefined>): P;   // INVALID_ARGS on missing/bad
    describe(p: P): string;             // commit subject, e.g. "refactor(rename): foo → bar in a.ts"
    run(engine: TsEngine, p: P): Promise<void>;   // mutates engine overlay
    symbolNames(p: P): string[];        // for coverage
    fileAliases(p: P): Record<string, string>;    // for typecheck mapping (target → source)
  }
  type RenameParams = { file: string; symbol: string; to: string; kind?: DeclKind };
  type ExtractParams = { file: string; symbols: string[]; to: string; kind?: DeclKind };
  getAction(id: string): Action<any>    // UNKNOWN_ACTION
  ```
  - Raw keys from CLI: rename uses `file`, `symbol`, `to`, `kind`. Extract uses `file`, `symbols` (comma-separated → `string[]`, trimmed, order kept), `to`, `kind`. Params objects omit `kind` when absent, so the recorded command stays canonical.
  - `to` for rename must match `/^[A-Za-z_$][\w$]*$/`, otherwise `INVALID_ARGS`.

- [ ] **Step 1: Write failing tests** (operate on the engine directly, assert on `engine.read`):
  - `renames definition and all uses across .ts and .tsx`: after renaming `foo` → `bar`, `a.ts`, `b.ts` and `c.tsx` contain no `\bfoo\b` except `renamedFoo` and the shorthand case below.
  - `shorthand property keeps property name`: `b.ts` contains `{ foo: bar }`.
  - `re-export alias stays`: `b.ts` contains `export { bar as renamedFoo } from "./a"`.
  - `monorepo: rename formatName updates app via paths alias`: `packages/app/src/main.ts` imports `formatName`'s new name.
  - `file in no project → REFACTOR_UNAVAILABLE`: renaming in `scripts/tool.ts` gives `REFACTOR_UNAVAILABLE` with the message `file not in any tsconfig project`. The same code is used when `getRenameInfo().canRename` is false.
  - `describe` gives `refactor(rename): foo → bar in a.ts`.
- [ ] **Step 2:** Run `bun test test/rename.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `rename.run`:
  - `findTopLevel`.
  - For each project in `projectsContaining(file)`, check `getRenameInfo(...).canRename`, then call `findRenameLocations(abs, nameStart, false, false, prefs)`.
  - Merge the locations keyed by `file:start:length`. The same key with different `prefixText+to+suffixText` gives `ENGINE_CONFLICT`.
  - Convert to `FileTextChanges` and call `engine.applyTextChanges`.
  - `fileAliases` returns `{}`.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: rename action`.

### Task 4: Extract action

**Files:**
- Create: `src/actions/extract.ts`, `test/extract.test.ts`
- Modify: `src/actions/registry.ts` (register)

**Interfaces:**
- Consumes: `Action`, `ExtractParams`, `TsEngine`.
- Produces: the registered action `extract`. `fileAliases(p)` returns `{ [p.to]: p.file }`.

- [ ] **Step 1: Write failing tests:**
  - `moves one function to a new file and rewires importers`:
    - `read("a.ts")` has no `function foo`.
    - `read("foo.ts")` contains `export function foo`.
    - `b.ts` imports `foo` from `"./foo"` and still imports `keep` from `"./a"`.
    - `c.tsx` is updated.
  - `moves two non-adjacent symbols (foo, keep) into same new file in given order`: `foo.ts` contains both, `foo` first.
  - `moves into an existing file with its own imports`: target `c.tsx` is the wrong kind, so add fixture file `d.ts` (`import { keep } from "./a"; export const d = keep;`) and move `helper` into it. `d.ts` keeps its original lines, has `helper` appended, and has no duplicate imports.
  - `moved code that depends on remaining symbol gets an import`: moving `foo` (which calls `helper`) gives `foo.ts`, which imports `helper` from `"./a"`.
  - `REFACTOR_UNAVAILABLE when Move to file not offered`: e.g. symbol `Shape2`'s target equals source file `a.ts`.
  - `describe`: `refactor(extract): foo, keep → foo.ts from a.ts`.
- [ ] **Step 2:** Run `bun test test/extract.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. For each symbol in order:
  - Re-run `findTopLevel` on the current overlay.
  - Get the range `{pos: decl.start, end: decl.end}`.
  - Use `ownerProject(file).service.getEditsForRefactor(abs, fmt, range, "Move to file", "Move to file", prefs, undefined, { targetFile: abs(to) })`.
  - Missing or empty result gives `REFACTOR_UNAVAILABLE`.
  - Apply with `applyTextChanges`. Edits on new files (`isNewFile`) start from `""`.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: extract action`.

### Task 5: Validators

**Files:**
- Create: `src/validators/types.ts`, `completeness.ts`, `typecheck.ts`, `command.ts`, `registry.ts`, `test/validators.test.ts` (tests pass `Config` objects directly)

**Interfaces:**
- Consumes: `TsEngine`, `Action`, `Config`, `FileChange`, `trackedFiles`.
- Produces:
  ```ts
  interface ValidateCtx { repo: string; config: Config; action: Action<any>; params: any; changes: FileChange[];
                          engineBefore: TsEngine; reloadEngine(): Promise<TsEngine> }  // reload reads disk after changes were written
  interface ValidationResult { id: string; ok: boolean; details?: unknown }
  interface Validator { id: string; before?(ctx: ValidateCtx): Promise<void>; after(ctx: ValidateCtx): Promise<ValidationResult> }
  makeValidators(specs: ValidatorSpec[]): Validator[]   // always prepends completeness; "typecheck" | {command}; unknown → INVALID_ARGS
  ```
  - completeness, `after`:
    - The rename found a change. Extract: none of `symbols` is a top-level decl in `file`, and all of them are in `to`.
    - Coverage: every tracked `.ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs` file that is not in `engineBefore.projectFiles()`, does not match any `ignoreUncovered` glob, and whose *pre-change* content matches `\b<name>\b` for any `symbolNames`. Any such file fails, with `details: { uncovered: string[] }`.
  - typecheck:
    - `before` stores `engineBefore.diagnostics()`.
    - `after` uses `reloadEngine().diagnostics()`, mapping each file through `action.fileAliases(params)`.
    - Key `${file}:${code}`, compared as a multiset. It fails if any key's count rose, with `details: { newErrors: {file, code, line, message}[] }`.
  - command: runs `sh -c <command>` in `repo` and fails on a non-zero exit, with `details: { exitCode, output }` (last 4000 chars).

- [ ] **Step 1: Write failing tests:**
  - `coverage flags scripts/tool.ts for foo`: `ok: false`, `details.uncovered` equals `["scripts/tool.ts"]`.
  - `coverage passes with ignoreUncovered ["scripts/**"]`.
  - `typecheck passes for a clean rename`: apply rename `foo` → `bar`, write the changes to disk, run validators.
  - `typecheck fails with new error`: write a bad file change manually (`a.ts` gets `const x: number = "s"`). `ok: false` and `newErrors[0].code === 2322`.
  - `command validator fails on "exit 3"`: `details.exitCode === 3`.
- [ ] **Step 2:** Run `bun test test/validators.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement per Interfaces.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: validators`.

### Task 6: Commit format, orchestrator, CLI, reproducibility

**Files:**
- Create: `src/commit.ts`, `src/run.ts`, `src/cli.ts`, `bin/jig` (already scaffolded; make it import cli), `test/commit.test.ts`, `test/run.test.ts`, `test/cli.test.ts`, `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces:
  ```ts
  canonicalJson(v: unknown): string
  formatCommitMessage(o: { subject: string; message?: string; command: { action: string; params: unknown };
                           engine: string; tool: string; coAuthor: string }): string
  parseRefactorCommand(commitMessage: string): { action: string; params: Record<string, unknown> } | null
  interface RunOptions { repo: string; action: string; params: Record<string, unknown>; dryRun?: boolean; message?: string }
  type RunResult = { ok: true; action: string; commit: string | null; parent: string; filesChanged: string[];
                     validation: ValidationResult[]; diff?: string }
  run(o: RunOptions): Promise<RunResult>   // throws RefactorError
  ```
  - Commit message layout: subject, blank line, `message` paragraph plus blank line only if given, then the trailers (one per line), ending in `\n`. Format: `Refactor-Engine: typescript@<engine.version>`, `Refactor-Tool: jig@<package.json version>`.
  - `run` takes **already-parsed params**, so a replay can pass `parseRefactorCommand(...).params` directly. The CLI calls `action.parseParams(raw)` and then `run`.
  - Order of `run`:
    1. `assertClean`
    2. `loadConfig`
    3. `getAction`
    4. `loadEngine(actionConfig.engine)`
    5. `makeValidators`
    6. Each `before`
    7. `action.run`
    8. `changes()`. Empty → `NO_CHANGES`.
    9. Write the changes to disk, recording created files and dirs.
    10. Each `after`. On any failure: `restore`, then throw `VALIDATION_FAILED` with `details: ValidationResult[]`.
    11. Dry-run: `diff`, then `restore`, then return `commit: null`.
    12. Otherwise `commitPaths(changedPaths, formatCommitMessage(...))`.
  - Any unexpected throw after step 9 also restores before rethrowing.
  - CLI:
    - `parseArgs` with options `file`, `symbol`, `symbols`, `to`, `kind`, `repo`, `dry-run`, `message`. The positional is the action.
    - It prints `JSON.stringify(result)`, or `{ ok:false, error:{code,message,details} }` for a `RefactorError`. Any other error prints code `"INTERNAL"`.
    - Exit 1 on failure.

- [ ] **Step 1: Write failing tests:**
  - `commit.test.ts`:
    - `canonicalJson sorts nested keys`: `canonicalJson({b:1,a:{d:1,c:2}}) === '{"a":{"c":2,"d":1},"b":1}'`.
    - `round-trip`: `parseRefactorCommand(formatCommitMessage(x))` deep-equals `x.command`.
    - `trailer order exact`: the last four lines match the Global Constraints order, and the last line is `Co-Authored-By: codemodder <codemodder@users.noreply.github.com>`.
  - `run.test.ts` (with `makeRepo`; `simple` needs `ignoreUncovered` passed through a committed `.jig.json` in that test's repo, so make a second fixture `simple-config` = simple + `{"ignoreUncovered":["scripts/**"]}`):
    - `rename creates one commit with trailers, tree clean after`: `git status --porcelain` is empty, and `parseRefactorCommand(git log -1 --format=%B)` equals `{action:"rename",params:{file:"a.ts",symbol:"foo",to:"bar"}}`.
    - `reproducible`: run rename to get commit X, then `git checkout --detach X~1`, then `run({... parsed command})` to get Y. `git rev-parse X^{tree}` equals `Y^{tree}`. Same for extract `foo,keep` → `foo.ts`.
    - `dirty worktree refused`: `DIRTY_WORKTREE`, and HEAD is unchanged.
    - `dry-run leaves tree and HEAD unchanged and returns diff containing "+export function foo"` (extract case).
    - Review Focus 1: renaming `foo` → `helper` gives `VALIDATION_FAILED`, `readTree` is identical to before, and HEAD is unchanged.
    - Review Focus 4: extract `foo` → `foo.ts` with a config whose extract validators include `{command:"exit 1"}`. Result is `VALIDATION_FAILED`, `foo.ts` does not exist, and `readTree` is identical.
    - `detached HEAD works`.
  - `cli.test.ts`, spawning `bun bin/jig`:
    - `prints ok JSON`: `rename --repo <r> --file a.ts --symbol foo --to bar` parses to `ok:true`, with `commit` as a 40-char sha, and exit code 0.
    - `prints error JSON`: `--symbol nope` gives exit 1 and `error.code === "SYMBOL_NOT_FOUND"`.
    - `unknown action`: `UNKNOWN_ACTION`.
- [ ] **Step 2:** Run `bun test`. Expected: the new tests FAIL and the earlier ones PASS.
- [ ] **Step 3:** Implement `commit.ts`, `run.ts` and `cli.ts`.
- [ ] **Step 4:** Run `bun test`. Expected: all PASS.
- [ ] **Step 5:** Write `README.md`:
  - Purpose.
  - Both commands with examples.
  - The JSON output and the error codes.
  - The config file example (from the spec).
  - The commit format.
  - The extract cross-project limitation (Review Focus note).
  - The TODO list from the spec.
- [ ] **Step 6:** Smoke-test on a real repo, without committing: `bun bin/jig rename --repo ~/repos/hydra --file <some tracked .ts file> --symbol <a top-level name> --to <name>Renamed --dry-run`. Expected: `ok:true`, and `git -C ~/repos/hydra status --porcelain` is unchanged afterwards. Report the result (including runtime) and do not fix scope beyond v1.
- [ ] **Step 7:** Commit: `feat: orchestrator, CLI, commit format`.
