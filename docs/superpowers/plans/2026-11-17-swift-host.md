# Swift Host Binary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the TypeScript host binary with a static Swift binary. It lets git capture the container's output (temp index + `write-tree` + `commit-tree` + `merge --ff-only`) instead of comparing and copying files by hand.

**Architecture:**
- A Swift package in `host/` builds `jig`. Its pure logic (CLI args, config, report parsing, canonical JSON, commit message) is unit-tested with swift-testing.
- The git and docker flow is tested by the existing TypeScript end-to-end suite, which runs the built binary as a black box.

**Tech Stack:** Swift 6.4.2 with Foundation only, the Static Linux SDK `swift-6.4.2-RELEASE_static-linux-0.1.0` (target `x86_64-swift-linux-musl`), swift-testing, and git and docker via `Process`. The e2e tests use `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-17-swift-host-design.md` (the flow, the decisions, what changes in behaviour). The image contract is in `docs/superpowers/specs/2026-11-17-container-actions-design.md`.

## Global Constraints

- **Toolchain:** Swift lives at `~/.local/share/swiftly/toolchains/6.4.2/usr/bin`, which is not on PATH; prepend it. Static build: `swift build -c release --swift-sdk x86_64-swift-linux-musl`, product at `host/.build/out/Products/Release-staticlinux-x86_64/jig`. Use no third-party Swift packages.
- **Processes:** run every external command with an argument array, never through a shell. The docker invocation is exactly `docker run --rm --network none --read-only --tmpfs /tmp -v <dir>:/workspace -w /workspace <imageId> <args...>`.
- **CLI:** `jig [--repo <path>] [--message <text>] <image> [args...]`. Only the leading `--repo`/`--message` belong to the binary; everything after `<image>` is passed through verbatim.
- **Output:** exactly one JSON object on stdout. On success: `{"ok":true,"commit","parent","image","args","filesChanged"}`, exit 0. On failure: `{"ok":false,"error":{"code","message","details"}}`, exit 1.
- **Error codes:** `SYMBOL_NOT_FOUND`, `AMBIGUOUS_SYMBOL`, `DIRTY_WORKTREE`, `REFACTOR_UNAVAILABLE`, `NO_CHANGES`, `UNKNOWN_ACTION`, `INVALID_ARGS`, `IMAGE_NOT_FOUND`, `IMAGE_FAILED`, `INTERNAL`. An image's own `ok:false` code passes through when it is one of these; otherwise it becomes `IMAGE_FAILED`.
- **Commit message:** `<subject>\n\n[<message trimmed>\n\n]Refactor-Command: <canonical>\nCo-Authored-By: <coAuthor>\n`.
  - `<canonical>` is `{"args":[…],"image":"…"}`, byte-identical to JavaScript's `JSON.stringify` output for these strings: `/` and non-ASCII are not escaped; `\b \f \n \r \t \" \\` are escaped; other control characters become lowercase `\u00xx`.
  - `image` is `<name as given>@<image id>`.
- **Config:** `.jig.json` accepts only the key `coAuthor` (string), default `codemodder <codemodder@users.noreply.github.com>`. Any other key, a non-object, or invalid JSON is `INVALID_ARGS`.
- **Symlinks:** do not add rules or raise questions about symlinks created by images (see `AGENTS.md`).
- **Verification:** every task ends with `pnpm typecheck` (exit 0), `bun test` (all pass), and `swift test` in `host/` (all pass).

## Review Focus

