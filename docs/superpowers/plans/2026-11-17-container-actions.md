# Code Actions as Container Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The code actions run as container images, one per tool (`typescript`, `prettier`). The `jig` binary runs an image on a clean export of `HEAD`, with no network, and commits what comes out, recording the pinned image and its args.

**Architecture:**
- Each image has a small entrypoint, `main(argv, root)`, that runs one action on `/workspace` and prints a JSON report. Behaviour is tested by calling `main` in-process; no docker is needed for that.
- The TypeScript engine stops knowing about the whole repo. Its project is the nearest tsconfig's folder, all TS files under it, plus that tsconfig's compiler options (unresolvable `extends` ignored).
- The host binary (`app`) knows nothing about actions:
  1. `git archive HEAD` into a temp dir.
  2. `docker run --network none`.
  3. Byte-compare the result with `HEAD`, copy the changes in, commit.

**Tech Stack:** Bun 1.3.13, TypeScript, `typescript@6.0.3`, `prettier@3.9.10`, docker (rootless), `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-17-container-actions-design.md`

## Global Constraints

- No `.js` files. Everything is `.ts` run by Bun. Relative imports carry `.ts`, type-only imports use `import type`, no enums or namespaces. Packages follow the existing layout: `@jig/<dir>`, `"exports": { ".": "./src/index.ts" }`, a `typecheck` script, tests in `<pkg>/test/*.test.ts`.
- Every task ends with `pnpm typecheck` (exit 0) and `bun test` (all pass).
- Image tags are exactly `localhost/jig/<tool>:local`. The tools are `typescript` and `prettier`. Base image: `oven/bun:1.3.13-slim`.
- The image contract:
  - `/workspace` is the working directory, holding only the files of `HEAD` (no `.git`).
  - The args are passed verbatim, and `args[0]` is the action name (`typescript-rename`, …, `format`).
  - On success the last stdout line is `{"ok":true,"subject":"…"}` and the exit code is 0.
  - On failure the last stdout line is `{"ok":false,"error":{"code","message","details"}}` and the exit code is non-zero.
- Docker invocation, exactly: `docker run --rm --network none --read-only --tmpfs /tmp -v <dir>:/workspace -w /workspace <imageId> <args...>`. Spawned with an argv array, never through a shell.
- Commit trailers, in order: `Refactor-Command: <canonicalJson({ image, args })>`, then `Co-Authored-By: <coAuthor>`. `image` is `<name as given>@<image id>`, e.g. `localhost/jig/typescript:local@sha256:…`. canonicalJson sorts keys, so the text is `{"args":[…],"image":"…"}`.
- `.jig.json` has one key, `coAuthor`, default `codemodder <codemodder@users.noreply.github.com>`. Any other key is `INVALID_ARGS`.
- Error codes: `SYMBOL_NOT_FOUND`, `AMBIGUOUS_SYMBOL`, `DIRTY_WORKTREE`, `REFACTOR_UNAVAILABLE`, `NO_CHANGES`, `UNKNOWN_ACTION`, `INVALID_ARGS`, `IMAGE_NOT_FOUND`, `IMAGE_FAILED`. The CLI also uses `INTERNAL` for anything else. Removed: `VALIDATION_FAILED`, `ENGINE_CONFLICT`, `UNKNOWN_ENGINE`.
- No validation anywhere: no typecheck, completeness or command validators, and no post-condition checks.
- Nothing is undone on failure.

## Review Focus

1. **Binary or non-UTF-8 files the image did not touch** must not show up as changed or be rewritten. Compare bytes, never decoded text. Test in Task 4.
2. **A repo with a submodule (gitlink, mode 160000)**: it is absent from the export, so it must not be reported as deleted. Test in Task 4.
3. **An executable file the image edits** keeps mode 100755 in the commit. Test in Task 4.
4. **An image that logs before its JSON, or exits non-zero with no JSON**: take the last non-empty stdout line. With no JSON, fail with `IMAGE_FAILED` and `{ exitCode, output }` holding the last 4000 chars. Test in Task 4.
5. **Args with spaces, quotes or unicode** reach the image unchanged and are recorded unchanged in `Refactor-Command`. Test in Task 4.

---

## File Structure

