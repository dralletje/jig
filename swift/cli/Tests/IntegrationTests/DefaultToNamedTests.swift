// default-to-named end to end on its own example repo (examples/default-to-named).
import Foundation
import Testing

@Suite("default-to-named (docker)", .serialized, .enabled(if: dockerAvailable, dockerMissing), .builtOnce)
struct DefaultToNamedTests {
  let temp = TempDirs()

  @Test("default exports become named, with the refused files listed; a second run is NO_CHANGES", .timeLimit(.minutes(2)))
  func exampleDefaultToNamed() throws {
    let dir = try temp.fixture("examples/default-to-named")
    let args = ["default-to-named", "--files", "src/**", "--keep", "src/routes/**"]
    let result = try runImage(repo: dir, image: TS, args: args)
    #expect(result.kind == "sweep")
    #expect(result.summary.contains("\n\nNot handled (2):\n"), "\(result.summary)")
    #expect(result.filesChanged == [
      "src/config.ts", "src/index.ts", "src/lib/format.ts", "src/models/Order.ts",
      "src/services/checkout.ts", "src/services/mailer.ts", "src/services/store.ts",
    ])
    let subject = "sweep(default-to-named): src/** (keeping src/routes/**)"
    #expect(try git(dir, ["log", "-1", "--format=%s"]) == "\(subject)\n")
    #expect(result.subject == subject)
    let body = try git(dir, ["log", "-1", "--format=%B"])
    #expect(body.contains("\nRefactor-Kind: sweep\nCo-Authored-By: "))
    #expect(body.contains("\nNot handled (2):\n  src/pages/dashboard.ts:1: "), "\(body)")
    let tree = try readTree(dir)
    #expect(tree["src/lib/format.ts"]?.hasPrefix("export function formatPrice(") == true)
    #expect(tree["src/services/checkout.ts"]?.contains(#"import { formatPrice as fmt } from "../lib/format";"#) == true)
    #expect(tree["src/index.ts"]?.contains(#"export { sendReceipt as default } from "./services/mailer";"#) == true)
    #expect(tree["src/routes/about.ts"]?.hasPrefix("export default function About") == true)
    #expect(try status(dir) == "")
    // The converted files have nothing left to convert.
    let again = ["default-to-named", "--files", "src/lib/**,src/models/**,src/services/**,src/config.ts,src/index.ts"]
    #expect(try failImage(repo: dir, image: TS, args: again).code == "NO_CHANGES")
    // The same args: only the refused files are left, so there is nothing to convert.
    #expect(try failImage(repo: dir, image: TS, args: args).code == "NO_CHANGES")
  }
}
