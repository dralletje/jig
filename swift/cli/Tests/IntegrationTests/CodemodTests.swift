// The published codemod image (react-codemod, pinned) end to end on examples/react-app.
import Foundation
import Testing

private let CODEMOD = "localhost/jig/codemod-react:local"

/// Builds the codemod image once (the shared `setup()` builds the binary and the other images).
private let builtCodemod: Result<Void, any Error> = Result {
  try setup()
  let build = try runCommand(
    ["sh", repoRoot.appendingPathComponent("scripts/build-images.sh").path, "codemod-react"], cwd: repoRoot, timeout: 1800)
  guard build.exitCode == 0 else {
    throw TestFailure("build-images.sh codemod-react failed (exit \(build.exitCode)):\n\(build.stderrText)")
  }
}

private struct CodemodBuilt: SuiteTrait, TestScoping {
  var isRecursive: Bool { false }

  func provideScope(
    for test: Test, testCase: Test.Case?, performing function: @Sendable () async throws -> Void
  ) async throws {
    try builtCodemod.get()
    try await function()
  }
}

private let ARGS = ["rename-unsafe-lifecycles", "--files", "src/**"]

@Suite("codemod-react (docker)", .serialized, .enabled(if: dockerAvailable, dockerMissing), CodemodBuilt())
struct CodemodTests {
  let temp = TempDirs()

  @Test("rename-unsafe-lifecycles on the example react-app", .timeLimit(.minutes(3)))
  func renameUnsafeLifecycles() throws {
    let dir = try temp.fixture("examples/react-app")
    let result = try runImage(repo: dir, image: CODEMOD, args: ARGS)
    #expect(result.filesChanged == ["src/components/Counter.tsx"])
    let tree = try readTree(dir)
    #expect(tree["src/components/Counter.tsx"]?.contains("UNSAFE_componentWillMount()") == true)
    #expect(tree["src/components/Counter.tsx"]?.contains("UNSAFE_componentWillReceiveProps(next: CounterProps)") == true)
    #expect(try status(dir) == "")
  }

  @Test("an unknown action is UNKNOWN_ACTION and commits nothing", .timeLimit(.minutes(2)))
  func unknownTransform() throws {
    let dir = try temp.fixture("examples/react-app")
    let before = try headCommit(dir)
    let err = try failImage(repo: dir, image: CODEMOD, args: ["nope", "--files", "src/**"])
    #expect(err.code == "UNKNOWN_ACTION")
    #expect(try headCommit(dir) == before)
  }

  @Test("replaying the recorded command on the parent gives the same tree", .timeLimit(.minutes(4)))
  func replay() throws {
    let dir = try temp.fixture("examples/react-app")
    let first = try runImage(repo: dir, image: CODEMOD, args: ARGS)
    let recorded = try #require(parseRefactorCommand(try git(dir, ["log", "-1", "--format=%B"])))
    #expect(recorded.args == ARGS)
    try git(dir, ["checkout", "-q", "--detach", first.parent])
    let replay = try runImage(repo: dir, image: recorded.image, args: recorded.args)
    #expect(replay.parent == first.parent)
    #expect(try treeOf(dir, replay.commit) == (try treeOf(dir, first.commit)))
    #expect(try status(dir) == "")
  }
}