```
packages/core/src/
  errors.ts        ErrorCode updated (see Global Constraints)
  types.ts         Action, Decl, DeclKind, FileChange only (validation types removed)
  commit.ts        RefactorCommand = { image: string; args: string[] }
  config.ts        Config = { coAuthor }
  workspace.ts     NEW: listFiles(root), writeChanges(root, changes)
  report.ts        NEW: Report types + runEntrypoint(handler) for image CLIs
packages/engine-typescript/src/
  engine.ts        TsEngine: overlay + per-folder projects
  actions.ts       rename, extract (validation members removed)
  lift.ts          lift-out
  files.ts         move-file, organize-imports (format moved out)
  shared.ts        PREFERENCES, required, list (mergeEdits removed)
  main.ts          NEW: image entrypoint: main(argv, root): Promise<Report>
  bin.ts           NEW: `runEntrypoint(main)` for the container
packages/action-prettier/   NEW package: src/main.ts, src/bin.ts, test/
containers/typescript/Containerfile   NEW
containers/prettier/Containerfile     NEW
scripts/build-images.ts               NEW
app/src/
  cli.ts           [--repo] [--message] <image> [args...]
  run.ts           runImage(opts): export → docker → diff → copy → commit
  docker.ts        NEW: resolveImage, runContainer
  export.ts        NEW: exportHead, diffExport, copyChanges
app/test/
  run.test.ts      NEW: docker end-to-end
  probe/Containerfile, probe/probe.ts   NEW: test-only image
REMOVED: packages/validators, app/src/registry.ts, app/test/{e2e,lift,files,registry}.test.ts (ported to engine tests first)
```

---

### Task 1: TypeScript actions run inside a workspace

Everything that runs inside the typescript image: the engine's new project model, the actions without their validation members, and the entrypoint. The in-process orchestration and the validators are removed, and their behaviour tests are ported here.

**Files:**
- Modify:
  - `packages/core/src/{errors,types,index}.ts`
  - `packages/engine-typescript/src/{engine,actions,lift,files,shared,index}.ts`
  - `packages/engine-typescript/package.json` (drop the `@jig/git` dependency)
- Create:
  - `packages/core/src/workspace.ts`, `packages/core/src/report.ts`
  - `packages/engine-typescript/src/main.ts`, `packages/engine-typescript/src/bin.ts`
  - `packages/test-utils/fixtures/paths/` with `tsconfig.json` (`"paths": {"@/*": ["src/*"]}`), `src/util.ts` (`export function util() {}`), `src/main.ts` (`import { util } from "@/util"; util();`)
  - `packages/test-utils/fixtures/extends-npm/` with `tsconfig.json` (`"extends": "@tsconfig/node20/tsconfig.json"`, `"compilerOptions": {"strict": true}`), `a.ts`, `b.ts` (b imports `foo` from `./a`)
- Test:
  - `packages/engine-typescript/test/engine.test.ts` (rewrite)
  - `packages/engine-typescript/test/actions.test.ts` (new; ports the cases from `app/test/{e2e,lift,files}.test.ts`)
- Delete:
  - `packages/validators/`
  - `app/src/{run,registry}.ts`
  - `app/test/{e2e,lift,files,registry}.test.ts`
  - the format action in `files.ts`
  - `mergeEdits`
  - in `app/src/cli.ts`, reduce `main` to returning `INVALID_ARGS "not implemented"` until Task 4

**Interfaces:**
- Produces (core):
  - `listFiles(root: string): Promise<string[]>`: every regular file under `root`, relative with `/` separators, sorted. Skips `.git/` and `node_modules/`.
  - `writeChanges(root: string, changes: FileChange[]): Promise<void>`: moved from `packages/git`; git re-exports it until Task 4.
  - `type Report = { ok: true; subject: string } | { ok: false; error: { code: string; message: string; details?: unknown } }`.
  - `runEntrypoint(main: (argv: string[], root: string) => Promise<Report>): Promise<never>`. It calls `main(process.argv.slice(2), process.cwd())`, prints `JSON.stringify(report)` as the last line, and exits 0 when ok, else 1. A thrown `RefactorError` becomes its code; anything else becomes `INTERNAL`.
  - `Action<P, E>`: `{ id; parseParams(raw); describe(p): string; run(engine: E, p): Promise<void> }`. The members `engine`, `symbolNames`, `fileAliases` and `check` are gone. `Engine` = `{ id; version; read(path); changes(): FileChange[] }`.
