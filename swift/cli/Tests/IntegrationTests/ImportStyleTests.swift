// imports-to-relative, imports-to-alias and imports-to-subpath end to end, on their own example repo.
import Foundation
import Testing

@Suite("imports-to-* (docker)", .serialized, .enabled(if: dockerAvailable, dockerMissing), .builtOnce)
struct ImportStyleTests {
  let temp = TempDirs()

  @Test("imports-to-relative in examples/import-styles; a second run is NO_CHANGES", .timeLimit(.minutes(2)))
  func importsToRelative() throws {
    let dir = try temp.fixture("examples/import-styles")
    let args = ["imports-to-relative", "--files", "src/**", "--targets", "**"]
    let result = try runImage(repo: dir, image: TS, args: args)
    #expect(result.filesChanged == ["src/components/Invoice.ts", "src/main.ts"])
    let tree = try readTree(dir)
    #expect(tree["src/components/Invoice.ts"]?.contains(#"import type { Day } from "../lib/date.ts";"#) == true)
    #expect(tree["src/components/Invoice.ts"]?.contains(#"import { cents } from "../lib/money.ts";"#) == true)
    #expect(tree["src/main.ts"]?.contains(#"import { formatDay } from "./lib/index.ts";"#) == true)
    #expect(try status(dir) == "")
    #expect(try failImage(repo: dir, image: TS, args: args).code == "NO_CHANGES")
  }

  @Test("imports-to-alias in examples/import-styles; a missing alias is INVALID_ARGS", .timeLimit(.minutes(2)))
  func importsToAlias() throws {
    let dir = try temp.fixture("examples/import-styles")
    #expect(
      try failImage(
        repo: dir, image: TS, args: ["imports-to-alias", "--files", "src/**", "--targets", "**", "--alias", "~/"]
      ).code == "INVALID_ARGS")
    let args = ["imports-to-alias", "--files", "src/**", "--targets", "src/lib/**", "--alias", "@/"]
    let result = try runImage(repo: dir, image: TS, args: args)
    #expect(result.filesChanged == ["src/components/Invoice.ts", "src/lib/index.ts"])
    let tree = try readTree(dir)
    #expect(tree["src/components/Invoice.ts"]?.contains(#"import { formatDay } from "@/lib/date.ts";"#) == true)
    #expect(tree["src/components/Invoice.ts"]?.contains(#"import("@/lib/index.ts")"#) == true)
    #expect(tree["src/lib/index.ts"] == "export { formatDay } from \"@/lib/date.ts\";\nexport { cents } from \"@/lib/money.ts\";\n")
    // The import of a component is outside --targets and stays relative.
    #expect(tree["src/main.ts"]?.contains(#"import { invoiceLine } from "./components/Invoice.ts";"#) == true)
    #expect(try status(dir) == "")
  }

  @Test("imports-to-subpath in examples/import-styles; package.json is not changed", .timeLimit(.minutes(2)))
  func importsToSubpath() throws {
    let dir = try temp.fixture("examples/import-styles")
    let args = ["imports-to-subpath", "--files", "src/**", "--targets", "**", "--prefix", "#/"]
    let result = try runImage(repo: dir, image: TS, args: args)
    #expect(result.filesChanged == ["src/components/Invoice.ts", "src/lib/index.ts", "src/main.ts"])
    let tree = try readTree(dir)
    #expect(tree["src/main.ts"]?.contains(##"import { invoiceLine } from "#/components/Invoice.ts";"##) == true)
    #expect(tree["src/lib/index.ts"]?.contains(##"export { formatDay } from "#/lib/date.ts";"##) == true)
    #expect(tree["package.json"]?.contains(##""#/*": "./src/*""##) == true)
    #expect(try status(dir) == "")
    #expect(try failImage(repo: dir, image: TS, args: args).code == "NO_CHANGES")
  }
}
