// convert-function through the real binary and the typescript image.
import Foundation
import Testing

@Suite("convert-function (docker)", .serialized, .enabled(if: dockerAvailable, dockerMissing), .builtOnce)
struct ConvertFunctionTests {
  let temp = TempDirs()

  @Test("--to arrow then --to function restores the original text", .timeLimit(.minutes(3)))
  func roundTrip() throws {
    let dir = try temp.fixture("examples/convert-function")
    let original = try #require(try readTree(dir)["src/math.ts"])

    let toArrow = ["convert-function", "--at", "src/math.ts:1", "--to", "arrow"]
    let first = try runImage(repo: dir, image: TS, args: toArrow)
    #expect(first.kind == "refactor")
    #expect(first.filesChanged == ["src/math.ts"])
    #expect(first.subject == "refactor(convert-function): src/math.ts:1 → arrow function")
    #expect(first.summary == "Converted the function declaration `add` in src/math.ts to a `const` arrow function.")
    let arrowed = try #require(try readTree(dir)["src/math.ts"])
    #expect(arrowed.hasPrefix("export const add = (a: number, b: number): number => {\n  return a + b;\n};\n"))
    let body = try git(dir, ["log", "-1", "--format=%B"])
    #expect(body.contains("\nRefactor-Kind: refactor\nCo-Authored-By: "))
    #expect(try git(dir, ["log", "-1", "--format=%s"]) == first.subject + "\n")

    let toFunction = ["convert-function", "--at", "src/math.ts:1", "--to", "function"]
    let second = try runImage(repo: dir, image: TS, args: toFunction)
    #expect(second.subject == "refactor(convert-function): src/math.ts:1 → function declaration")
    #expect(second.kind == "refactor")
    #expect(second.summary == "Converted `add` in src/math.ts from an arrow function to a function declaration.")
    #expect(try readTree(dir)["src/math.ts"] == original)
    #expect(try status(dir) == "")
  }

  @Test("a refusal is REFACTOR_UNAVAILABLE and leaves no commit", .timeLimit(.minutes(2)))
  func refusal() throws {
    let dir = try temp.fixture("examples/convert-function")
    try commitFile(dir, "src/g.ts", "export function* g() {\n  yield 1;\n}\n")
    let parent = try headCommit(dir)
    let failure = try failImage(
      repo: dir, image: TS, args: ["convert-function", "--at", "src/g.ts:1", "--to", "arrow"])
    #expect(failure.code == "REFACTOR_UNAVAILABLE")
    #expect(try headCommit(dir) == parent)
    #expect(try status(dir) == "")
  }
}
