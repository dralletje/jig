// remove-console through the typescript image: a rewrite, partial when calls are used as values.
import Foundation
import Testing

@Suite("remove-console (docker)", .serialized, .enabled(if: dockerAvailable, dockerMissing), .builtOnce)
struct RemoveConsoleTests {
  let temp = TempDirs()

  @Test("remove-console is a rewrite, partial for calls used as values; a second run is NO_CHANGES", .timeLimit(.minutes(2)))
  func removeConsole() throws {
    let dir = try temp.fixture("examples/remove-console")
    let args = ["remove-console", "--files", "src/**", "--methods", "log,debug"]
    let result = try runImage(repo: dir, image: TS, args: args)
    #expect(result.kind == "rewrite")
    #expect(result.filesChanged == ["src/guards.ts", "src/lines.ts", "src/orders.ts"])
    #expect(result.summary.contains("\n\nNot handled (2):\n  src/"), "\(result.summary)")
    #expect(
      try git(dir, ["log", "-1", "--format=%s"])
        == "rewrite(remove-console): console.log, console.debug in src/**\n")
    let body = try git(dir, ["log", "-1", "--format=%B"])
    #expect(body.contains("\n\nNot handled (2):\n  src/"))
    #expect(body.contains("\nRefactor-Kind: rewrite\nCo-Authored-By: "))
    #expect(result.summary.hasPrefix("Removed "))
    let tree = try readTree(dir)
    #expect(tree["src/orders.ts"]?.contains("console.warn(") == true)
    #expect(tree["src/orders.ts"]?.contains("console.debug") == false)
    #expect(tree["src/orders.ts"]?.contains("const logged = console.log(") == true)
    #expect(tree["src/guards.ts"]?.contains("if (verbose) console.log") == false)
    #expect(try status(dir) == "")
    #expect(try failImage(repo: dir, image: TS, args: args).code == "NO_CHANGES")
  }
}