- Produces (engine-typescript):
  - `TsEngine.load(root: string): TsEngine` (sync is fine).
  - `engine.project(file: string): Project`: the project of the nearest `tsconfig.json` at or above `file`'s directory and inside `root`, else `root` itself. Cached per folder.
  - `engine.findTopLevel(file, name, kind?)`, `engine.sourceFile(file)`: as today, on `project(file)`.
  - `main(argv: string[], root: string): Promise<Report>`. `argv[0]` is the action id, and the rest are the flags of today's CLI (`--file --symbol --to --symbols --in --files --kind`). It runs the action, calls `writeChanges(root, engine.changes())`, and returns `{ ok: true, subject: action.describe(params) }`. An unknown `argv[0]` is `UNKNOWN_ACTION`.

- [ ] **Step 1: Write the failing tests.** Each test runs on a fixture copy (`makeRepo`; the `.git` is harmless) through `main(argv, dir)`.
  - `engine.test.ts`:
    - `"a project holds every TS file under the tsconfig's folder, whatever include says"`: in `simple`, `engine.project("a.ts")` contains `scripts/tool.ts`.
    - `"a file with no tsconfig above it uses the root with default options"`.
    - `"an unresolvable extends is ignored"`: in `extends-npm`, `findTopLevel("a.ts","foo")` works and nothing throws.
    - Keep the overlay tests (write, create and delete show in `changes()`; `applyTextChanges` order).
    - Keep the "uses the repo's TypeScript when >=5.2 <7" tests.
  - `actions.test.ts`:
    - Every behaviour case from the deleted app tests, as `main` calls with file-content assertions:
      - rename across `.ts`/`.tsx`, including shorthand properties and re-exports
      - extract of two symbols
      - every lift-out case, including the doc-comment test and the `--to` test
      - move-file rewriting importers and its own relative imports
      - organize-imports
      - `SYMBOL_NOT_FOUND`, `REFACTOR_UNAVAILABLE` and `AMBIGUOUS_SYMBOL` reports
    - New: `"paths aliases inside the project are rewritten"`. In `paths`, `main(["typescript-move-file","--file","src/util.ts","--to","src/lib/util.ts"], dir)` leaves `src/main.ts` importing from `"@/lib/util"`.
    - New: `"a rename in one monorepo package leaves other packages as is"`. In `monorepo`, rename `formatName` in `packages/core/src/util.ts`. Expect `packages/app/src/main.ts` unchanged.
    - New: `"report subject"`. Renaming `foo`→`bar` in `simple` returns `{ ok: true, subject: "refactor(typescript-rename): foo → bar in a.ts" }`.
    - Dropped: every validation test (dirty tree, `VALIDATION_FAILED`, completeness, the `$` pattern, config `actions` keys).
- [ ] **Step 2: Run `bun test packages/engine-typescript`.** Expect failures: `main` is missing, and `project` doesn't behave this way yet.
- [ ] **Step 3: Implement the core changes.** This covers `listFiles`, `writeChanges`, `Report`, `runEntrypoint`, the trimmed types and the error codes. Delete the validators package and the app files listed above.
- [ ] **Step 4: Rework `TsEngine`.**
  - Drop:
    - the list of all repo tsconfigs
    - `ownerProject`, `projectsContaining`, `allProjects`, `projectFiles`, `diagnostics`
    - the `matchFiles`/`readDirectory` overlay code
    - the realpath cache (keep a single `realpathSync` of the root)
  - Parsing a project:
    - Parse its tsconfig with `getParsedCommandLineOfConfigFile` and ignore `errors` (an unresolved `extends` yields TS6053, and the own options still come back).
    - Root names: `listFiles(folder)` filtered to `/\.(m|c)?tsx?$/`, plus files created in the overlay under that folder, minus files deleted in it. Recompute when the set of created or deleted files changes.
- [ ] **Step 5: Update the actions.**
  - rename: `engine.project(p.file)`'s `findRenameLocations` → `applyTextChanges`.
  - move-file: `getEditsForFileRename` on `engine.project(p.file)` only.
  - organize-imports: each matched file uses its own `project(file)`. "Tracked files" become `listFiles(engine.repoRoot)`.
  - All actions: remove the validation members.
- [ ] **Step 6: Write `main.ts` and `bin.ts`** (`bin.ts` is just `await runEntrypoint(main)`).
- [ ] **Step 7: Run `pnpm typecheck && bun test`.** Expect exit 0 and all tests passing.
- [ ] **Step 8: Commit** with `refactor: typescript actions run on a workspace, no validation`.

### Task 2: The prettier action package

**Files:**
- Create:
  - `packages/action-prettier/{package.json,tsconfig.json}`. Dependencies: `prettier: 3.9.10` (exact) and `@jig/core`.
  - `packages/action-prettier/src/{main,bin,index}.ts`
