import Testing

@testable import RefactorCLI
import Report

private func result(notes: [String]) -> RunResult {
  RunResult(
    commit: "c", parent: "p", image: "ghcr.io/acme/x:1@sha256:" + String(repeating: "a", count: 64), args: ["a"],
    report: Report(kind: .sweep, subject: "s", summary: "x"), filesChanged: ["a.ts"],
    notes: notes)
}

@Test func aNoteBecomesTheNotesKey() {
  let note = "The registry ghcr.io could not be reached; used the version of the tag last seen."
  #expect(result(notes: [note]).json.contains(#""notes":["\#(note)"]"#))
}

@Test func noNotesLeaveTheKeyOut() {
  #expect(!result(notes: []).json.contains("notes"))
}
