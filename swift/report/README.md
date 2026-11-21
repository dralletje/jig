# report (module `Report`)

What the binary reads from an image and what it prints and commits. No dependencies, no I/O besides
JSON decoding.

Public API:
- `ErrorCode` (every code of the output), `RefactorError` (`code` + `instructions`; `RefactorError.from(_:)`
  turns any error into one), `RefactorErrorConvertible` (lets an error of another package say which
  `RefactorError` it is: `CommandFailed`, `ExecutableNotFound`, `NonUTF8Path`).
- `JSONValue`; `Termination` (`.exited(code)` / `.signaled(n)`, described as "exit code N" / "killed by
  signal N").
- Image report v1: `reportSchema`, `ImageReport.parse(stdout:stderr:termination:)` → `.ok(Report)` or
  `.failed(RefactorError)`; `Report` (`kind`, `subject`, `summary`), `ActionKind`.
- `canonicalCommand(image:args:)` (the `Refactor-Command` JSON), `commitMessage(report:message:image:args:coAuthor:)`.
- Output v1: `outputSchema`, `errorJSON(_:)`, `successJSON(...)`.
- Verify v1: `verifySchema`, `RecordedCommand`, `parseRecordedCommand(json:kind:subject:)`,
  `verdict(recorded:replayed:treesEqual:)` (`identical` when the trees, the kind and the subject match,
  `different` otherwise), `CommitVerification`, `Verdict`, `Mismatch`, `verifyJSON(_:)`.

Canonical JSON (for `Refactor-Command`) is internal; the tests check it against JavaScript's output.
