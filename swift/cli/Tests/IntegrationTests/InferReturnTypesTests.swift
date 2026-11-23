// infer-return-types through the real typescript image.
import Foundation
import Testing

@Suite("infer-return-types (docker)", .serialized, .enabled(if: dockerAvailable, dockerMissing), .builtOnce)
struct InferReturnTypesTests {
  let temp = TempDirs()

  @Test("infer-return-types in its example repo leaves an inferred any; a second run is NO_CHANGES", .timeLimit(.minutes(2)))
  func exampleInferReturnTypes() throws {
    let dir = try temp.fixture("examples/infer-return-types")
    let args = ["infer-return-types", "--files", "src/**"]
    let result = try runImage(repo: dir, image: TS, args: args)
    #expect(result.filesChanged == ["src/orders.ts", "src/reports.ts"])
    let tree = try readTree(dir)
    #expect(tree["src/orders.ts"]?.contains("export function countLines(order: Order): number {") == true)
    #expect(tree["src/loader.ts"]?.contains("export function parseOrder(text: string) {") == true)
    #expect(try status(dir) == "")
    #expect(try failImage(repo: dir, image: TS, args: args).code == "NO_CHANGES")
  }
}
