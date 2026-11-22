// template-string through the real typescript image, on examples/template-string.
import Foundation
import Testing

@Suite("template-string (docker)", .serialized, .enabled(if: dockerAvailable, dockerMissing), .builtOnce)
struct TemplateStringTests {
  let temp = TempDirs()

  @Test("a concatenation becomes a template literal and is committed as a refactor", .timeLimit(.minutes(2)))
  func convert() throws {
    let dir = try temp.fixture("examples/template-string")
    let result = try runImage(repo: dir, image: TS, args: ["template-string", "--at", "src/greet.ts:2"])
    #expect(result.filesChanged == ["src/greet.ts"])
    #expect(result.kind == "refactor")
    #expect(result.subject == "refactor(template-string): src/greet.ts:2")
    #expect(try git(dir, ["log", "-1", "--format=%s"]) == "refactor(template-string): src/greet.ts:2\n")
    #expect(result.summary.hasPrefix("Converted a string concatenation in "), "\(result.summary)")
    let body = try git(dir, ["log", "-1", "--format=%B"])
    #expect(body.contains("\nRefactor-Kind: refactor\nCo-Authored-By: "))
    #expect(try readTree(dir)["src/greet.ts"]?.contains("return `Hi ${name}!`;") == true)
    #expect(try status(dir) == "")
  }

  @Test("two concatenations on a line need a column", .timeLimit(.minutes(2)))
  func needsColumn() throws {
    let dir = try temp.fixture("examples/template-string")
    let failure = try failImage(repo: dir, image: TS, args: ["template-string", "--at", "src/greet.ts:10"])
    #expect(failure.code == "INVALID_ARGS")
    #expect(failure.instructions.contains("Pass a column"))
    let result = try runImage(repo: dir, image: TS, args: ["template-string", "--at", "src/greet.ts:10:20"])
    #expect(result.kind == "refactor")
    #expect(try readTree(dir)["src/greet.ts"]?.contains("[\"x\" + a, `y${b}`]") == true)
  }
}
