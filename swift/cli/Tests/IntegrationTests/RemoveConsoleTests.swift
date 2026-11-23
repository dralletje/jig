// remove-console through the typescript image: calls used as values are left.
import Foundation
import Testing

@Suite("remove-console (docker)", .serialized, .enabled(if: dockerAvailable, dockerMissing), .builtOnce)
struct RemoveConsoleTests {
  let temp = TempDirs()

  @Test("remove-console leaves calls used as values; a second run is NO_CHANGES", .timeLimit(.minutes(2)))
  func removeConsole() throws {
    let dir = try temp.fixture("examples/remove-console")
    let args = ["remove-console", "--files", "src/**", "--methods", "log,debug"]
    let result = try runImage(repo: dir, image: TS, args: args)
    #expect(result.filesChanged == ["src/guards.ts", "src/lines.ts", "src/orders.ts"])
    let tree = try readTree(dir)
    #expect(tree["src/orders.ts"]?.contains("console.warn(") == true)
    #expect(tree["src/orders.ts"]?.contains("console.debug") == false)
    #expect(tree["src/orders.ts"]?.contains("const logged = console.log(") == true)
    #expect(tree["src/guards.ts"]?.contains("if (verbose) console.log") == false)
    #expect(try status(dir) == "")
    #expect(try failImage(repo: dir, image: TS, args: args).code == "NO_CHANGES")
  }
}
