import Foundation

/// The image report version this binary reads (`schemas/report-1.schema.json`).
public let reportSchema = "urn:jig:report:1"
/// The version of what this binary prints (`schemas/output-1.schema.json`).
public let outputSchema = "urn:jig:output:1"

/// What a commit does, from the image's report; recorded in the `Refactor-Kind` trailer.
public enum ActionKind: String, CaseIterable, Codable, Equatable, Sendable {
  /// Targeted and behaviour-preserving (rename, extract, ...).
  case refactor
  /// A repo-wide or many-file mechanical convention change, behaviour-preserving (format, ...).
  case sweep
  /// Changes behaviour in a simple, repetitive way (removing `console.log` calls, ...).
  case rewrite
}

/// A valid v1 success report: what kind of commit it is, its subject, and what happened (partial results
/// included) for people.
public struct Report: Codable, Equatable, Sendable {
  public var kind: ActionKind
  public var subject: String
  public var summary: String

  public init(kind: ActionKind, subject: String, summary: String) {
    self.kind = kind
    self.subject = subject
    self.summary = summary
  }
}

/// What the image said on its last report line, or why it failed.
public enum ImageReport: Equatable, Sendable {
  case ok(Report)
  case failed(RefactorError)

  /// The last non-empty stdout line that is a JSON object with a boolean `ok`; logs before it are fine.
  static func findReport(_ stdout: String) -> (line: String, fields: [String: JSONValue])? {
    // Split on scalars, not Characters: "\r\n" is one Character and would not split on "\n".
    let lines = stdout.unicodeScalars.split(separator: "\n", omittingEmptySubsequences: false)
      .map { String(String.UnicodeScalarView($0)) }
      .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    for line in lines.reversed() {
      guard let value = try? JSONDecoder().decode(JSONValue.self, from: Data(line.utf8)),
        case .object(let fields) = value, case .bool = fields["ok"]
      else { continue }
      return (line, fields)
    }
    return nil
  }

  private static func broken(_ problem: String) -> ImageReport {
    .failed(
      RefactorError(
        code: .IMAGE_FAILED,
        instructions: "The image's report is not a valid \(reportSchema) report: \(problem). The image is broken; "
          + "nothing was changed in the repository. Report it to its maintainers, who can check the report against "
          + "schemas/report-1.schema.json."))
  }

  /// The image's report, validated against report v1, or the image's own error. Anything else (no
  /// report, another `schema`, a shape v1 does not allow, an error code we do not know) is `IMAGE_FAILED`.
  public static func parse(stdout: String, stderr: String, exitCode: Int32) -> ImageReport {
    parse(stdout: stdout, stderr: stderr, termination: .exited(exitCode))
  }

  /// The same, for an image process that ended as `termination` (killed by a signal, say).
  public static func parse(stdout: String, stderr: String, termination: Termination) -> ImageReport {
    guard let (line, fields) = findReport(stdout) else {
      return .failed(
        RefactorError(
          code: .IMAGE_FAILED,
          instructions: "The image printed no report (\(termination)); nothing was changed in the repository. "
            + "Check the arguments against the action's usage; if they are right, report the image as broken. "
            + "The end of its output:\n" + String((stdout + stderr).suffix(4000))))
    }

    guard case .string(reportSchema) = fields["schema"] else {
      let found: String
      if case .string(let text) = fields["schema"] { found = "\"\(text)\"" } else { found = "no schema" }
      return .failed(
        RefactorError(
          code: .IMAGE_FAILED,
          instructions: "The image reported \(found); this jig supports only \"\(reportSchema)\". "
            + "Use an image built for report version 1, or a jig that reads the image's version."))
    }

    if case .bool(false) = fields["ok"] {
      if let extra = unknownKeys(fields, allowed: ["schema", "ok", "code", "instructions"]) { return broken(extra) }
      guard case .string(let instructions) = fields["instructions"], !instructions.isEmpty else {
        return broken("a failure needs non-empty instructions")
      }
      guard case .string(let raw) = fields["code"] else { return broken("a failure needs a code") }
      if let code = ErrorCode.reportable(raw) {
        return .failed(RefactorError(code: code, instructions: instructions))
      }
      return .failed(
        RefactorError(
          code: .IMAGE_FAILED,
          instructions: "The image failed with \(raw) (\(termination)): \(instructions)"))
    }

    switch termination {
    case .exited(0): break
    case .exited(let code): return broken("it reports success but exited with \(code)")
    case .signaled(let signal): return broken("it reports success but was killed by signal \(signal)")
    }
    if let extra = unknownKeys(fields, allowed: ["schema", "ok", "kind", "subject", "summary"]) { return broken(extra) }
    let report: Report
    do {
      report = try JSONDecoder().decode(Report.self, from: Data(line.utf8))
    } catch {
      return broken(describe(error))
    }
    if let problem = problems(report) { return broken(problem) }
    // The text the commit message and the output both show: trailing whitespace and blank lines at the
    // ends dropped.
    var tidied = report
    tidied.summary = tidy(report.summary)
    return .ok(tidied)
  }

  /// What v1 asks beyond the types: a one-line subject, a summary that is not only whitespace, and a
  /// subject that starts with `<kind>(`.
  private static func problems(_ report: Report) -> String? {
    let subject = report.subject
    if subject.isEmpty || subject.unicodeScalars.contains(where: { $0 == "\n" || $0 == "\r" }) {
      return "the subject is empty or has a line break: \(javaScriptJSONString(subject))"
    }
    if report.summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "the summary is empty" }
    if !subject.utf8.starts(with: "\(report.kind.rawValue)(".utf8) {
      return "the subject must start with \"\(report.kind.rawValue)(\" for kind \(report.kind.rawValue): "
        + javaScriptJSONString(subject)
    }
    return nil
  }
}

private func unknownKeys(_ fields: [String: JSONValue], allowed: Set<String>) -> String? {
  let extra = fields.keys.filter { !allowed.contains($0) }.sorted()
  return extra.isEmpty ? nil : "unknown field(s) \(extra.joined(separator: ", "))"
}

/// A decoding error as `<path>: <what>`.
private func describe(_ error: any Error) -> String {
  guard let error = error as? DecodingError else { return String(describing: error) }
  func path(_ context: DecodingError.Context) -> String {
    let keys = context.codingPath.map { $0.intValue.map { "[\($0)]" } ?? ".\($0.stringValue)" }.joined()
    return keys.isEmpty ? "the report" : String(keys.drop(while: { $0 == "." }))
  }
  switch error {
  case .keyNotFound(let key, let context):
    let at = context.codingPath.isEmpty ? "" : " in \(path(context))"
    return "\(key.stringValue) is missing\(at)"
  case .typeMismatch(_, let context), .valueNotFound(_, let context), .dataCorrupted(let context):
    return "\(path(context)): \(context.debugDescription)"
  @unknown default:
    return String(describing: error)
  }
}
