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
    #expect(first.filesChanged == ["src/math.ts"])
    let arrowed = try #require(try readTree(dir)["src/math.ts"])
    #expect(arrowed.hasPrefix("export const add = (a: number, b: number): number => {\n  return a + b;\n};\n"))

    let toFunction = ["convert-function", "--at", "src/math.ts:1", "--to", "function"]
    _ = try runImage(repo: dir, image: TS, args: toFunction)
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