1. **A repo with a submodule:** the gitlink survives unchanged. Its folder is empty in the export, and `git add -A` must not stage a deletion. Covered by the existing gitlink e2e test, now run against the Swift binary (Task 2).
2. **Odd args** (spaces, quotes, unicode, `"`, `\`, a control character) are recorded byte-identically to the TypeScript canonical JSON. Swift unit test with literal expected strings (Task 1).
3. **The image writes a file at a path the host ignores**, such as `node_modules/x` or `.env` matched by `.gitignore`: it is not committed, the host file is untouched, and other changes still commit. If it was the only change, the result is `NO_CHANGES` (Task 2).
4. **The image edits `.gitignore`** (in the root or a subfolder): `IMAGE_FAILED`, nothing committed, the repo untouched (Task 2).
5. **The image creates a `.git` folder** (in the root or a subfolder) or a nested repo: `IMAGE_FAILED` (Task 2).

---

### Task 1: Swift package with the pure logic

**Files:**
- Create: `host/Package.swift` (tools 6.0; an executable target `jig`, a library target `RefactorCommits` with the logic, and a test target `RefactorCommitsTests` using swift-testing)
- Create: `host/Sources/RefactorCommits/`:
  - `ErrorCode.swift`
  - `RefactorError.swift`
  - `CanonicalJSON.swift`
  - `CommitMessage.swift`
  - `Config.swift`
  - `CLIArgs.swift`
  - `ImageReport.swift`
  - `Output.swift`
- Create: `host/Sources/jig/main.swift`. It parses the args and prints `INVALID_ARGS "not implemented"` JSON for now.
- Create: `host/Tests/RefactorCommitsTests/*.swift`
- Create: `scripts/build-binary.ts`. It runs the static release build with an argument array, copies the product to `dist/jig`, and prints the path. Export `buildBinary(): Promise<string>` for the e2e tests.
- Modify: root `package.json` (script `"build-binary": "bun scripts/build-binary.ts"`), `.gitignore` (`dist/`, `host/.build/`)

**Interfaces (produced):**
- `enum ErrorCode: String, Codable, CaseIterable`: the codes above, with raw values equal to the strings.
- `struct RefactorError: Error { code: ErrorCode; message: String; details: JSONValue? }`. `JSONValue` is a small `Codable` enum for arbitrary details.
- `func canonicalCommand(image: String, args: [String]) -> String`
- `func commitMessage(subject: String, message: String?, image: String, args: [String], coAuthor: String) -> String`
- `func loadConfig(repo: URL) throws -> Config`, where `Config { coAuthor: String }`
- `struct CLIArgs { repo: String?; message: String?; image: String; args: [String] }` and `static func parse(_ argv: [String]) throws -> CLIArgs` (`INVALID_ARGS` on a missing image or a missing option value)
- `enum ImageReport { case ok(subject: String); case failed(code: ErrorCode, message: String, details: JSONValue?) }` and `static func parse(stdout: String, stderr: String, exitCode: Int32) throws -> ImageReport`:
  - Takes the last non-empty stdout line that parses as a JSON object with a boolean `ok`.
  - With no such line: `IMAGE_FAILED`, details `{exitCode, output}`, where output is the last 4000 characters of stdout+stderr.
  - `ok:true` with a non-zero exit, or a subject that is empty or contains `\n`/`\r`: `IMAGE_FAILED`.
  - An `ok:false` code we don't know becomes `.failed(.IMAGE_FAILED, …)`.
- `func errorJSON(_ e: RefactorError) -> String` and `func successJSON(...) -> String`. These build the stdout objects with `JSONEncoder` and `.sortedKeys`/`.withoutEscapingSlashes`; key order in the output does not matter.

- [ ] **Step 1: Write the failing tests** (swift-testing `@Test`):
  - `canonicalCommand(image: "img@sha256:1", args: ["check", "a b", "é", "\"q\"", "back\\slash", "tab\there", "nl\nx", "\u{1}", "/x"])` must equal exactly `{"args":["check","a b","é","\"q\"","back\\slash","tab\there","nl\nx","\u0001","/x"],"image":"img@sha256:1"}`, written as a Swift raw string.
  - `commitMessage` matches the format above with and without `message`; an empty or whitespace-only `message` is omitted.
  - `loadConfig`: no file gives the default; `{"coAuthor":"bot <b@x>"}` is read; `{"actions":{}}` is `INVALID_ARGS` with a message naming `actions`; `{"coAuthor":1}` is `INVALID_ARGS`; `{ nope` is `INVALID_ARGS`.
  - `CLIArgs.parse`:
    - `["--repo","r","--message","m","img","a","--repo","x"]` gives repo r, message m, image img, args `["a","--repo","x"]`.
    - `[]` is `INVALID_ARGS`, and so is `["--repo"]`.
    - `["img"]` gives args `[]`.
  - `ImageReport.parse`:
    - Log lines before the JSON are fine.
    - `{not json` and `{"ok":"x"}` lines are skipped.
    - No JSON with exit 3 gives `IMAGE_FAILED` with `exitCode` 3.
    - `ok:false` with `SYMBOL_NOT_FOUND` passes through; `ok:false` with `WHATEVER` becomes `IMAGE_FAILED`.
    - Subjects `""`, `"a\nb"` and `"a\rb"` give `IMAGE_FAILED`.
- [ ] **Step 2:** In `host/`, run `swift test`. Expected: compile errors or failures.
- [ ] **Step 3:** Implement the functions above.
- [ ] **Step 4:** Run `swift test` (all pass), then `bun run build-binary`. Expected: a statically linked `dist/jig` (`file` says "statically linked"). Running it with no args prints `{"ok":false,"error":{"code":"INVALID_ARGS",…}}` and exits 1.
- [ ] **Step 5:** Run `pnpm typecheck && bun test`. Expected: unchanged and passing (the TypeScript host still exists).
- [ ] **Step 6: Commit** with `feat(host): Swift package with CLI, config, report and commit-message logic`.

### Task 2: The git-based flow in Swift replaces the TypeScript host

**Files:**
- Create in `host/Sources/RefactorCommits/`:
  - `Run.swift`: runs a process and returns `{exitCode, stdout: Data, stderr: Data}`.
  - `Git.swift`
  - `Docker.swift`
  - `Workspace.swift`: export and capture.
  - `RunImage.swift`
- Modify: `host/Sources/jig/main.swift` (the real CLI: `exit(0/1)`, prints exactly one JSON object)
- Move: `app/test/{run,export}.test.ts` and `app/test/probe/` → `e2e/test/`, with a new `e2e/package.json` and `e2e/tsconfig.json` matching the sibling packages.
  - `run.test.ts` calls the binary through `Bun.spawn([binary, ...])`, with `binary = await buildBinary()` in `beforeAll`, and asserts on its JSON.
  - `export.test.ts` assertions that tested TypeScript internals become black-box runs through the probe image.
- Delete: `app/`, `packages/git/`, `packages/core/src/{commit,config}.ts` and their tests, plus anything only they used. Keep `makeRepo` in test-utils.
- Modify: `README.md`.
  - Usage becomes `dist/jig …` plus how to build it and how to install Swift with swiftly and the static SDK (the version and SDK name above).
  - Remove the "created files lose the exec bit" limit.
  - Add: ignored files are skipped and a `.gitignore` change is rejected; commit hooks do not run.
- Modify: `docs/superpowers/specs/2026-11-17-container-actions-design.md`. Add one line at the top saying that "How the binary runs it" is superseded by the Swift host design.

**Interfaces:**
- Consumes: everything from Task 1; `buildImages` from `scripts/build-images.ts`; `buildBinary` from `scripts/build-binary.ts`; the probe image (existing; add the modes the new tests need).
- Produces: `func runImage(repo: String, image: String, args: [String], message: String?) throws -> RunResult`, implementing steps 1–11 of the spec's flow in order.

- [ ] **Step 1: Move and update the e2e tests so they run the binary.**
  - Keep every existing case: replay for both images, odd args, binary file, gitlink, mode, logs/crash/fail/none, dirty tree, hidden edits, `IMAGE_NOT_FOUND` (both), CLI pass-through, export-ignore/export-subst, literal `*.ts` names, cleanup failure, bad subjects.
  - Change these per the spec:
    - "created path exists as an ignored host file" now expects that file not committed, the host file byte-identical, and `NO_CHANGES` when it was the only change.
    - "ignored symlink to an outside dir" expects the outside dir untouched and no commit of `build/x`.
    - "an edited executable keeps mode" stays.
  - Add:
    - `"a created executable keeps its mode"` (a probe mode that writes `new.sh` with mode 755, expecting `ls-files -s` to show `100755`).
    - `"a .gitignore change is IMAGE_FAILED"` (root and `sub/.gitignore`).
    - `"a .git folder created by the image is IMAGE_FAILED"` (root `.git/` and `sub/.git/`).
    - `"a folder replaced by a file commits"` (a probe mode that removes tracked `dir/x` and writes a file `dir`).
- [ ] **Step 2:** Run `bun test e2e`. Expected: failures (the binary still prints "not implemented").
- [ ] **Step 3:** Implement `Run`, `Git`, `Docker`, `Workspace` and `runImage` following the spec's flow.
  - Temporary index and folders are created with `FileManager` under the system temp dir and removed in `defer`; a failed removal writes one line to stderr.
  - `git add -A` for the capture runs with `GIT_INDEX_FILE`, `GIT_WORK_TREE` and `GIT_DIR` set explicitly, and `--literal-pathspecs` is not needed (no pathspecs).
  - The checks in step 6 compare `git ls-tree -r -z` (or `git diff-tree -r -z`) output of HEAD and T. They never touch the filesystem through symlinks.
- [ ] **Step 4:** Run `swift test` in `host/`, `bun run build-binary`, then `pnpm typecheck && bun test`. Expected: everything passes.
- [ ] **Step 5:** Delete the TypeScript host and update the README and spec line as listed. Rerun `pnpm typecheck && bun test`. Expected: passing.
- [ ] **Step 6: Commit** with `feat(host): Swift binary captures image output with git; TypeScript host removed`.
