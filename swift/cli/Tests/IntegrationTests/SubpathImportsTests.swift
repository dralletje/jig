// subpath-imports end to end, on its own example repo.
import Foundation
import Testing

@Suite("subpath-imports (docker)", .serialized, .enabled(if: dockerAvailable, dockerMissing), .builtOnce)
struct SubpathImportsTests {
  let temp = TempDirs()

  @Test("subpath-imports in examples/subpath-imports; a second run is NO_CHANGES", .timeLimit(.minutes(2)))
  func exampleSubpathImports() throws {
    let dir = try temp.fixture("examples/subpath-imports")
    let args = ["subpath-imports", "--files", "src/**"]
    let result = try runImage(repo: dir, image: TS, args: args)
    #expect(result.filesChanged == [
      "package.json", "src/components/Total.ts", "src/lib/format.ts", "src/lib/index.ts", "src/main.ts",
    ])
    let tree = try readTree(dir)
    #expect(tree["package.json"]?.contains(##""#/*": "./src/*""##) == true)
    #expect(tree["package.json"]?.contains(##""#config": "./src/config.ts""##) == true)
    #expect(tree["src/lib/index.ts"]?.contains(##"export { clamp, sum } from "#/lib/math.ts";"##) == true)
    #expect(tree["tsconfig.json"]?.contains(#""@/*": ["./src/*"]"#) == true)
    #expect(try status(dir) == "")
    #expect(try failImage(repo: dir, image: TS, args: args).code == "NO_CHANGES")
  }
}
