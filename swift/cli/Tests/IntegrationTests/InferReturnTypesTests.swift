// typescript-infer-return-types through the real typescript image.
import Foundation
import Testing

@Suite("typescript-infer-return-types (docker)", .serialized, .enabled(if: dockerAvailable, dockerMissing), .builtOnce)
struct InferReturnTypesTests {
  let temp = TempDirs()

  @Test("infer-return-types in its example repo is a partial sweep; a second run is NO_CHANGES", .timeLimit(.minutes(2)))
  func exampleInferReturnTypes() throws {
    let dir = try temp.fixture("examples/infer-return-types")
    let args = ["typescript-infer-return-types", "--files", "src/**"]
    let result = try runImage(repo: dir, image: TS, args: args)
    #expect(result.kind == "sweep")
    #expect(result.filesChanged == ["src/orders.ts", "src/reports.ts"])
    #expect(result.summary.contains("\n\nNot handled (3):\n"), "\(result.summary)")
    #expect(try git(dir, ["log", "-1", "--format=%s"]) == "sweep(typescript-infer-return-types): src/**\n")
    let body = try git(dir, ["log", "-1", "--format=%B"])
    #expect(body.contains("\nRefactor-Kind: sweep\nCo-Authored-By: "))
    #expect(
      body.contains("\nNot handled (3):\n  src/loader.ts:1: its inferred return type contains an `any` that nobody wrote\n"),
      "\(body)")
    let tree = try readTree(dir)
    #expect(tree["src/orders.ts"]?.contains("export function countLines(order: Order): number {") == true)
    #expect(tree["src/loader.ts"]?.contains("export function parseOrder(text: string) {") == true)
    #expect(try status(dir) == "")
    #expect(try failImage(repo: dir, image: TS, args: args).code == "NO_CHANGES")
  }
}
