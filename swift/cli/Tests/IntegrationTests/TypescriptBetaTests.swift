// The experimental typescript-beta image (containers/typescript-beta) end to end, and that the plain
// typescript image carries nothing of TypeScript 7.
import Foundation
import Testing

private let TS_BETA = "localhost/jig/typescript-beta:local"

/// Builds the typescript-beta image once (the shared `setup()` builds the binary and the typescript image).
private let builtBeta: Result<Void, any Error> = Result {
  try setup()
  let build = try runCommand(
    ["sh", repoRoot.appendingPathComponent("scripts/build-images.sh").path, "typescript-beta"], cwd: repoRoot,
    timeout: 1800)
  guard build.exitCode == 0 else {
    throw TestFailure("build-images.sh typescript-beta failed (exit \(build.exitCode)):\n\(build.stderrText)")
  }
}

private struct BetaBuilt: SuiteTrait, TestScoping {
  var isRecursive: Bool { false }

  func provideScope(
    for test: Test, testCase: Test.Case?, performing function: @Sendable () async throws -> Void
  ) async throws {
    try builtBeta.get()
    try await function()
  }
}

@Suite("typescript-beta (docker)", .serialized, .enabled(if: dockerAvailable, dockerMissing), BetaBuilt())
struct TypescriptBetaTests {
  let temp = TempDirs()

  @Test("duplicate-folder on TypeScript 7.1.0-beta gives the same commit as the plain image", .timeLimit(.minutes(5)))
  func duplicateFolderSameAsPlain() throws {
    let args = ["duplicate-folder", "--from", "src/feature", "--to", "src/feature-copy"]
    let beta = try temp.fixture("examples/duplicate-folder")
    let plain = try temp.fixture("examples/duplicate-folder")
    let betaRun = try runImage(repo: beta, image: TS_BETA, args: args)
    let plainRun = try runImage(repo: plain, image: TS, args: args)
    #expect(betaRun.filesChanged == plainRun.filesChanged)
    #expect(try readTree(beta) == readTree(plain))
  }

  @Test("the plain typescript image has no TypeScript 7 and does not ask for it", .timeLimit(.minutes(2)))
  func plainImageHasNoTypeScript7() throws {
    let script =
      "let found = true; try { require.resolve('typescript7', { paths: ['/app/packages/engine-typescript'] }) } catch { found = false }; "
      + "console.log(JSON.stringify({ found, env: process.env.JIG_TYPESCRIPT ?? null }))"
    let ran = try runCommand(["docker", "run", "--rm", "--entrypoint", "node", TS, "-e", script])
    #expect(ran.exitCode == 0, "\(ran.stderrText)")
    #expect(ran.stdoutText.trimmingCharacters(in: .whitespacesAndNewlines) == #"{"found":false,"env":null}"#)
  }
}
