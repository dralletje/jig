import Foundation
import Testing

@testable import Report

private func object(_ text: String) throws -> JSONValue {
  try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
}

@Test func errorCodesMatchTheTypeScriptList() {
  #expect(
    ErrorCode.allCases.map(\.rawValue) == [
      "SYMBOL_NOT_FOUND", "AMBIGUOUS_SYMBOL", "DIRTY_WORKTREE", "REFACTOR_UNAVAILABLE", "NO_CHANGES",
      "UNKNOWN_ACTION", "INVALID_ARGS", "IMAGE_NOT_FOUND", "IMAGE_FAILED", "REGISTRY_UNAVAILABLE", "INTERNAL",
    ])
}

@Test func hostCodesAreNotReportable() {
  #expect(ErrorCode.reportable("REGISTRY_UNAVAILABLE") == nil)
  #expect(ErrorCode.reportable("INTERNAL") == nil)
  #expect(ErrorCode.reportable("IMAGE_FAILED") == .IMAGE_FAILED)
}

@Test func errorJSONShape() throws {
  let text = errorJSON(RefactorError(code: .NO_CHANGES, instructions: "a/b\nnext line"))
  #expect(!text.contains("\n"))
  #expect(text == #"{"code":"NO_CHANGES","instructions":"a/b\nnext line","ok":false,"schema":"urn:jig:output:1"}"#)
}

@Test func theExampleFailureOutputIsWhatErrorJSONPrints() throws {
  let expected = try object(try example("output-failure.json"))
  guard case .object(let fields) = expected, case .string(let instructions) = fields["instructions"],
    case .string(let code) = fields["code"], let errorCode = ErrorCode(rawValue: code)
  else {
    Issue.record("unexpected example \(expected)")
    return
  }
  #expect(try object(errorJSON(RefactorError(code: errorCode, instructions: instructions))) == expected)
}

/// The success output for the example complete report is exactly `schemas/examples/output-success.json`.
@Test func theExampleSuccessOutputIsWhatSuccessJSONPrints() throws {
  let expected = try object(try example("output-success.json"))
  guard case .object(let fields) = expected, case .string(let commit) = fields["commit"],
    case .string(let parent) = fields["parent"], case .string(let image) = fields["image"],
    case .array(let args) = fields["args"], case .array(let files) = fields["filesChanged"]
  else {
    Issue.record("unexpected example \(expected)")
    return
  }
  guard case .ok(let report) = ImageReport.parse(stdout: try example("report-complete.json"), stderr: "", exitCode: 0)
  else {
    Issue.record("the complete example does not parse")
    return
  }
  let strings = { (values: [JSONValue]) in values.compactMap { if case .string(let s) = $0 { s } else { nil } } }
  let text = successJSON(
    commit: commit, parent: parent, image: image, args: strings(args), report: report, filesChanged: strings(files))
  #expect(!text.contains("\n"))
  #expect(try object(text) == expected)
}

@Test func successOutputKeys() throws {
  let report = Report(kind: .sweep, subject: "sweep(prettier format): x", summary: "Formatted.")
  let text = successJSON(commit: "c", parent: "p", image: "i", args: [], report: report, filesChanged: ["a.ts"])
  guard case .object(let fields) = try object(text) else {
    Issue.record("not an object")
    return
  }
  #expect(
    Set(fields.keys)
      == ["schema", "ok", "commit", "parent", "image", "args", "kind", "subject", "summary", "filesChanged"])
  #expect(fields["schema"] == .string("urn:jig:output:1"))
  #expect(fields["kind"] == .string("sweep"))
}

@Test func notesAreInTheOutputOnlyWhenThereAreSome() throws {
  let report = Report(kind: .sweep, subject: "s", summary: "x")
  let with = successJSON(commit: "c", parent: "p", image: "i", args: [], report: report, filesChanged: [], notes: ["x"])
  guard case .object(let withFields) = try object(with) else {
    Issue.record("not an object")
    return
  }
  #expect(
    Set(withFields.keys)
      == ["schema", "ok", "commit", "parent", "image", "args", "kind", "subject", "summary", "filesChanged", "notes"])
  #expect(withFields["notes"] == .array([.string("x")]))
  let without = successJSON(commit: "c", parent: "p", image: "i", args: [], report: report, filesChanged: [], notes: [])
  #expect(!without.contains("notes"))
}
