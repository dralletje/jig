// remove-unused-variable end to end, on examples/remove-unused-variable.
import Foundation
import Testing

@Suite("remove-unused-variable (docker)", .serialized, .enabled(if: dockerAvailable, dockerMissing), .builtOnce)
struct RemoveUnusedVariableTests {
  let temp = TempDirs()

  @Test("an unused local is removed", .timeLimit(.minutes(2)))
  func removesUnusedLocal() throws {
    let dir = try temp.fixture("examples/remove-unused-variable")
    let args = ["remove-unused-variable", "--at", "src/report.ts:5"]
    let result = try runImage(repo: dir, image: TS, args: args)
    #expect(result.filesChanged == ["src/report.ts"])
    let tree = try readTree(dir)
    #expect(tree["src/report.ts"]?.contains("unusedLimit") == false)
    #expect(tree["src/report.ts"]?.contains("const label = \"total\";\n\n  const sum") == true)
    #expect(try status(dir) == "")
  }

  @Test("a referenced variable is REFACTOR_UNAVAILABLE and nothing is committed", .timeLimit(.minutes(2)))
  func refusesReferenced() throws {
    let dir = try temp.fixture("examples/remove-unused-variable")
    let parent = try headCommit(dir)
    let failure = try failImage(
      repo: dir, image: TS, args: ["remove-unused-variable", "--at", "src/report.ts:4"])
    #expect(failure.code == "REFACTOR_UNAVAILABLE")
    #expect(try headCommit(dir) == parent)
    #expect(try status(dir) == "")
  }
}
