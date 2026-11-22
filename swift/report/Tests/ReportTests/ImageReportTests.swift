import Foundation
import Testing

@testable import Report

/// The repository root: this file is `swift/report/Tests/ReportTests/ImageReportTests.swift`.
let repoRoot = URL(fileURLWithPath: #filePath)
  .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
  .deletingLastPathComponent()

/// `schemas/examples/<name>` as text on one line (the image prints its report on one line).
func example(_ name: String) throws -> String {
  let data = try Data(contentsOf: repoRoot.appendingPathComponent("schemas/examples").appendingPathComponent(name))
  return String(decoding: try JSONDecoder().decode(JSONValue.self, from: data).encoded(), as: UTF8.self)
}

private let schema = #""schema":"urn:jig:report:1""#

/// A v1 success report line with `fields` (JSON members, without braces) replacing the defaults; an empty
/// value leaves the field out.
private func ok(_ fields: [String: String] = [:]) -> String {
  var all: [String: String] = [
    "schema": #""urn:jig:report:1""#, "ok": "true", "kind": #""refactor""#, "subject": #""refactor(x): S""#,
    "summary": #""Did it.""#,
  ]
  for (key, value) in fields { all[key] = value }
  return "{" + all.keys.sorted().compactMap { key in all[key].flatMap { $0.isEmpty ? nil : "\"\(key)\":\($0)" } }
    .joined(separator: ",") + "}"
}

private func failure(_ stdout: String, stderr: String = "", exitCode: Int32 = 0) -> RefactorError {
  let report = ImageReport.parse(stdout: stdout, stderr: stderr, exitCode: exitCode)
  guard case .failed(let error) = report else {
    Issue.record("expected a failure, got \(report)")
    return RefactorError(code: .INTERNAL, instructions: "")
  }
  return error
}

private func success(_ stdout: String) -> Report? {
  let report = ImageReport.parse(stdout: stdout, stderr: "", exitCode: 0)
  guard case .ok(let value) = report else {
    Issue.record("expected success, got \(report)")
    return nil
  }
  return value
}

@Test func minimalReportParses() {
  let line = #"{"schema":"urn:jig:report:1","ok":true,"kind":"sweep","subject":"sweep(prettier format): x","summary":"Formatted."}"#
  #expect(
    ImageReport.parse(stdout: line, stderr: "", exitCode: 0)
      == .ok(Report(kind: .sweep, subject: "sweep(prettier format): x", summary: "Formatted.")))
}

@Test func statusAndEffectAreUnknownFields() {
  let line =
    #"{"schema":"urn:jig:report:1","ok":true,"kind":"sweep","subject":"sweep(prettier format): x","summary":"Formatted.","status":"complete","effect":[]}"#
  let error = failure(line)
  #expect(error.code == .IMAGE_FAILED)
  #expect(error.instructions.contains("unknown field(s) effect, status"), "\(error.instructions)")
}

