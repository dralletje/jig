import Foundation

/// The version of what `verify` prints (`schemas/verify-1.schema.json`).
public let verifySchema = "urn:jig:verify:1"

/// What a refactor commit records about itself: its `Refactor-Command` (image and args), `Refactor-Kind`
/// trailer and its subject. The kind is kept as written, so a value this binary would not print still
/// compares (as a mismatch).
public struct RecordedCommand: Equatable, Sendable {
  public var image: String
  public var args: [String]
  public var kind: String
  public var subject: String

  public init(image: String, args: [String], kind: String, subject: String) {
    self.image = image
    self.args = args
    self.kind = kind
    self.subject = subject
  }
}

/// What a replay says about one commit.
public enum Verdict: String, Codable, Sendable {
  /// The replay made the commit's tree, and the recorded kind and subject match.
  case identical
  /// The trees, the kind or the subject differ.
  case different
  /// The replay itself failed (the image, the capture checks).
  case failed
  /// Not a commit to verify: no `Refactor-Command`, or not exactly one parent (in a range).
  case skipped
  /// A `Refactor-Command` that cannot be read.
  case invalid
}

/// One recorded value the replay did not reproduce: `field` is `kind` or `subject`.
public struct Mismatch: Codable, Equatable, Sendable {
  public var field: String
  public var recorded: String
  public var replayed: String

  public init(field: String, recorded: String, replayed: String) {
    self.field = field
    self.recorded = recorded
    self.replayed = replayed
  }
}

/// The result for one commit.
public struct CommitVerification: Equatable, Sendable {
  public var commit: String
  public var verdict: Verdict
  public var command: RecordedCommand?
  /// Paths where the replayed tree and the commit's tree differ, sorted.
  public var filesDiffering: [String]
  public var mismatches: [Mismatch]
  public var code: ErrorCode?
  public var reason: String?
  public var instructions: String?

  public init(
    commit: String, verdict: Verdict, command: RecordedCommand? = nil, filesDiffering: [String] = [],
    mismatches: [Mismatch] = [], code: ErrorCode? = nil, reason: String? = nil, instructions: String? = nil
  ) {
    self.commit = commit
    self.verdict = verdict
    self.command = command
    self.filesDiffering = filesDiffering
    self.mismatches = mismatches
    self.code = code
    self.reason = reason
    self.instructions = instructions
  }
}

/// Compares what a commit recorded with what its replay reported. `treesEqual` is whether the replayed
/// tree is the commit's tree. Mismatches are listed in the order kind, subject. `identical` needs equal
/// trees and no mismatch; anything else is `different`.
public func verdict(recorded: RecordedCommand, replayed: Report, treesEqual: Bool) -> (Verdict, [Mismatch]) {
  var mismatches: [Mismatch] = []
  if recorded.kind != replayed.kind.rawValue {
    mismatches.append(Mismatch(field: "kind", recorded: recorded.kind, replayed: replayed.kind.rawValue))
  }
  if recorded.subject != replayed.subject {
    mismatches.append(Mismatch(field: "subject", recorded: recorded.subject, replayed: replayed.subject))
  }
  if treesEqual && mismatches.isEmpty {
    return (.identical, mismatches)
  }
  return (.different, mismatches)
}

/// Reads the `Refactor-Command` trailer (`{"args":[...],"image":"..."}`) with the commit's other recorded
/// values. Anything but an object with exactly a non-empty string `image` and a string array `args`
/// whose first item is an action (see `actionProblem`) throws `INVALID_ARGS`.
public func parseRecordedCommand(json: String, kind: String, subject: String) throws -> RecordedCommand {
  func invalid(_ why: String) -> RefactorError {
    RefactorError(
      code: .INVALID_ARGS,
      instructions: "The commit's Refactor-Command trailer cannot be read: \(why). It must be "
        + #"{"args":[<strings>],"image":"<name>@sha256:<id>"}, as jig writes it. "#
        + "Verify only commits jig made, with their trailers unchanged.")
  }
  guard let value = try? JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)) else {
    throw invalid("it is not JSON")
  }
  guard case .object(let fields) = value else { throw invalid("it is not a JSON object") }
  if let extra = fields.keys.sorted().first(where: { $0 != "image" && $0 != "args" }) {
    throw invalid("it has an unknown field \"\(extra)\"")
  }
  guard case .string(let image) = fields["image"], !image.isEmpty else {
    throw invalid("its image is missing or not a non-empty string")
  }
  guard case .array(let items) = fields["args"] else { throw invalid("its args are missing or not an array") }
  let args = items.compactMap { item -> String? in if case .string(let s) = item { s } else { nil } }
  guard args.count == items.count else { throw invalid("its args are not all strings") }
  guard let action = args.first else { throw invalid("its args are empty: the first one is the action") }
  if let problem = actionProblem(action) { throw invalid("its first arg is not an action: \(problem)") }
  return RecordedCommand(image: image, args: args, kind: kind, subject: subject)
}

private struct VerifyOutput: Encodable {
  var schema = verifySchema
  var ok: Bool
  var commits: [CommitOutput]
}

private struct CommandOutput: Encodable {
  var image: String
  var args: [String]
}

/// One commit as printed. A nil field is left out (synthesized `encodeIfPresent`); `filesDiffering` and
/// `mismatches` are printed, possibly empty, whenever a replay was compared.
private struct CommitOutput: Encodable {
  var commit: String
  var verdict: Verdict
  var command: CommandOutput?
  var filesDiffering: [String]?
  var mismatches: [Mismatch]?
  var code: ErrorCode?
  var reason: String?
  var instructions: String?

  init(_ result: CommitVerification) {
    commit = result.commit
    verdict = result.verdict
    command = result.command.map { CommandOutput(image: $0.image, args: $0.args) }
    if result.verdict == .identical || result.verdict == .different {
      filesDiffering = result.filesDiffering
      mismatches = result.mismatches
    }
    code = result.code
    reason = result.reason
    instructions = result.instructions
  }
}

/// The verify v1 object, on one line, and whether it is `ok`: at least one commit was verified (not
/// skipped), and every verified one is `identical`.
public func verifyJSON(_ results: [CommitVerification]) -> (json: String, ok: Bool) {
  let verified = results.filter { $0.verdict != .skipped }
  let ok = !verified.isEmpty && verified.allSatisfy { $0.verdict == .identical }
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
  // Plain strings, arrays and enums: encoding cannot fail.
  guard let data = try? encoder.encode(VerifyOutput(ok: ok, commits: results.map(CommitOutput.init))) else {
    return (errorJSON(RefactorError(code: .INTERNAL, instructions: "could not encode the verify output")), false)
  }
  return (String(decoding: data, as: UTF8.self), ok)
}
