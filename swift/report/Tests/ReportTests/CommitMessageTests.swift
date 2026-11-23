import Testing

@testable import Report

@Test func canonicalCommandMatchesJavaScript() {
  let json = canonicalCommand(
    image: "img@sha256:1",
    args: ["check", "a b", "é", "\"q\"", "back\\slash", "tab\there", "nl\nx", "\u{1}", "/x"]
  )
  #expect(
    json
      == #"{"args":["check","a b","é","\"q\"","back\\slash","tab\there","nl\nx","\u0001","/x"],"image":"img@sha256:1"}"#
  )
}

@Test func canonicalCommandEscapesOtherControlCharacters() {
  #expect(
    canonicalCommand(image: "i", args: ["\u{8}\u{c}\r\u{1f}\u{7f}"])
      == "{\"args\":[\"\\b\\f\\r\\u001f\u{7f}\"],\"image\":\"i\"}"
  )
  #expect(canonicalCommand(image: "i", args: []) == #"{"args":[],"image":"i"}"#)
}

@Test func canonicalJSONSortsKeysByUTF16AndWritesIntegers() {
  // The expected text is what JavaScript's `JSON.stringify` writes for this value with keys sorted.
  let value = JSONValue.object([
    "\u{1F600}": .number(1), "\u{FF5E}": .number(2), "Z": .number(3), "a": .number(4),
  ])
  #expect(canonicalJSON(value) == "{\"Z\":3,\"a\":4,\"\u{1F600}\":1,\"\u{FF5E}\":2}")
  #expect(
    canonicalJSON(.object(["b": .number(1), "a": .object(["d": .array([.number(1), .string("x")]), "c": .null])]))
      == #"{"a":{"c":null,"d":[1,"x"]},"b":1}"#)
  #expect(canonicalJSON(.array([.bool(true), .bool(false), .number(-2), .number(9_007_199_254_740_991)])) == "[true,false,-2,9007199254740991]")
}

@Test func commitMessageIsSubjectSummaryAndTrailers() {
  let report = Report(kind: .sweep, subject: "sweep(prettier format): x", summary: "Formatted.")
  let coAuthor = "jig <jig@dral.dev>"
  let text = commitMessage(report: report, message: nil, image: "i@sha256:…", args: [], coAuthor: coAuthor)
  #expect(
    text
      == "sweep(prettier format): x\n\nFormatted.\n\nRefactor-Command: {\"args\":[],\"image\":\"i@sha256:…\"}\nRefactor-Kind: sweep\n"
      + "Co-Authored-By: \(coAuthor)\n")
}

@Test func commitMessageWithMessageAndMultiLineSummary() {
  let report = Report(kind: .sweep, subject: "sweep(prettier format): *.ts", summary: "Formatted 2 files:\n  a.ts  \n  b.ts")
  let text = commitMessage(report: report, message: "  why\nbecause  \n", image: "img@sha256:1", args: [], coAuthor: "bot <b@x>")
  #expect(
    text == """
      sweep(prettier format): *.ts

      Formatted 2 files:
        a.ts
        b.ts

      why
      because

      Refactor-Command: {"args":[],"image":"img@sha256:1"}
      Refactor-Kind: sweep
      Co-Authored-By: bot <b@x>

      """
  )
}

@Test(arguments: ["", "   ", " \n\t "])
func commitMessageOmitsBlankMessage(message: String) {
  let report = Report(kind: .rewrite, subject: "S", summary: "x")
  let text = commitMessage(report: report, message: message, image: "i", args: [], coAuthor: "c")
  #expect(text == "S\n\nx\n\nRefactor-Command: {\"args\":[],\"image\":\"i\"}\nRefactor-Kind: rewrite\nCo-Authored-By: c\n")
}
