# Minimal Image Report v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut image report v1 down to `{schema, ok, kind, subject, summary}` (or a failure). Remove status, effect, locations, misses, the effect hash, `verify --on` and `same-effect` from every image, the host, the schemas and the docs.

**Architecture:** The TypeScript side (`packages/core` and the actions) and the Swift side (`swift/report`) only share the JSON shape the schemas pin. So the two sides change in parallel, and the cli and the end-to-end tests change last, against both.

**Tech Stack:** TypeScript on Node 26 (type stripping, `node --test`) and Swift 6.4.2 (swift-testing).

**Spec:** `docs/superpowers/specs/2026-11-20-minimal-report-design.md`

## Global Constraints

- The schema ids stay the same: `urn:jig:report:1`, `urn:jig:output:1` and `urn:jig:verify:1`. They change in place, without a version bump and with no compatibility code for the old fields.
- A success report has exactly the keys `schema, ok, kind, subject, summary`. Any other key makes the report `IMAGE_FAILED` (`unknown field(s) …`), the same as today.
- `kind` is one of `refactor | sweep | rewrite`. `subject` is one non-empty line that starts with `<kind>(`. `summary` is not blank.
- The commit trailers, in order: `Refactor-Command`, `Refactor-Kind`, `Co-Authored-By`.
- The verify verdicts are `identical | different | failed | skipped | invalid`.
- Leave `Refactor-Command`'s canonical JSON (`canonicalCommand`, `javaScriptJSONString`) unchanged.
- Repo style: inline strings over constants, explicit over DRY. Read and write files with the Read, Write and Edit tools; run shell commands through `nux`.
- Run the TS tests with `NODE= scripts/test-packages.sh`. Run the Swift tests per package with `swift test` (use the swiftly path from `scripts/test-swift.sh` when `swift` isn't on PATH), and all of them with `scripts/test-swift.sh`.
- Commit each task to its own branch or worktree, ending each message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A partial result loses what to do.** A partial action (for example `remove-console` leaving calls used as values) must still list each place it skipped, as `path:line: reason`, plus what to do about it, in `summary`. The person now reads only the summary. This is covered by Task 2's console test.
2. **An old image still sends `status` or `effect`.** The host must reject it as `IMAGE_FAILED` with a message naming the unknown fields, not crash or silently accept it. This is covered by Task 3's `ImageReportTests`.
3. **Verifying a commit made before this change.** Its extra `Refactor-Status` and `Refactor-Effect` trailers must be ignored, not cause `invalid`. This is covered by Task 3's `parseRecordedCommand` signature and Task 4's verify test.
4. **The subject alone differs.** That case was `same-effect` before and is `different` now, with a `subject` mismatch listed. This is covered by Task 3's `VerifyTests`.
5. **`--on` is passed.** It must be `INVALID_ARGS` with the usage text, the same as any other unknown option, never treated as a commit. This is covered by Task 4.

---

### Task 1: `packages/core` report

**Files:**
- Modify: `packages/core/src/report.ts`, `packages/core/src/types.ts`, `packages/core/src/index.ts` (exports)
- Test: `packages/core/test/report.test.ts`

**Interfaces:**
- Produces:
  - `type ActionResult = { summary: string }`
  - `type OkReport = { schema: "urn:jig:report:1"; ok: true; kind: ActionKind; subject: string; summary: string }`
  - `okReport(kind: ActionKind, label: string, description: string, result: ActionResult): OkReport`
  - `failedReport` and `runEntrypoint` are unchanged.
  - Kept: `listLines` and `plural`.
- Removed:
  - `EffectEntry`, `Location`, `MissAt`, `Miss`, `Status` and `Json`.
  - `firstChangedLines` and `checkPositionFree`.
  - `canonicalJson`, if nothing outside `report.ts` and its test still imports it after Tasks 2 and 2b. Check with `search canonicalJson packages`.

- [ ] **Step 1: Rewrite `report.test.ts` for the new shape.** Delete every test about effects, misses, status, locations and sorting. Keep or add:
  - `okReport("refactor", "rename", "a → b", { summary: "Renamed a.\n\n" })` deep-equals `{ schema: "urn:jig:report:1", ok: true, kind: "refactor", subject: "refactor(rename): a → b", summary: "Renamed a." }`.
  - It throws on a blank summary, and on a description containing `\n`.
  - `Object.keys(okReport(...))` deep-equals `["schema","ok","kind","subject","summary"]`.
- [ ] **Step 2: Run the tests and see them fail.** Run `NODE= scripts/test-packages.sh --test-name-pattern=okReport`. Expect FAIL, because the old report still has `status` and `effect`.
- [ ] **Step 3: Implement it.** Change `types.ts` and `okReport` to the signatures above, and drop the removed exports.
- [ ] **Step 4: Run the core tests and see them pass.** Run `NODE= scripts/test-packages.sh packages/core/test`. Expect PASS. The other packages fail until Task 2.
- [ ] **Step 5: Commit** with the message `core: minimal report v1 (kind, subject, summary)`.

### Task 2: TypeScript engine actions

**Files:**
- Modify: every action in `packages/engine-typescript/src/` that returns `effect`, `locations`, `status` or `misses`:
  - `actions.ts`, `default-to-named.ts`, `return-types.ts`, `unused-variable.ts`, `extensions.ts`, `barrels.ts`, `convert-function.ts`, `lift.ts`, `params.ts`, `files.ts`, `rename-files.ts`, `template-string.ts`, `inline.ts`, `console.ts`, `imports.ts` and `subpath-imports.ts`;
  - `engine.ts`: remove `declarationPath` and `occurrence` only if no action still uses them.
- Test: `packages/engine-typescript/test/*.test.ts`

**Interfaces:**
- Consumes: Task 1's `ActionResult = { summary }`.
- Produces: each action's `run` returns `{ summary }` only.

- [ ] **Step 1: Update the tests.** Drop assertions on `effect`, `locations`, `status` and `misses`. Where a test checked a miss, assert the summary text instead. For `remove-console` with one call used as a value in `src/a.ts` line 3, the summary contains:
  - `left 1 call used as a value`
  - `src/a.ts:3: `
  - an instruction line telling the reader to rewrite that code by hand.

  Do the same for every other partial action:
  - `default-to-named`
  - `return-types`
  - `rename-files`
  - `imports`
  - `subpath-imports`

  For each, the summary lists every place it skipped as `path:line: reason`, followed by what to do.
- [ ] **Step 2: Run the tests and see them fail.** Run `NODE= scripts/test-packages.sh packages/engine-typescript/test`. Expect FAIL.
- [ ] **Step 3: Implement it.** Make each action return only `summary`. Partial actions append a block like this:

  ```
  Not handled (N):
    path:line: reason
      instructions
  ```

  It uses `listLines`-style indentation and current line numbers, which are fine now that nothing is replayed on moved code. Remove the code that only built effects and misses.
- [ ] **Step 4: Run the tests and see them pass.** Run `NODE= scripts/test-packages.sh packages/engine-typescript/test` and `pnpm -r typecheck` (or the repo's typecheck command). Expect PASS with 0 errors.
- [ ] **Step 5: Commit** with the message `engine-typescript: report only a summary; partial places listed in it`.

### Task 2b: prettier and codemod actions

**Files:**
- Modify: `packages/action-prettier/src/main.ts`, `packages/action-codemod/src/main.ts`
- Test: `packages/action-prettier/test/format.test.ts`, `packages/action-codemod/test/codemod.test.ts`

**Interfaces:** the same as Task 2.

- [ ] **Step 1: Update the tests.** Each test asserts the report's keys are exactly `schema, ok, kind, subject, summary`, and drops its effect and locations assertions.
- [ ] **Step 2: Run the tests and see them fail.** Run `NODE= scripts/test-packages.sh packages/action-prettier/test packages/action-codemod/test`. Expect FAIL.
- [ ] **Step 3: Implement it.** Return `{ summary }` only.
- [ ] **Step 4: Run the tests and see them pass.** Run the same command. Expect PASS.
- [ ] **Step 5: Commit** with the message `prettier, codemod: minimal report`.

### Task 3: `swift/report`, schemas and docs

**Files:**
- Modify:
  - `swift/report/Sources/Report/`: `ImageReport.swift`, `CommitMessage.swift`, `Verify.swift`, `Output.swift` and `CanonicalJSON.swift`;
  - `schemas/`: `report-1.schema.json`, `output-1.schema.json` and `verify-1.schema.json`, plus the examples;
  - `swift/report/README.md`, `README.md` ("Image report v1", "Declaration paths", the `verify` section) and `TODO.md` (drop "rebase-proof refactors" from the bigger ideas, and reword line 72's "misses").
- Delete: `schemas/examples/report-partial.json` and `schemas/examples/verify-1-on.json`
- Test: `swift/report/Tests/ReportTests/`: `ImageReportTests`, `CommitMessageTests`, `VerifyTests`, `OutputTests` and `ReportChecksTests`

**Interfaces:**
- Produces:
  - `struct Report { kind: ActionKind; subject: String; summary: String }`, with `init(kind:subject:summary:)`.
  - `struct RecordedCommand { image, args, kind, subject }`, with `init(image:args:kind:subject:)`.
  - `parseRecordedCommand(json: String, kind: String, subject: String) throws -> RecordedCommand`
  - `verdict(recorded: RecordedCommand, replayed: Report, treesEqual: Bool) -> (Verdict, [Mismatch])`
  - `CommitVerification(commit:verdict:command:filesDiffering:mismatches:code:reason:instructions:)`: `replayedEffect` is removed.
  - `verifyJSON(_ results: [CommitVerification]) -> (json: String, ok: Bool)`
  - `successJSON(commit:parent:image:args:report:filesChanged:notes:)`: unchanged signature. Its output keys are `schema, ok, commit, parent, image, args, kind, subject, summary, filesChanged, notes?`.
  - `commitMessage(report:message:image:args:coAuthor:)`: unchanged signature.
- Removed:
  - `Status`, `Location`, `MissAt`, `Miss`, `effectHash` and `Report.effectHash`.
  - `canonicalOrderProblem`, `integersOnly` and `Verdict.sameEffect`.
  - `canonicalJSON` stays (used by `canonicalCommand`).

- [ ] **Step 1: Rewrite the tests.** Delete the tests for removed things, and port nothing. Add or keep:
  - **ImageReportTests:**
    - `{"schema":"urn:jig:report:1","ok":true,"kind":"sweep","subject":"sweep(format): x","summary":"Formatted."}` parses to `.ok(Report(kind: .sweep, subject: "sweep(format): x", summary: "Formatted."))`.
    - The same report plus `"status":"complete","effect":[]` is `.failed` with code `IMAGE_FAILED`, and its instructions contain `unknown field(s) effect, status`.
    - A subject `refactor(x): y` with kind `rewrite` stays `IMAGE_FAILED`.
  - **CommitMessageTests:** the message for the report above, with no `--message`, equals `"sweep(format): x\n\nFormatted.\n\nRefactor-Command: {\"args\":[],\"image\":\"i@sha256:…\"}\nRefactor-Kind: sweep\nCo-Authored-By: <coAuthor>\n"`.
  - **VerifyTests:**
    - Trees equal, with kind and subject equal: `(.identical, [])`.
    - Trees differ: `.different` with no mismatches.
    - The subject alone differs: `.different` with `[Mismatch(field: "subject", …)]`.
    - The kind differs: `.different`, with the kind mismatch first.
    - `verifyJSON` output has no `on`, `recordedEffect` or `replayedEffect` keys, and `ok` is true only when every non-skipped commit is `identical`.
  - **OutputTests:** `successJSON` keys are exactly the list above, and `notes` appears only when there are notes.
- [ ] **Step 2: Run the tests and see them fail.** Run `swift test` in `swift/report`. Expect a compile or test FAIL.
- [ ] **Step 3: Implement it** with the signatures above.
  - `ImageReport.parse` allows the success keys `["schema","ok","kind","subject","summary"]`.
  - `problems` keeps three checks: the one-line subject, the non-blank summary, and the `<kind>(` prefix.
  - `verdict` returns `.identical` only when `treesEqual` holds and nothing mismatched, and `.different` otherwise. It compares kind, then subject.
- [ ] **Step 4: Update the schemas, examples and docs to match.**
  - `report-1`: in the success branch, `required` and `properties` list only `schema, ok, kind, subject, summary`, with `additionalProperties: false`.
  - `output-1`: the success keys listed above.
  - `verify-1`:
    - remove `on`, `recordedEffect` and `replayedEffect`;
    - set the verdict enum to `identical, different, failed, skipped, invalid`;
    - limit the mismatch `field` enum to `kind, subject`.
  - Update `report-complete.json`, `output-success.json` and `verify-1-range.json` to match.
  - The README sections describe the minimal protocol in the spec's words. Remove "Declaration paths" entirely.
- [ ] **Step 5: Run the tests and see them pass.** Run `swift test` in `swift/report`, and in `swift/git`, where the `TrailersTests` fixtures may keep their old trailer text (they test parsing only). Expect PASS.
- [ ] **Step 6: Commit** with the message `report: minimal v1 (kind, subject, summary); verify without effects or --on`.

### Task 4: cli, probe image and end-to-end tests (after Tasks 1–3)

**Files:**
- Modify: `swift/cli/Sources/RefactorCLI/Verify.swift`, `swift/cli/Sources/RefactorCLI/CLIArgs.swift`, the cli's run path (wherever it reads `report.status`, `effect` or `misses`), and `swift/cli/README.md`
- Modify: `swift/cli/Tests/IntegrationTests/probe/probe.ts`, which emits only the new keys. Keep one probe mode that emits an extra `"status"` key, for the rejection test.
- Test: `swift/cli/Tests/IntegrationTests/`: `RunTests`, `VerifyTests`, `SandboxesTests`, and the per-action test files that assert `Refactor-Status`, `Refactor-Effect`, `effect`, `misses` or `status`.

**Interfaces:**
- Consumes: Task 3's signatures.
- Produces: `verifyCommits(repo: String, target: String, sandbox: any Sandbox) throws -> [CommitVerification]`. `CLIArgs`' verify case has no `on`.

- [ ] **Step 1: Update the tests.**
  - `VerifyTests`:
    - `jig verify --on HEAD~1 HEAD` exits with `INVALID_ARGS`, and its instructions contain the verify usage line without `--on`.
    - A commit whose message also carries `Refactor-Status: complete` and `Refactor-Effect: sha256:00…` (amend a jig commit's message to add them) still verifies as `identical`.
  - `RunTests`:
    - A commit's trailer lines are exactly `Refactor-Command`, `Refactor-Kind` and `Co-Authored-By`, in that order.
    - The probe's `status` mode gives `IMAGE_FAILED` naming `status`.
  - Per-action tests: replace effect and miss assertions with summary assertions, and remove the trailer assertions for the removed trailers.
- [ ] **Step 2: Rebuild the images and the binary, then run the tests and see them fail.** Run `scripts/build-images.sh`, then `scripts/build-binary.sh`, then `swift test` in `swift/cli`. Expect a compile or test FAIL.
- [ ] **Step 3: Implement it.**
  - Remove `--on` from `CLIArgs` (the usage text and its parsing) and from `verifyCommits`.
  - `readRecorded` requires only `Refactor-Kind` beside `Refactor-Command`, and ignores any other trailers.
  - `verifyOne` always compares trees.
- [ ] **Step 4: Run the whole suite and see it pass.** Run `NODE= scripts/test-packages.sh`, the typecheck, `scripts/build-images.sh`, `scripts/build-binary.sh` and `scripts/test-swift.sh`. Expect every package green.
- [ ] **Step 5: Commit** with the message `cli: verify without --on; minimal report end to end`.

## Order

- Tasks 1 and 3 run in parallel.
- Tasks 2 and 2b start after Task 1.
- Task 4 runs once 1, 2, 2b and 3 are merged into `main`.
