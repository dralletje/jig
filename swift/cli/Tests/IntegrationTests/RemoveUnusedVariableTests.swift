// remove-unused-variable end to end, on examples/remove-unused-variable.
import Foundation
import Testing

@Suite("remove-unused-variable (docker)", .serialized, .enabled(if: dockerAvailable, dockerMissing), .builtOnce)
struct RemoveUnusedVariableTests {
  let temp = TempDirs()

  @Test("removing an unused local is committed as a complete refactor", .timeLimit(.minutes(2)))
  func removesUnusedLocal() throws {
    let dir = try temp.fixture("examples/remove-unused-variable")
    let args = ["remove-unused-variable", "--at", "src/report.ts:5"]
    let result = try runImage(repo: dir, image: TS, args: args)
    #expect(result.kind == "refactor")
    #expect(result.subject == "refactor(typescript remove-unused-variable): src/report.ts:5")
    #expect(result.filesChanged == ["src/report.ts"])
    #expect(result.summary == "Removed the unused const `unusedLimit` from `src/report.ts#summarize`.")
    #expect(try git(dir, ["log", "-1", "--format=%s"]) == "refactor(typescript remove-unused-variable): src/report.ts:5\n")
    let body = try git(dir, ["log", "-1", "--format=%B"])
    #expect(body.contains("\nRefactor-Kind: refactor\nCo-Authored-By: "))
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
    #expect(failure.instructions.contains("`label` is still referenced"))
    #expect(try headCommit(dir) == parent)
    #expect(try status(dir) == "")
  }
}
