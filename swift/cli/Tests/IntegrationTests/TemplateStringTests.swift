// template-string through the real typescript image, on examples/template-string.
import Foundation
import Testing

@Suite("template-string (docker)", .serialized, .enabled(if: dockerAvailable, dockerMissing), .builtOnce)
struct TemplateStringTests {
  let temp = TempDirs()

  @Test("a concatenation becomes a template literal", .timeLimit(.minutes(2)))
  func convert() throws {
    let dir = try temp.fixture("examples/template-string")
    let result = try runImage(repo: dir, image: TS, args: ["template-string", "--at", "src/greet.ts:2"])
    #expect(result.filesChanged == ["src/greet.ts"])
    #expect(try readTree(dir)["src/greet.ts"]?.contains("return `Hi ${name}!`;") == true)
    #expect(try status(dir) == "")
  }

  @Test("two concatenations on a line need a column", .timeLimit(.minutes(2)))
  func needsColumn() throws {
    let dir = try temp.fixture("examples/template-string")
    let failure = try failImage(repo: dir, image: TS, args: ["template-string", "--at", "src/greet.ts:10"])
    #expect(failure.code == "INVALID_ARGS")
    _ = try runImage(repo: dir, image: TS, args: ["template-string", "--at", "src/greet.ts:10:20"])
    #expect(try readTree(dir)["src/greet.ts"]?.contains("[\"x\" + a, `y${b}`]") == true)
  }
}