@Test func subjectOfAnotherKindIsImageFailed() {
  let error = failure(ok(["kind": #""rewrite""#, "subject": #""refactor(x): y""#]))
  #expect(error.code == .IMAGE_FAILED)
  #expect(error.instructions.contains("the subject must start with \"rewrite(\" for kind rewrite"), "\(error.instructions)")
}

@Test func reportAfterLogLines() throws {
  let report = success("starting\nworking...\n\(ok())\n\n")
  #expect(report == Report(kind: .refactor, subject: "refactor(x): S", summary: "Did it."))
}

@Test func reportSkipsLinesThatAreNotReports() throws {
  #expect(success("\(ok())\n{not json\n{\"ok\":\"x\"}\n[1]\n")?.subject == "refactor(x): S")
}

@Test func reportWithCRLFLineEndings() throws {
  #expect(success("log\r\n\(ok())\r\n")?.subject == "refactor(x): S")
}

@Test func theExampleReportsParse() throws {
  let complete = try #require(success(try example("report-complete.json")))
  #expect(
    complete
      == Report(
        kind: .refactor, subject: "refactor(typescript rename): foo → bar in src/a.ts",
        summary: "Renamed `foo` to `bar` in src/a.ts (3 references in 2 files)."))
  let failed = failure(try example("report-failure.json"), exitCode: 1)
  #expect(failed.code == .REFACTOR_UNAVAILABLE)
  #expect(failed.instructions.hasPrefix("`sendEmail` is passed as a callback in src/jobs.ts:40."))
}

@Test func noReportIsImageFailed() throws {
  let error = failure("some log\n", stderr: "boom", exitCode: 3)
  #expect(error.code == .IMAGE_FAILED)
  #expect(
    error.instructions
      == "The image printed no report (exit code 3); nothing was changed in the repository. Check the arguments "
      + "against the action's usage; if they are right, report the image as broken. The end of its output:\nsome log\nboom")
}

@Test func noReportOutputIsTheLast4000Characters() throws {
  let error = failure(String(repeating: "a", count: 5000), stderr: "zz", exitCode: 1)
  let tail = try #require(error.instructions.components(separatedBy: "output:\n").last)
  #expect(tail.count == 4000)
  #expect(tail.hasSuffix("azz"))
}

@Test(arguments: [
  #"{"ok":true,"kind":"refactor","subject":"S"}"#,
  #"{"schema":"urn:jig:report:0","ok":true,"subject":"S"}"#,
  #"{"schema":5,"ok":false,"code":"INVALID_ARGS","instructions":"x"}"#,
  #"{"ok":false,"error":{"code":"SYMBOL_NOT_FOUND","message":"no foo"}}"#,
])
func unknownOrMissingSchemaIsImageFailed(line: String) throws {
  let error = failure(line + "\n", exitCode: 1)
  #expect(error.code == .IMAGE_FAILED)
  #expect(error.instructions.contains("this jig supports only \"urn:jig:report:1\""))
}

@Test func okWithNonZeroExitIsImageFailed() throws {
  let error = failure(ok() + "\n", exitCode: 2)
  #expect(error.code == .IMAGE_FAILED)
  #expect(error.instructions.contains("exited with 2"))
}

@Test(arguments: [
  ("subject", "5", "subject"),
  ("subject", "", "subject is missing"),
  ("subject", #""""#, "subject is empty"),
  ("subject", #""a\nb""#, "line break"),
  ("subject", #""a\rb""#, "line break"),
  ("summary", "", "summary is missing"),
  ("summary", #""""#, "summary is empty"),
  ("summary", #"" \n\t ""#, "summary is empty"),
  ("kind", "", "kind is missing"),
  ("kind", #""codemod""#, "kind"),
  ("kind", #""Sweep""#, "kind"),
  ("effectHash", #""sha256:00""#, "unknown field(s) effectHash"),
  ("locations", "[]", "unknown field(s) locations"),
  ("misses", "[]", "unknown field(s) misses"),
])
func invalidSuccessIsImageFailed(field: String, value: String, says: String) throws {
  let error = failure(ok([field: value]) + "\n")
  #expect(error.code == .IMAGE_FAILED)
  #expect(error.instructions.contains(says), "\(error.instructions)")
  #expect(error.instructions.hasPrefix("The image's report is not a valid urn:jig:report:1 report: "))
}

@Test func summaryIsTidiedForTheOutputAsForTheCommit() throws {
  let report = try #require(success(ok(["summary": #""Did:  \n  a.ts \n\n""#])))
  #expect(report.summary == "Did:\n  a.ts")
}

@Test func knownErrorPassesThrough() throws {
  let error = failure(#"{\#(schema),"ok":false,"code":"SYMBOL_NOT_FOUND","instructions":"No foo. Check it."}"#, exitCode: 1)
  #expect(error == RefactorError(code: .SYMBOL_NOT_FOUND, instructions: "No foo. Check it."))
}

@Test(arguments: ["WHATEVER", "INTERNAL", "REGISTRY_UNAVAILABLE"])
func unknownOrHostErrorCodeBecomesImageFailed(code: String) throws {
  let error = failure(#"{\#(schema),"ok":false,"code":"\#(code)","instructions":"odd"}"#, exitCode: 4)
  #expect(error == RefactorError(code: .IMAGE_FAILED, instructions: "The image failed with \(code) (exit code 4): odd"))
}

@Test(arguments: [
  (#"{\#(schema),"ok":false,"code":"INVALID_ARGS"}"#, "needs non-empty instructions"),
  (#"{\#(schema),"ok":false,"code":"INVALID_ARGS","instructions":""}"#, "needs non-empty instructions"),
  (#"{\#(schema),"ok":false,"instructions":"x"}"#, "needs a code"),
  (#"{\#(schema),"ok":false,"code":"INVALID_ARGS","instructions":"x","details":{}}"#, "unknown field(s) details"),
])
func invalidFailureIsImageFailed(line: String, says: String) throws {
  let error = failure(line, exitCode: 1)
  #expect(error.code == .IMAGE_FAILED)
  #expect(error.instructions.contains(says), "\(error.instructions)")
}

@Test func kindRawValues() {
  #expect(ActionKind.allCases.map(\.rawValue) == ["refactor", "sweep", "rewrite"])
}