- Test: `packages/action-prettier/test/format.test.ts`
- Modify: `app/package.json` (drop the `prettier` devDependency)

**Interfaces:**
- Consumes: `listFiles`, `Report`, `runEntrypoint`, `RefactorError` (core).
- Produces: `main(argv: string[], root: string): Promise<Report>`.
  - `argv` is `["format", "--files", "<glob,glob>"]`. Any other `argv[0]` is `UNKNOWN_ACTION`, and a missing `--files` is `INVALID_ARGS`.
  - Subject: `refactor(format): <globs joined with ", ">`.

- [ ] **Step 1: Write the failing tests** (on `makeRepo("simple")` plus extra files written before calling `main`).
  - `"formats matching files with the repo's config"`: `ugly.ts` = `export const   x = {a:1,\n  b:'two'}\n` becomes `export const x = { a: 1, b: "two" };\n`.
  - `"no prettier config: prettier defaults"`: delete `.prettierrc`, write `q.ts` = `const a = 'x'\n`, and expect `const a = "x";\n`.
  - `"a config that fails to load falls back to the defaults"`: write `prettier.config.mjs` = `import x from "nope"; export default x;` and expect the same output as with defaults, with no error.
  - `".prettierignore is respected"`.
  - `"files prettier cannot parse are skipped"`: a matched `.bin` file is left alone.
  - `"unknown action"` and `"missing --files"` reports.
- [ ] **Step 2: Run `bun test packages/action-prettier`.** Expect it to fail: the module isn't found.
- [ ] **Step 3: Implement it.**
  - Match `listFiles(root)` against `Bun.Glob`s.
  - For each match, call `prettier.getFileInfo(abs, { ignorePath: [join(root, ".prettierignore")] })`. Skip it when `ignored` is set or `inferredParser` is null.
  - Get the options with `try { prettier.resolveConfig(abs, { editorconfig: true }) } catch { null }`; `null` means the defaults.
  - Call `prettier.format(text, { ...options, filepath: abs })`, and write the file only when the output differs.
- [ ] **Step 4: Run `pnpm typecheck && bun test`.** Expect everything to pass.
- [ ] **Step 5: Commit** with `feat: prettier format action package`.

### Task 3: Containerfiles and the build script

**Files:**
- Create:
  - `containers/typescript/Containerfile`
  - `containers/prettier/Containerfile`
  - `.dockerignore` (`node_modules`, `.git`, `**/test`, `**/fixtures`, `docs`)
  - `scripts/build-images.ts`
- Modify: root `package.json` (script `"build-images": "bun scripts/build-images.ts"`), `README.md`

**Interfaces:**
- Consumes: `packages/engine-typescript/src/bin.ts` and `packages/action-prettier/src/bin.ts` (Tasks 1–2).
- Produces:
  - Images `localhost/jig/typescript:local` and `localhost/jig/prettier:local`. The entrypoint is `["bun", "/app/packages/<pkg>/src/bin.ts"]` and `WORKDIR /workspace`.
  - `scripts/build-images.ts`, which exports `buildImages(tools?: string[]): Promise<{ tool: string; tag: string; id: string }[]>`.
    - It runs `docker build -f containers/<tool>/Containerfile -t <tag> .` from the repo root for every `containers/*/` directory, or only the given ones.
    - It prints the result as JSON when run directly (`import.meta.main`).

- [ ] **Step 1: Write the Containerfiles.**
  - `FROM oven/bun:1.3.13-slim`, then copy into `/app` only `packages/core` plus the tool's package.
  - Add `containers/<tool>/package.json`, a root manifest with `"workspaces": ["packages/*"]`, and run `bun install --production` at build time. Network is allowed while building; only the run has none.
  - The runtime must not need `/app` to be writable: the run uses `--read-only` with `/tmp` as tmpfs.
