# Help for images: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `jig <image> [--help]` lists an image's actions and `jig <image> <action> --help` shows one
action's typed flags, from a `urn:jig:help:1` object the image prints, as JSON for agents and text in a
terminal, without a repo.

**Architecture:** Each image answers exactly `["--help"]` with one help JSON line (TS images through
`runEntrypoint` in `packages/core`, fs in `fs.nu`). The Swift binary recognises help calls, runs the
image with `["--help"]` on an empty temp folder, validates the object strictly in `swift/report`, filters
to one action when asked, and prints JSON (stdout not a TTY) or text.

**Tech Stack:** TypeScript on Node 26 (`node --test`), Nushell 0.117 in busybox, Swift 6.4.2 (swift-testing).

**Spec:** `docs/superpowers/specs/2026-11-21-image-help-design.md`

## Global Constraints

- Schema id `urn:jig:help:1`; file `schemas/help-1.schema.json` (JSON Schema 2020-12, like the others).
- Help object fields: `schema`, `summary`, `actions[]`; action: `name`, `kinds[]`, `summary`, `flags[]`;
  flag: `name`, `type`, `required`, `description`, plus `choices[]` only and always for `type: "choice"`.
- Flag types exactly: `path`, `paths`, `globs`, `text`, `choice`. Kinds exactly: `refactor`, `sweep`, `rewrite`.
- jig adds `ok: true`, `image` (pinned reference) and `notes` (only when non-empty); an image must not send them.
- Help call = image args exactly `[]`, `["--help"]`, or `[<action>, "--help"]`; jig always sends the image `["--help"]`.
- `--message` with a help call → `INVALID_ARGS`; `--repo` accepted and ignored; `--sandbox` honoured.
- Unknown action in a help call → `UNKNOWN_ACTION` listing the image's actions. Image without help → `IMAGE_FAILED`
  whose instructions contain `gives no help`.
- `jig --help` prints usage text, exit 0. Bare `jig` stays `INVALID_ARGS`.
- One action, one set of flags; fs `remove` splits into `remove --paths` and `remove-matching --files`
  (subject `rewrite(remove-matching): <globs>`).
- Images keep parsing arguments exactly as today (no new refusals in the TS images).
- No Bun anywhere. Inline strings over shared constants where the codebase already inlines; explicit
  control flow over helpers that hide it.
- Shell commands go through `nux` (`nux help` first). Commit messages end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and nothing else (no Claude-Session line).
- Tests: `sh scripts/test-packages.sh` (TS), `pnpm typecheck`, `sh scripts/test-swift.sh` (Swift; Swift
  is at `~/.local/share/swiftly/toolchains/6.4.2/usr/bin/swift` if not on PATH), `sh scripts/build-images.sh <name>`.

## Review Focus

1. The image prints log lines before its help line (Node warnings): jig still finds the last JSON-object line. (Task 4 test.)
2. A help object that also carries `ok`/`image`/`notes`, or a flag with `choices` but type `text`: refused, `IMAGE_FAILED`. (Task 4 test.)
3. `jig <image> <action> --help extra` or `jig <image> <action> --to --help` is a normal run, not help. (Task 4 test.)
4. The image prints valid help but exits non-zero: `IMAGE_FAILED`. (Task 4 test.)
5. Help under `--sandbox rootlesskit` gives the same JSON as docker. (Task 4 e2e test, gated like the existing rootlesskit suites.)

---

### Task 1: The help contract in `packages/core`, the schema, and the prettier and codemod images

**Files:**
- Create: `packages/core/src/help.ts`, `schemas/help-1.schema.json`, `schemas/examples/help-1.json`
- Modify: `packages/core/src/index.ts`, `packages/core/src/types.ts` (Action), `packages/core/src/report.ts` (`runEntrypoint`),
  `packages/test-utils/src/index.ts` (load `help-1.schema.json` with the others),
  `packages/action-prettier/src/{main,bin}.ts`, `packages/action-codemod/src/{main,bin}.ts`,
  `packages/engine-typescript/src/bin.ts` (temporary: pass a help built from `ACTIONS`; Task 2 fills summaries/flags)
- Test: `packages/core/test/report.test.ts` (or a new `help.test.ts`), `packages/action-prettier/test/format.test.ts`, `packages/action-codemod/test/codemod.test.ts`

