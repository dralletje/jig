import Foundation
import Testing

@testable import Report

private let image = "localhost/jig/probe:local@sha256:" + String(repeating: "3", count: 64)

private func replayed(kind: ActionKind = .refactor, subject: String = "refactor(x): y") -> Report {
  Report(kind: kind, subject: subject, summary: "s")
}

/// What a commit made from `replayed()` records.
private func recorded(from report: Report = replayed()) -> RecordedCommand {
  RecordedCommand(image: image, args: ["rename", "--to", "b"], kind: report.kind.rawValue, subject: report.subject)
}

private func object(_ text: String) throws -> [String: JSONValue] {
  guard case .object(let fields) = try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) else {
    Issue.record("not an object: \(text)")
    return [:]
  }
  return fields
}

private func result(_ verdict: Verdict) -> CommitVerification {
  CommitVerification(
    commit: "1111111111111111111111111111111111111111", verdict: verdict, command: nil, filesDiffering: [],
    mismatches: [], code: nil, reason: nil, instructions: nil)
}

@Test func identicalWhenTreesKindAndSubjectAreEqual() {
  let (got, mismatches) = verdict(recorded: recorded(), replayed: replayed(), treesEqual: true)
  #expect(got == .identical)
  #expect(mismatches == [])
}

@Test func differentWhenTreesDiffer() {
  let (got, mismatches) = verdict(recorded: recorded(), replayed: replayed(), treesEqual: false)
  #expect(got == .different)
  #expect(mismatches == [])
}

@Test(arguments: [true, false])
func differentWhenOnlyTheSubjectDiffers(treesEqual: Bool) {
  let other = replayed(subject: "refactor(x): z")
  let (got, mismatches) = verdict(recorded: recorded(), replayed: other, treesEqual: treesEqual)
  #expect(got == .different)
  #expect(mismatches == [Mismatch(field: "subject", recorded: "refactor(x): y", replayed: "refactor(x): z")])
}

@Test func differentWhenTheKindDiffersWithTheKindFirst() {
  let other = replayed(kind: .sweep, subject: "sweep(x): y")
  let (got, mismatches) = verdict(recorded: recorded(), replayed: other, treesEqual: true)
  #expect(got == .different)
  #expect(
    mismatches == [
      Mismatch(field: "kind", recorded: "refactor", replayed: "sweep"),
      Mismatch(field: "subject", recorded: "refactor(x): y", replayed: "sweep(x): y"),
    ])
}

@Test func okOnlyWhenEveryVerifiedCommitIsIdentical() {
  #expect(verifyJSON([result(.skipped), result(.skipped)]).ok == false)
  #expect(verifyJSON([]).ok == false)
  #expect(verifyJSON([result(.skipped), result(.identical)]).ok == true)
  #expect(verifyJSON([result(.identical), result(.identical)]).ok == true)
  #expect(verifyJSON([result(.identical), result(.different)]).ok == false)
  #expect(verifyJSON([result(.identical), result(.failed)]).ok == false)
  #expect(verifyJSON([result(.identical), result(.invalid)]).ok == false)
}

@Test func jsonShape() throws {
  let command = recorded()
  let verified = CommitVerification(
    commit: "1111111111111111111111111111111111111111", verdict: .different, command: command,
    filesDiffering: ["a.ts", "b/c.ts"],
    mismatches: [Mismatch(field: "subject", recorded: command.subject, replayed: "refactor(x): z")],
    code: nil, reason: nil, instructions: nil)
  let skipped = CommitVerification(
    commit: "2222222222222222222222222222222222222222", verdict: .skipped, command: nil, filesDiffering: [],
    mismatches: [], code: nil, reason: "no Refactor-Command", instructions: nil)
  let failed = CommitVerification(
    commit: "3333333333333333333333333333333333333333", verdict: .failed, command: command, filesDiffering: [],
    mismatches: [], code: .IMAGE_FAILED, reason: nil, instructions: "The image crashed.")

  let (text, ok) = verifyJSON([verified, skipped, failed])
  #expect(ok == false)
  #expect(!text.contains("\n"))
  for key in ["\"on\"", "recordedEffect", "replayedEffect"] {
    #expect(!text.contains(key), "\(key) in \(text)")
  }
  let top = try object(text)
  #expect(Set(top.keys) == ["schema", "ok", "commits"])
  #expect(top["schema"] == .string("urn:jig:verify:1"))
  #expect(top["ok"] == .bool(false))
  guard case .array(let commits) = top["commits"], commits.count == 3,
    case .object(let first) = commits[0], case .object(let second) = commits[1], case .object(let third) = commits[2]
  else {
    Issue.record("unexpected commits in \(text)")
    return
  }
  #expect(
    first == [
      "commit": .string(verified.commit), "verdict": .string("different"),
      "command": .object(["image": .string(image), "args": .array(["rename", "--to", "b"].map { .string($0) })]),
      "filesDiffering": .array([.string("a.ts"), .string("b/c.ts")]),
      "mismatches": .array([
        .object([
          "field": .string("subject"), "recorded": .string("refactor(x): y"), "replayed": .string("refactor(x): z"),
        ])
      ]),
    ])
  #expect(
    second == [
      "commit": .string(skipped.commit), "verdict": .string("skipped"), "reason": .string("no Refactor-Command"),
    ])
  #expect(
    third == [
      "commit": .string(failed.commit), "verdict": .string("failed"),
      "command": .object(["image": .string(image), "args": .array(["rename", "--to", "b"].map { .string($0) })]),
      "code": .string("IMAGE_FAILED"), "instructions": .string("The image crashed."),
    ])
}

