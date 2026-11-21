// typescript-namespace-to-named and typescript-import-type through the real typescript image.
import Foundation
import Testing

@Suite("import shapes (docker)", .serialized, .enabled(if: dockerAvailable, dockerMissing), .builtOnce)
struct ImportShapesTests {
  let temp = TempDirs()

  @Test("namespace-to-named is a partial sweep (a namespace used as a value is left alone); a second run is NO_CHANGES", .timeLimit(.minutes(2)))
  func namespaceToNamed() throws {
    let dir = try temp.fixture("examples/import-shapes")
    let args = ["typescript-namespace-to-named", "--files", "src/**"]
    let result = try runImage(repo: dir, image: TS, args: args)
    #expect(result.kind == "sweep")
    #expect(result.filesChanged == ["src/clash.ts", "src/sums.ts"])
    #expect(result.subject == "sweep(typescript-namespace-to-named): src/**")
    #expect(try git(dir, ["log", "-1", "--format=%s"]) == "sweep(typescript-namespace-to-named): src/**\n")
    let body = try git(dir, ["log", "-1", "--format=%B"])
    #expect(body.contains("\nRefactor-Kind: sweep\nCo-Authored-By: "))
    #expect(
      result.summary.hasSuffix(
        "\n\nNot handled (1):\n  src/whole.ts:1: `math` is used as a value on its own\n"
          + "    Left `import * as math from \"./math\"` in src/whole.ts as it is. Use math only as math.<name> (or "
          + "leave the import as a namespace import), then run again."),
      "\(result.summary)")
    let tree = try readTree(dir)
    #expect(tree["src/sums.ts"]?.hasPrefix(#"import { add, mul, PI, Pair } from "./math";"#) == true)
    #expect(tree["src/clash.ts"]?.hasPrefix(#"import { add as add_1 } from "./math";"#) == true)
    #expect(tree["src/whole.ts"]?.hasPrefix(#"import * as math from "./math";"#) == true)
    #expect(try status(dir) == "")
    #expect(try failImage(repo: dir, image: TS, args: args).code == "NO_CHANGES")
  }

  @Test("import-type splits mixed imports and leaves side-effect imports; a second run is NO_CHANGES", .timeLimit(.minutes(2)))
  func importType() throws {
    let dir = try temp.fixture("examples/import-shapes")
    let args = ["typescript-import-type", "--files", "src/**"]
    let result = try runImage(repo: dir, image: TS, args: args)
    #expect(result.kind == "sweep")
    #expect(result.filesChanged == ["src/mixed.ts", "src/types-only.ts"])
    #expect(try git(dir, ["log", "-1", "--format=%s"]) == "sweep(typescript-import-type): src/**\n")
    let body = try git(dir, ["log", "-1", "--format=%B"])
    #expect(body.contains("\nRefactor-Kind: sweep\nCo-Authored-By: "))
    #expect(!result.summary.contains("Not handled"))
    let tree = try readTree(dir)
    #expect(tree["src/mixed.ts"]?.contains(#"import "./side";"#) == true)
    #expect(tree["src/mixed.ts"]?.contains(#"import describe, { Circle, type Shape, type Unit, area } from "./geometry";"#) == true)
    #expect(tree["src/types-only.ts"]?.hasPrefix(#"import type { Shape, Unit } from "./geometry";"#) == true)
    #expect(try status(dir) == "")
    #expect(try failImage(repo: dir, image: TS, args: args).code == "NO_CHANGES")
  }
}