**Interfaces:**
- Produces (`@jig/core`):
  - `HELP_SCHEMA = "urn:jig:help:1"`
  - `type Flag = { name: string; type: "path" | "paths" | "globs" | "text"; required: boolean; description: string } | { name: string; type: "choice"; choices: string[]; required: boolean; description: string }`
  - `type ActionHelp = { name: string; kinds: ActionKind[]; summary: string; flags: Flag[] }`
  - `type ImageHelp = { schema: typeof HELP_SCHEMA; summary: string; actions: ActionHelp[] }`
  - `function imageHelp(summary: string, actions: ActionHelp[]): ImageHelp`
  - `function actionHelp(action: Action): ActionHelp` → `{ name: action.id, kinds: [action.kind], summary: action.summary, flags: action.flags }`
  - `Action` gains `summary: string` and `flags: Flag[]`.
  - `runEntrypoint(main, help: () => ImageHelp | Promise<ImageHelp>)`: when `process.argv.slice(2)` is exactly `["--help"]`, prints `JSON.stringify(await help())` and exits 0; if `help` throws, prints `failedReport("INTERNAL", ...)` and exits 1; anything else runs `main` as before.
  - `packages/action-prettier`: `export function help(): ImageHelp`. `packages/action-codemod`: `export function help(pkg?: CodemodPackage): ImageHelp` (defaults to `installedPackage()`, as `main` does).

