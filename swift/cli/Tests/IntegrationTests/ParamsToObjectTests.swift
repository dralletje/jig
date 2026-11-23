// params-to-object through the real binary and the typescript image.
import Foundation
import Testing

@Suite("params-to-object (docker)", .serialized, .enabled(if: dockerAvailable, dockerMissing), .builtOnce)
struct ParamsToObjectTests {
  let temp = TempDirs()

  @Test("a three-parameter function and its calls in two files become an object", .timeLimit(.minutes(2)))
  func exampleParamsToObject() throws {
    let dir = try temp.fixture("examples/params-to-object")
    let args = ["params-to-object", "--file", "src/shipping.ts", "--symbol", "shippingCost"]
    let result = try runImage(repo: dir, image: TS, args: args)
    #expect(result.filesChanged == ["src/checkout.ts", "src/reports.ts", "src/shipping.ts"])
    let tree = try readTree(dir)
    #expect(tree["src/checkout.ts"]?.contains("shippingCost({ weightKg, distanceKm, express: false })") == true)
    #expect(tree["src/reports.ts"]?.contains("shippingCost({ weightKg: w, distanceKm: 120, express: false })") == true)
    #expect(try status(dir) == "")
  }

  @Test("a function passed as a callback is REFACTOR_UNAVAILABLE and nothing is committed", .timeLimit(.minutes(2)))
  func callbackRefused() throws {
    let dir = try temp.fixture("examples/params-to-object")
    let before = try headCommit(dir)
    let err = try failImage(
      repo: dir, image: TS, args: ["params-to-object", "--file", "src/shipping.ts", "--symbol", "notify"])
    #expect(err.code == "REFACTOR_UNAVAILABLE")
    #expect(try headCommit(dir) == before)
    #expect(try status(dir) == "")
  }
}
