import Foundation
import Testing

@testable import Report

private func report(_ fields: String) -> ImageReport {
  ImageReport.parse(
    stdout: #"{"schema":"urn:jig:report:1","ok":true,"summary":"Did it.",\#(fields)}"#, stderr: "",
    exitCode: 0)
}

private func problem(_ fields: String) -> String? {
  guard case .failed(let error) = report(fields) else { return nil }
  #expect(error.code == .IMAGE_FAILED)
  return error.instructions
}

// MARK: - Report checks

@Test(arguments: [
  ("refactor", "refactor(x): y", true),
  ("sweep", "sweep(format): src/**", true),
  ("rewrite", "rewrite(remove-console): a.ts", true),
  ("refactor", "probe: x", false),
  ("refactor", "sweep(x): y", false),
  ("refactor", "refactor: y", false),
  ("refactor", "Refactor(x): y", false),
  ("sweep", "sweep (x): y", false),
  // A combining mark on the "(" is a different string, byte for byte.
  ("refactor", "refactor(\u{301}x): y", true),
])
func subjectMustStartWithKind(kind: String, subject: String, valid: Bool) {
  let fields = #""kind":"\#(kind)","subject":\#(javaScriptJSONString(subject))"#
  let found = problem(fields)
  if valid {
    #expect(found == nil, "\(found ?? "")")
  } else {
    #expect(found?.contains("the subject must start with \"\(kind)(\" for kind \(kind)") == true, "\(found ?? "")")
  }
}

@Test func imageFailuresNameTheSignal() {
  guard case .failed(let error) = ImageReport.parse(stdout: "", stderr: "", termination: .signaled(9)) else {
    Issue.record("expected a failure")
    return
  }
  #expect(error.instructions.hasPrefix("The image printed no report (killed by signal 9); nothing was changed"))
  let ok = #"{"schema":"urn:jig:report:1","ok":true,"kind":"refactor","subject":"refactor(x): y","summary":"s"}"#
  guard case .failed(let late) = ImageReport.parse(stdout: ok, stderr: "", termination: .signaled(15)) else {
    Issue.record("expected a failure")
    return
  }
  #expect(late.instructions.contains("it reports success but was killed by signal 15"))
}