- [ ] **Step 1: Write the failing tests**
  - core: `runEntrypoint` with argv `["--help"]` prints the help JSON (one line) and exits 0; with `["--help", "x"]` it calls `main`. (Spawn a tiny entry script with `node`, or factor the argv branch so it is testable; builder's choice.)
  - core: the example `schemas/examples/help-1.json` is valid against `urn:jig:help:1` (extend "the examples in schemas/examples are valid"); a flag `{type:"text", choices:[...]}` and a `choice` flag without `choices` are invalid. (Refusing `ok`/`image`/`notes` from an image is jig's Swift check, Task 4; the schema allows them because jig's output uses the same schema.)
  - prettier: `help()` is schema-valid; `help().actions.map(a => a.name)` is `["format"]`; `format` has `kinds: ["sweep"]` and one flag `{name:"--files", type:"globs", required:true}`.
  - codemod: `help(await fakePackage({...}))` is schema-valid; one action `codemod`; its `kinds` are the distinct kinds of the package's transforms in the order refactor, sweep, rewrite; `--transform` is `type:"choice"` with the transform names sorted and `required: true`, and its description names each transform's kind; `--files` is `globs`, required; `--parser` is `choice` of `["tsx","ts","babel","flow"]`, `required: false`.
- [ ] **Step 2: Run them and see them fail** — `sh scripts/test-packages.sh` → failures for missing exports.
- [ ] **Step 3: Implement** `help.ts`, the schema (with `image`, `notes`, `ok` optional and `additionalProperties: false` everywhere; the `choice`/`choices` rule via `oneOf` on the flag), the example (the fs `move` action from the spec is a fine example), `runEntrypoint`, prettier and codemod `help`, and the three `bin.ts` files passing `help`. The typescript `bin.ts` passes `() => imageHelp("<one line>", ACTIONS.map(actionHelp))`; until Task 2, every TS action gets `summary` and `flags` so it typechecks — give each a real summary and its real flags now if that is simpler than placeholders (no placeholder text may survive Task 2).
- [ ] **Step 4: Run** `sh scripts/test-packages.sh` and `pnpm typecheck` → all pass.
- [ ] **Step 5: Commit** `feat(core): urn:jig:help:1 and runEntrypoint --help; help for prettier and codemod`

### Task 2: Help for the 19 typescript actions

**Files:**
- Modify: every action file under `packages/engine-typescript/src/` that defines an `Action` (`actions.ts`, `barrels.ts`, `console.ts`, `convert-function.ts`, `default-to-named.ts`, `extensions.ts`, `files.ts`, `imports.ts`, `inline.ts`, `lift.ts`, `params.ts`, `return-types.ts`, `rename-files.ts`, `subpath-imports.ts`, `template-string.ts`, `unused-variable.ts`), `packages/engine-typescript/src/main.ts` (export `help()`), `bin.ts`
- Test: `packages/engine-typescript/test/help.test.ts`

**Interfaces:**
- Consumes: `Flag`, `ActionHelp`, `imageHelp`, `actionHelp` from Task 1.
- Produces: `export function help(): ImageHelp` in `packages/engine-typescript/src/main.ts`.

- [ ] **Step 1: Write the failing tests** in `help.test.ts`:
  - `help()` is schema-valid and its action names equal `ACTIONS.map(a => a.id)` in order (export `ACTIONS` or compare via `main`'s UNKNOWN_ACTION list; builder's choice).
  - Every action's summary is one line, non-empty, and not a placeholder.
  - For every action: the set of `--<flag>` names in its help equals the set of raw keys its `parseParams` reads. Observe the reads with a `Proxy` over the raw object that records `get`s and answers each declared flag with a value valid for its type (`path` → `"src/a.ts"`, `paths`/`globs` → `"src/a.ts"`, `text` → a value the parser accepts, `choice` → `choices[0]`); a parser that throws on a fake value may be given a specific valid value in the test.
  - Each flag's `required` matches whether `parseParams` refuses the call without it.
- [ ] **Step 2: Run and see it fail** — `sh scripts/test-packages.sh`.
- [ ] **Step 3: Implement** summaries and typed flags per action (`--to` is `path` for `typescript-move-file`, `typescript-extract`, `typescript-lift-out`; `text` for `typescript-rename`; choose the rest from each `parseParams` and the README usage lines). `main` and `parseParams` do not change.
- [ ] **Step 4: Run** `sh scripts/test-packages.sh` and `pnpm typecheck` → pass.
- [ ] **Step 5: Commit** `feat(typescript): help for every action`

### Task 3: fs answers `--help`; `remove` splits into `remove` and `remove-matching`

**Files:**
- Modify: `containers/fs/fs.nu`, `swift/cli/Tests/IntegrationTests/FsTests.swift`, `README.md` (fs section, kinds row)
- Test: `FsTests.swift`

**Interfaces:**
- Produces: the fs image answers `["--help"]` with help whose actions are, in order, `copy`, `move`, `remove`, `remove-matching`, `unwrap`, `wrap`, all `kinds: ["rewrite"]`, flags all required: copy/move `--from` path, `--to` path; remove `--paths` paths; remove-matching `--files` globs; unwrap `--folder` path; wrap `--paths` paths, `--into` path. Image summary one line.

- [ ] **Step 1: Write the failing tests** in `FsTests.swift`:
  - The existing `remove --files` tests (`removeFiles`, `removeFilesDotfiles`, `removeFilesTrimmed`, `removeFilesCapped`, `removeNothing`, `removeSymlink` where it uses `--files`) run `remove-matching --files …`; subjects become `rewrite(remove-matching): …`.
  - `remove --files "**/*.bak"` is refused `INVALID_ARGS`, instructions contain `remove --paths <path,path>` (the usage).
  - The `remove` refusal cases in `removeUnwrapWrapRefusals` that mention `--files` move to `remove-matching` (`remove-matching --files ","` → INVALID_ARGS with its usage; `remove-matching` with no flag → INVALID_ARGS).
  - Unknown command lists `copy, move, remove, remove-matching, unwrap, wrap`.
  - `docker run --rm --network none localhost/jig/fs:local --help` (direct, like `unwrapEmpty`): exit 0, last line parses, `schema == "urn:jig:help:1"`, action names in the order above.
- [ ] **Step 2: Run and see them fail** — fs suite via `swift test --filter FsTests` in `swift/cli` (with `SWIFT` set).
- [ ] **Step 3: Implement** in `fs.nu`: dispatch `--help` (only as the sole argument) to a `help` command that prints the record with `to json --raw`; `remove` takes only `--paths`; new `remove-matching` with today's `--files` behaviour and subject; both usages updated; the UNKNOWN_ACTION lists six commands. README: fs table gains `remove-matching`, `remove` row loses `--files`, kinds row lists six commands.
- [ ] **Step 4: Run** `sh scripts/build-images.sh fs` and the fs suite → pass.
- [ ] **Step 5: Commit** `feat(fs): --help; split remove into remove and remove-matching`

### Task 4: jig shows help

**Files:**
- Create: `swift/report/Sources/Report/ImageHelp.swift`, `swift/report/Tests/ReportTests/ImageHelpTests.swift`,
  `swift/cli/Sources/RefactorCLI/Help.swift`, `swift/cli/Tests/IntegrationTests/HelpTests.swift`
- Modify: `swift/cli/Sources/RefactorCLI/CLIArgs.swift`, `swift/cli/Sources/jig/main.swift`,
  `swift/cli/Tests/CLITests/CLIArgsTests.swift`, `README.md` (usage block, a "Help" section, the image contract under "Writing an action")
- Test: the files above

**Interfaces:**
- Consumes: images from Tasks 1–3 answering `["--help"]`.
- Produces (Report module):
  - `public let helpSchema = "urn:jig:help:1"`
  - `public enum FlagType: String { case path, paths, globs, text, choice }`
  - `public struct FlagHelp: Equatable, Sendable { name: String; type: FlagType; required: Bool; description: String; choices: [String]? }`
  - `public struct ActionHelp: Equatable, Sendable { name: String; kinds: [ActionKind]; summary: String; flags: [FlagHelp] }`
  - `public struct ImageHelp: Equatable, Sendable { summary: String; actions: [ActionHelp] }`
  - `public enum ImageHelpAnswer: Equatable, Sendable { case help(ImageHelp); case failed(RefactorError) }` with
    `public static func parse(stdout: String, stderr: String, termination: Termination) -> ImageHelpAnswer`
  - `public func helpJSON(image: String, notes: [String], help: ImageHelp) -> String` (same canonical writer as `successJSON`)
  - `public func helpText(image: String, notes: [String], help: ImageHelp, action: String?) -> String`
- Produces (RefactorCLI):
  - `Command` gains `case help(HelpArgs)` and `case usage`; `public struct HelpArgs: Equatable, Sendable { sandbox: SandboxKind; image: String; action: String? }`
  - `public func imageHelp(image: String, action: String?, sandbox: any Sandbox) throws -> (image: String, notes: [String], help: ImageHelp)` — the help already filtered to `action` when given.

- [ ] **Step 1: Write the failing unit tests**
  - `ImageHelpTests`: the spec's example parses; logs before the line are fine; each refusal is `IMAGE_FAILED`: unknown field (incl. `ok`, `image`, `notes`), wrong type, empty `actions`, duplicate action name, duplicate flag name, empty `kinds`, repeated kind, unknown kind, unknown flag type, `choice` without `choices`, `choices` on `text`, empty `choices`, flag name not starting with `--`, multi-line summary, valid help but exit 1; a failed report `{"schema":"urn:jig:report:1","ok":false,"code":"UNKNOWN_ACTION","instructions":"Unknown action \"--help\". This image has: format."}` → `IMAGE_FAILED` whose instructions contain `gives no help` and `This image has: format.`; no JSON line at all → `IMAGE_FAILED`.
  - `helpJSON` has `ok: true`, `image`, `schema`, omits `notes` when empty and includes it otherwise; `helpText` for the image view and the action view matches the spec's sketches (aligned columns, `sweep|rewrite`, `<choice>` with options listed, optional flag in brackets in the usage line, notes under the header).
  - `CLIArgsTests`: `["img"]`, `["img","--help"]`, `["img","move","--help"]`, `["--repo","x","img","--help"]`, `["--sandbox","rootlesskit","img"]` are `.help`; `["img","move","--to","--help"]` and `["img","move","--help","x"]` are `.run`; `["--message","m","img","--help"]` throws `INVALID_ARGS`; `["--help"]` is `.usage`; `[]` still throws `INVALID_ARGS`.
- [ ] **Step 2: Run and see them fail** — `swift test` in `swift/report` and `swift/cli --skip IntegrationTests`.
- [ ] **Step 3: Implement** `ImageHelp.swift` (find the last non-empty stdout line that is a JSON object; `schema == helpSchema` → strict checks, exit must be 0; a `urn:jig:report:1` failure → "gives no help" quoting code and instructions; anything else → `IMAGE_FAILED` naming `schemas/help-1.schema.json`), `helpJSON`, `helpText`, the `CLIArgs` changes (usage text gains a line on `jig <image> [--help]` and `jig <image> <action> --help`), `Help.swift` (resolve as `runImage` does; an empty temp folder registered with `Lifecycle` like `Workspace` and removed after; `sandbox.run(pinned, arguments: ["--help"], workspace:)`; filter or throw `UNKNOWN_ACTION` "Unknown action \"x\". This image has: a, b."), and `main.swift` (`.help` → `isatty(STDOUT_FILENO) != 0` ? text : JSON, exit 0; `.usage` → usage text, exit 0).
- [ ] **Step 4: Write the e2e tests** in `HelpTests.swift`, run from a temp folder that is not a git repo, building fs and codemod-react like their suites do (setup() builds typescript, prettier and the probe):
  - `jig localhost/jig/fs:local --help`: exit 0, one JSON line, `ok == true`, `schema == "urn:jig:help:1"`, `image` starts with `localhost/jig/fs` and contains `@sha256:`, six actions.
  - `jig localhost/jig/fs:local` (no args): same as `--help`.
  - `jig localhost/jig/fs:local move --help`: one action `move` with flags `--from`, `--to`.
  - `jig localhost/jig/fs:local nope --help`: exit 1, `UNKNOWN_ACTION`, instructions list `remove-matching`.
  - `jig --message m localhost/jig/fs:local --help`: `INVALID_ARGS`.
  - `jig localhost/jig/probe:local --help`: `IMAGE_FAILED`, `gives no help`.
  - `--help` for typescript, prettier and codemod-react: exit 0, valid, action counts 19, 1, 1.
  - `jig --help`: exit 0, stdout contains `usage: jig`.
  - rootlesskit (gated with `rootlesskitAvailable`): `jig --sandbox rootlesskit localhost/jig/fs:local --help` gives the same `actions` as docker.
- [ ] **Step 5: Run** `sh scripts/test-swift.sh` (full), `sh scripts/test-packages.sh`, `pnpm typecheck` → all pass. Update the README.
- [ ] **Step 6: Commit** `feat(cli): jig <image> --help and <action> --help`