- [ ] **Step 2: Write `scripts/build-images.ts`.** It runs each build with an argv array, fails on a non-zero exit (including the build's stderr tail), and reads the ID with `docker image inspect --format '{{.Id}}' <tag>`.
- [ ] **Step 3: Run `bun run build-images`.** Expect two entries with `sha256:` IDs.
- [ ] **Step 4: Smoke test by hand** on an export of the simple fixture.
  1. `rm -rf /tmp/rc-smoke && mkdir /tmp/rc-smoke && cp -r packages/test-utils/fixtures/simple/. /tmp/rc-smoke/`
  2. `docker run --rm --network none --read-only --tmpfs /tmp -v /tmp/rc-smoke:/workspace -w /workspace localhost/jig/typescript:local typescript-rename --file a.ts --symbol foo --to bar`

  Expect the last line `{"ok":true,"subject":"refactor(typescript-rename): foo → bar in a.ts"}`, with `/tmp/rc-smoke/b.ts` changed and owned by the current user. Do the same for prettier with `format --files ugly.ts` after writing an ugly file.
- [ ] **Step 5: Document it in `README.md`.** Cover the images, the build command, and the image contract (copied from Global Constraints).
- [ ] **Step 6: Commit** with `feat: container images for the typescript and prettier actions`.

### Task 4: The host binary runs images and commits

**Files:**
- Modify:
  - `packages/core/src/{commit,config}.ts` and their tests
  - `packages/git/src/index.ts`: add `trackedEntries`, drop the `writeChanges` re-export and `trackedFiles` if unused
  - `app/src/cli.ts`, `app/package.json` (dependencies: core and git only), `README.md`
  - the spec's status line, changed to "implemented"
- Create:
  - `app/src/run.ts`, `app/src/docker.ts`, `app/src/export.ts`
  - `app/test/probe/{Containerfile,probe.ts}`
- Test:
  - `app/test/run.test.ts` (docker; `describe.skipIf(!dockerAvailable)`)
  - `app/test/export.test.ts` (no docker)

**Interfaces:**
- Consumes: `buildImages` (Task 3) in the test `beforeAll`; `formatCommitMessage`, `canonicalJson`, `loadConfig`; and from git, `assertClean`, `commitPaths`, `headCommit`, `git`.
- Produces:
  - `RefactorCommand = { image: string; args: string[] }`. `parseRefactorCommand(msg)` returns null unless `image` is a string and `args` is a string array (last trailer line wins, as now).
  - `loadConfig(repo): Promise<{ coAuthor: string }>`. An unknown key is `INVALID_ARGS`.
  - git: `trackedEntries(repo): Promise<{ path: string; mode: string }[]>` from `git ls-files -s -z`.
  - docker.ts:
    - `resolveImage(ref: string): Promise<{ name: string; id: string; pinned: string }>`.
      - For `name@sha256:<hex>`: the ID is `sha256:<hex>`, and it must exist (`docker image inspect <id>`), else `IMAGE_NOT_FOUND`. The tag is not compared.
      - Otherwise: inspect `ref`, and use `pinned = ${ref}@${id}`.
    - `runContainer(id: string, dir: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>`.
  - export.ts:
    - `exportHead(repo: string): Promise<string>` returns a new temp dir. It uses `git archive --format=tar HEAD` piped into `tar -x -C <dir>`.
    - `diffExport(repo: string, dir: string): Promise<{ path: string; kind: "modified" | "created" | "deleted" }[]>`.
      - It byte-compares `trackedEntries` (gitlinks, mode 160000, skipped) against `dir`.
      - A tracked symlink is compared by `readlink`.
      - In `dir`, a new symlink, a changed symlink, or a non-regular file is `IMAGE_FAILED`.
    - `copyChanges(repo: string, dir: string, changes): Promise<void>`. A modified file is written in place, keeping its mode. A created file gets `mkdir -p` first. A deleted file is removed.
  - `runImage(o: { repo: string; image: string; args: string[]; message?: string }): Promise<{ ok: true; commit: string; parent: string; image: string; args: string[]; filesChanged: string[] }>`.
    - Order: `assertClean` → `resolveImage` → `exportHead` → `runContainer` → parse the report → `diffExport` (empty is `NO_CHANGES`) → `copyChanges` → `commitPaths` with `formatCommitMessage({ subject, message, command: { image: pinned, args }, coAuthor })`.
    - The temp dir is removed in a `finally`.
  - CLI: `jig [--repo <path>] [--message <text>] <image> [args...]`. The leading options are parsed by hand, and everything after the image is passed through verbatim (even values starting with `--`).

- [ ] **Step 1: Write the probe image.** It is a test-only image, `localhost/jig/probe:local`, `FROM oven/bun:1.3.13-slim`, entrypoint `bun /probe.ts`. Its behaviour is chosen by `argv[0]`:
  - `check`: writes `probe.json` = `{ nodeModules: existsSync("node_modules"), git: existsSync(".git"), network: <true if fetch("http://1.1.1.1") resolves within 2s>, args: argv.slice(1) }`, then prints `{"ok":true,"subject":"probe: check"}`.
  - `noisy`: prints three log lines, writes `n.txt`, then prints the ok JSON.
  - `crash`: prints `boom` and exits 3.
  - `fail`: prints `{"ok":false,"error":{"code":"SYMBOL_NOT_FOUND","message":"nope"}}` and exits 1.
  - `none`: changes nothing and prints ok.
  - `symlink`: creates `evil` → `/etc/passwd`.
  - `exec`: appends `# x\n` to `run.sh`.
- [ ] **Step 2: Write the failing tests.**
  - `export.test.ts`, with plain dirs and no docker:
    - `"diffExport finds modified, created and deleted files"`
    - `"an untouched binary file is not reported"` (fixture file with bytes `0xff 0x00 0xfe`)
    - `"a gitlink is not reported as deleted"` (`git update-index --add --cacheinfo 160000,<head sha>,sub` then commit)
    - `"a new symlink in the export is IMAGE_FAILED"`
  - `run.test.ts`. `beforeAll` runs `buildImages(["typescript","prettier"])` plus a `docker build` of the probe, with a timeout of 600000. Every test uses `makeRepo("simple")`, plus `node_modules/x.txt` (it is gitignored, so the tree stays clean).
    - `"typescript rename is committed with the pinned image and args"`
      - The commit subject is `refactor(typescript-rename): foo → bar in a.ts`.
      - `parseRefactorCommand` gives `{ image: /^localhost\/jig\/typescript:local@sha256:[0-9a-f]{64}$/, args: ["typescript-rename","--file","a.ts","--symbol","foo","--to","bar"] }`.
      - The status is clean.
    - `"prettier format is committed"`.
    - `"replaying the recorded image and args on the parent gives the same tree"`, for both images. Check out the parent detached and call `runImage` with the recorded `image` and `args`. The tree hashes must be equal.
    - `"the container sees no ignored files, no .git and no network; args are passed verbatim"`: run `probe check "a b" "é" '"q"'`. Expect the committed `probe.json` to have `nodeModules:false`, `git:false`, `network:false` and `args:["a b","é","\"q\""]`, and the recorded args to be the same.
    - `"logs before the JSON are fine"` (`noisy`).
    - `"an image error is passed through"`: `fail` gives `SYMBOL_NOT_FOUND`, with no commit.
    - `"no JSON is IMAGE_FAILED"`: `crash` gives `details.exitCode` 3 and an output containing `boom`.
    - `"no changes is NO_CHANGES"` (`none`).
    - `"a symlink to a host file is IMAGE_FAILED"`: `symlink`, with no commit and the repo unchanged.
    - `"an edited executable keeps mode 100755"`: commit `run.sh` with mode 755 first, then run `exec`.
    - `"an unknown image is IMAGE_NOT_FOUND"`; `"a pinned ID that no longer exists is IMAGE_NOT_FOUND"` (`localhost/x:local@sha256:` + 64 zeros).
    - `"dirty tree is DIRTY_WORKTREE"`.
    - `"cli prints the result JSON"`: run `app/bin/jig --repo <dir> localhost/jig/typescript:local typescript-rename --file a.ts --symbol foo --to bar`. Expect exit 0 and `ok:true`. An error gives exit 1 with `{ ok:false, error }`.
- [ ] **Step 3: Run `bun test app packages/core`.** Expect failures: the modules are missing and the command has the old shape.
- [ ] **Step 4: Implement it.**
  - Implement the commit and config changes, `trackedEntries`, `docker.ts`, `export.ts`, `run.ts` and `cli.ts`.
  - For the report, use the last non-empty stdout line that parses as JSON with a boolean `ok`. If there is none, fail with `IMAGE_FAILED` and `{ exitCode, output: (stdout+stderr).slice(-4000) }`. If the report is `ok:false`, rethrow it as a `RefactorError` with the image's code, or `IMAGE_FAILED` when the code is not one of ours.
- [ ] **Step 5: Run `pnpm typecheck && bun test`.** Expect everything to pass, including `run.test.ts` (docker is available here).
- [ ] **Step 6: Update the README.** Cover the CLI usage, the trailer shape, "no validation: the caller validates", and the best-effort TypeScript project rule. Remove the validation and config `actions`/`ignoreUncovered`/`tsconfigs` sections.
- [ ] **Step 7: Commit** with `feat: jig runs action images without network and commits the result`.
