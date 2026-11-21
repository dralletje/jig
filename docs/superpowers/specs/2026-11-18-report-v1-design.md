# Report v1: versioned, schema'd reports with status, summary, effect and misses

Status: approved in conversation ("Give that first version a try. On partial I want a special property
that describes the missers. It's just version one so lets see how far it gets us"). Replaces the
report shape of the earlier specs. See `AGENTS.md` (no Bun; symlinks deferred).

## Why

Reports so far only said "done, here is the subject". The owner wants more for agents and reviewers:
whether the refactor is complete or partial, a user-facing description of what happened (it may hold
an ASCII graph), a structured position-free effect whose hash stays the same when the refactor is
replayed after a rebase (code moved around it, same effect), and for partial refactors a description
of the places it could not handle.

## Versioning

- Every image report carries `"schema": "urn:jig:report:1"`. The binary's own stdout
  carries `"schema": "urn:jig:output:1"`. A `$id` only needs to be a URI, so URNs work
  without hosting anything.
- JSON Schemas (draft 2020-12) in `schemas/report-1.schema.json` and `schemas/output-1.schema.json`,
  `$id` set to those URNs. They are the reference; tests validate sample documents against them.
- The binary rejects a report whose `schema` it does not know (or that is missing) with
  `IMAGE_FAILED` and instructions naming the versions it supports.

## Image report v1

Failure:
```json
{ "schema": "urn:jig:report:1", "ok": false,
  "code": "REFACTOR_UNAVAILABLE",
  "instructions": "`sendEmail` is passed as a callback in src/jobs.ts:40. Wrap that use in an arrow function first, then run again." }
```
- `code`: one of the error codes. `instructions`: what the agent should do next, in plain words
  (replaces `message` and `details`).

Success:
```json
{ "schema": "urn:jig:report:1", "ok": true,
  "kind": "refactor",
  "status": "complete",
  "subject": "refactor(typescript-rename): foo → bar in src/a.ts",
  "summary": "Renamed `foo` to `bar` (3 files, 7 references).",
  "effect": [ { "op": "rename", "symbol": "src/a.ts#foo", "to": "bar" } ],
  "locations": [ { "path": "src/a.ts", "line": 3 } ],
  "misses": []
}
```
- `kind`: `refactor` | `sweep` | `rewrite` (as before).
- `status`: `complete` | `partial`. The status the tool assumes for its result. Some actions can end
  either way.
- `subject`: `<kind>(<label>): <description>`, one line, as before.
- `summary`: user-facing description of what happened, plain text, may be several lines and hold an
  ASCII graph. Written only from the effect (never from line numbers), so replaying the refactor on a
  moved codebase gives the same text.
- `effect`: array of objects, each with an `op` string plus fields, describing what changed with
  position-free identifiers: declaration paths (`src/orders.ts#processOrder`,
  `src/a.ts#OrderService.save`, `src/a.ts#outer.helper`; grammar in the README, "Declaration paths":
  JSON-quoted non-identifier names, `static `/`get `/`set ` member prefixes, `#n` for the n-th same-named
  sibling) and occurrence indices ("the 2nd call to `sendEmail` inside `src/orders.ts#processOrder`" →
  `{"in": "src/orders.ts#processOrder", "occurrence": 2, "what": "call to sendEmail"}`, the same shape
  as a miss's `at`). Never line or column numbers. Sorted deterministically.
- `locations`: current positions of the changed places (`path`, `line`, optional `column`), for
  convenience; not part of the effect.
- `misses`: required and non-empty when `status` is `partial`, empty or absent when `complete`. Each
  miss describes a place the refactor could not handle:
  ```json
  { "at": { "in": "src/jobs.ts#scheduleEmails", "occurrence": 1, "what": "use of sendEmail" },
    "location": { "path": "src/jobs.ts", "line": 40 },
    "reason": "sendEmail is passed as a callback here",
    "instructions": "Pass tenantId into scheduleEmails by hand, or wrap the callback." }
  ```
  `at` is position-free (part of what the hash covers) and has exactly this shape: `in` (required,
  a declaration path), `occurrence` (optional, integer ≥ 1) and `what` (optional, what is counted) —
  what `engine.occurrence` returns, plus `what`. `location` is the current position. `reason` is one
  line (hashed); `instructions` may be several lines.

## The binary

- Validates the report shape (Codable types mirroring the schema). Unknown `schema`, a `partial`
  without misses, a `complete` with misses, or a missing required field → `IMAGE_FAILED`.
- Computes the effect hash itself: `sha256:` + hex SHA-256 of the canonical JSON of
  `{ "effect": <effect>, "misses": [<each miss's at + reason>] }` (keys sorted, no whitespace, the same
  canonical encoder as `Refactor-Command`). Images never send a hash.
- Commit message:
  ```
  <subject>

  <summary>

  Misses:                       (only when partial)
  - <location path:line> <reason>
    <instructions>

  <--message, when given>

  Refactor-Command: {...}
  Refactor-Kind: <kind>
  Refactor-Status: <complete|partial>
  Refactor-Effect: sha256:<hex>
  Co-Authored-By: <coAuthor>
  ```
  Every line of a miss's instructions is indented two spaces under its miss (line endings normalised
  to `\n`, trailing blank lines dropped). The summary is tidied the same way (trailing whitespace and
  blank lines at the ends dropped), and the output's `summary` and miss `instructions` carry the same
  tidied text as the commit.
- Output v1:
  - success: `{"schema":"urn:jig:output:1","ok":true,"commit","parent","image","args",
    "kind","status","subject","summary","effect","effectHash","locations","misses","filesChanged"}`
  - failure: `{"schema":"urn:jig:output:1","ok":false,"code","instructions"}`. The binary's
    own errors (dirty tree, image not found, …) use the same shape with instructions.

## Scope of this change

- Core: `Report` v1 types, `okReport` builds the v1 success shape from the action's result; actions
  return `{ summary, effect, locations?, status?, misses? }` from `run` (status defaults to complete).
  `RefactorError` carries instructions (its message is the instructions).
- A helper for position-free declaration paths (`declarationPath(node)`), shared by all actions.
- All existing actions (rename, extract, lift-out, move-file, organize-imports, format,
  remove-barrels, add-import-extensions) produce a real summary and effect.
- Host: v1 parsing and validation, effect hash, commit message, output v1; the probe test image
  reports v1.
- Tests: schema validation of samples (TypeScript side, with a JSON Schema validator as a dev
  dependency), Swift unit tests for parsing/validation/hash/commit message, integration tests updated,
  plus one test that replays a rename after unrelated code moved above the symbol and gets the same
  `Refactor-Effect` with a different tree.
- README: the report and output formats, with an example of each.