@Test func identicalJSONListsEmptyArrays() throws {
  var identical = result(.identical)
  identical.command = recorded()
  let top = try object(verifyJSON([identical]).json)
  guard case .array(let commits) = top["commits"], case .object(let fields) = commits.first else {
    Issue.record("no commits")
    return
  }
  #expect(fields["filesDiffering"] == .array([]))
  #expect(fields["mismatches"] == .array([]))
}

/// The results in `schemas/examples/verify-1-range.json`, built as the CLI would build them.
private func exampleRange() -> [CommitVerification] {
  let ts = "localhost/jig/typescript:local@sha256:" + String(repeating: "3", count: 64)
  let prettier = "localhost/jig/prettier:local@sha256:" + String(repeating: "5", count: 64)
  let rename = RecordedCommand(
    image: ts, args: ["rename", "--file", "src/orders.ts", "--symbol", "sendEmail", "--to", "sendMail"],
    kind: "refactor", subject: "refactor(typescript rename): sendEmail → sendMail in src/orders.ts")
  let format = RecordedCommand(image: prettier, args: ["prettier"], kind: "sweep", subject: "sweep(prettier format): src/**")
  let reworded = RecordedCommand(
    image: prettier, args: ["prettier"], kind: "sweep", subject: "sweep(prettier format): tidy the sources")
  let gone = RecordedCommand(
    image: ts, args: ["rename", "--file", "src/gone.ts", "--symbol", "x", "--to", "y"], kind: "refactor",
    subject: "refactor(typescript rename): x → y in src/gone.ts")
  var invalid: RefactorError?
  do { _ = try parseRecordedCommand(json: "{", kind: "", subject: "") } catch let e as RefactorError {
    invalid = e
  } catch {}
  return [
    CommitVerification(commit: String(repeating: "1", count: 40), verdict: .identical, command: rename),
    CommitVerification(commit: String(repeating: "2", count: 40), verdict: .skipped, reason: "no Refactor-Command"),
    CommitVerification(
      commit: String(repeating: "4", count: 40), verdict: .different, command: format, filesDiffering: ["src/jobs.ts"]),
    CommitVerification(
      commit: String(repeating: "7", count: 40), verdict: .different, command: reworded,
      mismatches: [Mismatch(field: "subject", recorded: reworded.subject, replayed: "sweep(prettier format): src/**")]),
    CommitVerification(
      commit: String(repeating: "9", count: 40), verdict: .failed, command: gone, code: .SYMBOL_NOT_FOUND,
      instructions: "No top-level x in src/gone.ts."),
    CommitVerification(
      commit: String(repeating: "b", count: 40), verdict: .invalid, code: invalid?.code,
      reason: "unreadable Refactor-Command", instructions: invalid?.instructions),
  ]
}

@Test func theExampleRangeIsWhatVerifyJSONPrints() throws {
  let (text, ok) = verifyJSON(exampleRange())
  #expect(ok == false)
  #expect(try object(text) == object(try example("verify-1-range.json")))
}

@Test func parsesTheRecordedCommand() throws {
  let json = canonicalCommand(image: image, args: ["rename", "--to", "b"])
  let command = try parseRecordedCommand(json: json, kind: "refactor", subject: "refactor(x): y")
  #expect(
    command == RecordedCommand(image: image, args: ["rename", "--to", "b"], kind: "refactor", subject: "refactor(x): y"))
}

@Test(arguments: [
  (#"{"args":[],"image":"i@sha256:00"}"#, "its args are empty: the first one is the action"),
  (#"{"args":["","--to","b"],"image":"i@sha256:00"}"#, "its first arg is not an action: the action is empty"),
  (#"{"args":["a b"],"image":"i@sha256:00"}"#, #"its first arg is not an action: the action "a b" has whitespace"#),
])
func aRecordedCommandWithoutAnActionIsUnreadable(json: String, says: String) {
  do {
    _ = try parseRecordedCommand(json: json, kind: "refactor", subject: "s")
    Issue.record("expected a refusal of \(json)")
  } catch let error as RefactorError {
    #expect(error.code == .INVALID_ARGS)
    #expect(error.instructions.contains("The commit's Refactor-Command trailer cannot be read: \(says)."), "\(error.instructions)")
  } catch {
    Issue.record("unexpected \(error)")
  }
}

@Test func badCommandJSONThrows() {
  for json in [
    "", "not json", "[]", #"{"args":["a"]}"#, #"{"image":"i"}"#, #"{"image":"","args":[]}"#,
    #"{"image":"i","args":"a"}"#, #"{"image":"i","args":[1]}"#, #"{"image":"i","args":[],"extra":1}"#,
  ] {
    #expect(throws: RefactorError.self, "\(json)") {
      try parseRecordedCommand(json: json, kind: "refactor", subject: "s")
    }
  }
  do {
    _ = try parseRecordedCommand(json: "{", kind: "refactor", subject: "s")
  } catch let error as RefactorError {
    #expect(error.code == .INVALID_ARGS)
    #expect(error.instructions.contains("Refactor-Command"))
  } catch {
    Issue.record("unexpected \(error)")
  }
}
