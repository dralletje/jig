// inline-function end to end through the typescript image: one call, definition mode, and
// an unsafe definition-mode run that must change nothing.
import Foundation
import Testing

@Suite("inline-function (docker)", .serialized, .enabled(if: dockerAvailable, dockerMissing), .builtOnce)
struct InlineFunctionTests {
  let temp = TempDirs()

  @Test("one call: that call is unpacked, the declaration stays", .timeLimit(.minutes(2)))
  func oneCall() throws {
    let dir = try temp.fixture("examples/inline-function")
    let args = ["inline-function", "--file", "src/single.ts", "--symbol", "square", "--at", "src/single.ts:11"]
    let result = try runImage(repo: dir, image: TS, args: args)
    #expect(result.kind == "refactor")
    #expect(result.filesChanged == ["src/single.ts"])
    #expect(result.subject == "refactor(typescript inline-function): unpack square at src/single.ts:11")
    #expect(try git(dir, ["log", "-1", "--format=%s"]) == "\(result.subject)\n")
    #expect(result.summary == "Unpacked a call to `square` in src/single.ts#describe. `square` stays declared.")
    let body = try git(dir, ["log", "-1", "--format=%B"])
    #expect(body.contains("\nRefactor-Kind: refactor\nCo-Authored-By: "))
    let tree = try readTree(dir)
    #expect(tree["src/single.ts"]?.contains("const square = (n: number) => n * n;") == true)
    #expect(tree["src/single.ts"]?.contains("const s = side * side;") == true)
    #expect(tree["src/single.ts"]?.contains("s + square(w)") == true)
    #expect(try status(dir) == "")
  }

  @Test("definition mode: every call is unpacked and the declaration is removed", .timeLimit(.minutes(2)))
  func definition() throws {
    let dir = try temp.fixture("examples/inline-function")
    let args = ["inline-function", "--file", "src/multi.ts", "--symbol", "summarize"]
    let result = try runImage(repo: dir, image: TS, args: args)
    #expect(result.kind == "refactor")
    #expect(result.filesChanged == ["src/multi.ts"])
    #expect(
      try git(dir, ["log", "-1", "--format=%s"])
        == "refactor(typescript inline-function): unpack summarize everywhere in src/multi.ts and remove it\n")
    #expect(result.summary.hasPrefix("Unpacked 2 calls to `summarize` and removed its declaration:\n"))
    let body = try git(dir, ["log", "-1", "--format=%B"])
    #expect(body.contains("\nRefactor-Kind: refactor\nCo-Authored-By: "))
    #expect(!result.summary.contains("Not handled"))
    let tree = try readTree(dir)
    #expect(tree["src/multi.ts"]?.contains("function summarize") == false)
    #expect(tree["src/multi.ts"]?.contains("const first = `${label}: ${average}`;") == true)
    #expect(try status(dir) == "")
  }

  @Test("an unsafe call makes definition mode REFACTOR_UNAVAILABLE and commits nothing", .timeLimit(.minutes(2)))
  func unsafe() throws {
    let dir = try temp.fixture("examples/inline-function")
    let before = try headCommit(dir)
    let args = ["inline-function", "--file", "src/hoist.ts", "--symbol", "bump"]
    let failure = try failImage(repo: dir, image: TS, args: args)
    #expect(failure.code == "REFACTOR_UNAVAILABLE")
    #expect(failure.instructions.contains("src/hoist.ts:19:16"))
    #expect(failure.instructions.contains("not a plain identifier or literal"))
    #expect(try headCommit(dir) == before)
    #expect(try status(dir) == "")
  }
}
