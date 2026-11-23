import Foundation
import Testing

@testable import RefactorCLI
import Report

private func repo(withConfig text: String?) throws -> URL {
  let dir = FileManager.default.temporaryDirectory
    .appendingPathComponent("jig-config-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  if let text {
    try Data(text.utf8).write(to: dir.appendingPathComponent(".jig.json"))
  }
  return dir
}

private func invalidArgs(_ text: String) throws -> RefactorError {
  let dir = try repo(withConfig: text)
  defer { try? FileManager.default.removeItem(at: dir) }
  do {
    _ = try loadConfig(repo: dir)
  } catch let error as RefactorError {
    #expect(error.code == .INVALID_ARGS)
    #expect(error.instructions.hasPrefix(".jig.json: "))
    return error
  }
  Issue.record("expected INVALID_ARGS for \(text)")
  return RefactorError(code: .INTERNAL, instructions: "")
}

@Test func configDefaultsWithoutFile() throws {
  let dir = try repo(withConfig: nil)
  defer { try? FileManager.default.removeItem(at: dir) }
  #expect(try loadConfig(repo: dir).coAuthor == "jig <jig@dral.dev>")
}

@Test func configReadsCoAuthor() throws {
  let dir = try repo(withConfig: #"{"coAuthor":"bot <b@x>"}"#)
  defer { try? FileManager.default.removeItem(at: dir) }
  #expect(try loadConfig(repo: dir).coAuthor == "bot <b@x>")
}

@Test func configEmptyObjectIsDefault() throws {
  let dir = try repo(withConfig: "{}")
  defer { try? FileManager.default.removeItem(at: dir) }
  #expect(try loadConfig(repo: dir).coAuthor == "jig <jig@dral.dev>")
}

@Test func configRejectsUnknownKey() throws {
  let error = try invalidArgs(#"{"actions":{}}"#)
  #expect(error.instructions.contains("\"actions\""))
}

@Test func configRejectsNonStringCoAuthor() throws {
  let error = try invalidArgs(#"{"coAuthor":1}"#)
  #expect(error.instructions.contains("coAuthor must be a string"))
}

@Test func configRejectsInvalidJSON() throws {
  let error = try invalidArgs("{ nope")
  #expect(error.instructions.contains("invalid JSON"))
}

@Test(arguments: ["[]", "1", "\"x\"", "null"])
func configRejectsNonObject(text: String) throws {
  _ = try invalidArgs(text)
}
