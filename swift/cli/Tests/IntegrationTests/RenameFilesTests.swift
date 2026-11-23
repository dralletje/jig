// rename-files through the binary and the typescript image.
import Foundation
import Testing

@Suite("rename-files (docker)", .serialized, .enabled(if: dockerAvailable, dockerMissing), .builtOnce)
struct RenameFilesTests {
  let temp = TempDirs()

  @Test("kebab case on the example repo; a second run is NO_CHANGES", .timeLimit(.minutes(3)))
  func kebab() throws {
    let dir = try temp.fixture("examples/rename-files")
    let args = ["rename-files", "--files", "src/**", "--case", "kebab"]
    let result = try runImage(repo: dir, image: TS, args: args)
    #expect(result.filesChanged == [
      "src/Footer.ts", "src/UserCard.ts", "src/footer.ts", "src/index.ts", "src/main.ts", "src/order-item.ts",
      "src/order-service.test.ts", "src/order-service.ts", "src/orderService.test.ts", "src/orderService.ts",
      "src/order_item.ts", "src/ui/ButtonGroup.ts", "src/ui/button-group.ts", "src/user-card.ts",
    ])
    let tree = try readTree(dir)
    #expect(tree["src/Footer.ts"] == nil)
    #expect(tree["src/footer.ts"] != nil)
    #expect(tree["src/UserCard.ts"] == nil)
    #expect(tree["src/user-card.ts"] != nil)
    #expect(tree["src/index.ts"]?.contains(#"export * from "./user-card";"#) == true)
    #expect(tree["src/main.ts"]?.contains(#"from "./ui/button-group""#) == true)
    #expect(tree["src/order-service.ts"]?.contains(#"from "./order-item""#) == true)
    #expect(try status(dir) == "")
    #expect(try failImage(repo: dir, image: TS, args: args).code == "NO_CHANGES")
  }

  @Test("an unknown case is INVALID_ARGS", .timeLimit(.minutes(2)))
  func unknownCase() throws {
    let dir = try temp.fixture("examples/rename-files")
    let failure = try failImage(
      repo: dir, image: TS, args: ["rename-files", "--files", "src/**", "--case", "title"])
    #expect(failure.code == "INVALID_ARGS")
    #expect(try status(dir) == "")
  }
}
