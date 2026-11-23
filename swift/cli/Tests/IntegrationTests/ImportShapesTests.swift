// namespace-to-named and import-type through the real typescript image.
import Foundation
import Testing

@Suite("import shapes (docker)", .serialized, .enabled(if: dockerAvailable, dockerMissing), .builtOnce)
struct ImportShapesTests {
  let temp = TempDirs()

  @Test("namespace-to-named leaves a namespace used as a value alone; a second run is NO_CHANGES", .timeLimit(.minutes(2)))
  func namespaceToNamed() throws {
    let dir = try temp.fixture("examples/import-shapes")
    let args = ["namespace-to-named", "--files", "src/**"]
    let result = try runImage(repo: dir, image: TS, args: args)
    #expect(result.filesChanged == ["src/clash.ts", "src/sums.ts"])
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
    let args = ["import-type", "--files", "src/**"]
    let result = try runImage(repo: dir, image: TS, args: args)
    #expect(result.filesChanged == ["src/mixed.ts", "src/types-only.ts"])
    let tree = try readTree(dir)
    #expect(tree["src/mixed.ts"]?.contains(#"import "./side";"#) == true)
    #expect(tree["src/mixed.ts"]?.contains(#"import describe, { Circle, type Shape, type Unit, area } from "./geometry";"#) == true)
    #expect(tree["src/types-only.ts"]?.hasPrefix(#"import type { Shape, Unit } from "./geometry";"#) == true)
    #expect(try status(dir) == "")
    #expect(try failImage(repo: dir, image: TS, args: args).code == "NO_CHANGES")
  }
}
