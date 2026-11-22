import Foundation
import Testing

@testable import Report

private func report(_ fields: String, action: String) -> ImageReport {
  ImageReport.parse(
    stdout: #"{"schema":"urn:jig:report:1","ok":true,"summary":"Did it.",\#(fields)}"#, stderr: "",
    exitCode: 0, action: action)
}

private func problem(_ fields: String, action: String) -> String? {
  guard case .failed(let error) = report(fields, action: action) else { return nil }
  #expect(error.code == .IMAGE_FAILED)
  return error.instructions
}

// MARK: - Report checks

@Test(arguments: [
  ("refactor", "rename", "refactor(typescript rename): a → b", true),
  ("sweep", "format", "sweep(prettier format): src/**", true),
  ("rewrite", "remove-console", "rewrite(typescript remove-console): a.ts", true),
  ("sweep", "sort-comp", "sweep(codemod-react sort-comp): src/**", true),
  ("rewrite", "move", "rewrite(fs move): a → b", true),
  ("sweep", "React-DOM-to-react-dom-factories", "sweep(codemod-react React-DOM-to-react-dom-factories): x", true),
  // The description may hold anything, parentheses and the action's name included.
  ("refactor", "rename", "refactor(typescript rename): rename (again)", true),
  // A combining mark on the "(" is a different string, byte for byte: part of the name here.
  ("refactor", "rename", "refactor(\u{301}ts rename): y", true),
  // The old form, without the image's name.
  ("refactor", "rename", "refactor(rename): a → b", false),
  ("sweep", "format", "sweep(format): src/**", false),
  // No name.
  ("refactor", "rename", "refactor( rename): a", false),
  // Another action than the one jig passed.
  ("refactor", "rename", "refactor(typescript extract): a", false),
  ("refactor", "rename", "refactor(typescript rename-files): a", false),
  ("refactor", "rename", "refactor(typescript renam): a", false),
  // A name with a space, a parenthesis or other whitespace.
  ("refactor", "rename", "refactor(type script rename): a", false),
  ("refactor", "rename", "refactor(type(script rename): a", false),
  ("refactor", "rename", "refactor(type)script rename): a", false),
  ("refactor", "rename", "refactor(type\tscript rename): a", false),
  ("refactor", "rename", "refactor(type\u{A0}script rename): a", false),
  // Two spaces, no ": " after the action, nothing after the kind.
  ("refactor", "rename", "refactor(typescript  rename): a", false),
  ("refactor", "rename", "refactor(typescript rename):a", false),
  ("refactor", "rename", "refactor(typescript rename)", false),
  ("refactor", "rename", "refactor(", false),
  // Another kind than the report's, or no kind at all.
  ("refactor", "rename", "sweep(typescript rename): a", false),
  ("refactor", "rename", "Refactor(typescript rename): a", false),
  ("sweep", "format", "sweep (prettier format): a", false),
  ("refactor", "rename", "probe: x", false),
])
func subjectMustNameKindImageAndAction(kind: String, action: String, subject: String, valid: Bool) {
  let fields = #""kind":"\#(kind)","subject":\#(javaScriptJSONString(subject))"#
  let found = problem(fields, action: action)
  if valid {
    #expect(found == nil, "\(found ?? "")")
  } else {
    #expect(
      found?.contains(
        "the subject must start with \"\(kind)(<image> \(action)): \" for kind \(kind) and action \(action), "
          + "where <image> is the image's own name (not empty, without spaces, \"(\" or \")\"): ") == true,
      "\(found ?? "")")
  }
}

@Test func imageFailuresNameTheSignal() {
  guard case .failed(let error) = ImageReport.parse(stdout: "", stderr: "", termination: .signaled(9), action: "x") else {
    Issue.record("expected a failure")
    return
  }
  #expect(error.instructions.hasPrefix("The image printed no report (killed by signal 9); nothing was changed"))
  let ok = #"{"schema":"urn:jig:report:1","ok":true,"kind":"refactor","subject":"refactor(img x): y","summary":"s"}"#
  guard case .failed(let late) = ImageReport.parse(stdout: ok, stderr: "", termination: .signaled(15), action: "x") else {
    Issue.record("expected a failure")
    return
  }
  #expect(late.instructions.contains("it reports success but was killed by signal 15"))
}
