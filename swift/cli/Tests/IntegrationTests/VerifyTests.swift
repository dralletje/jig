// `jig verify` end to end: a fresh run is identical, a hand-edited commit, an edited subject or a
// non-deterministic image is different, ranges skip hand-written commits and go on after a failure,
// `--on` is gone, the repo is never touched, and an interruption leaves nothing behind.
// Uses the probe image (docker), plus one fresh-run check with rootlesskit.
import Foundation
import Testing

#if canImport(Glibc)
  import Glibc
#endif

/// One commit in verify's output (`urn:jig:verify:1`).
struct VerifiedCommit: Decodable {
  var commit: String
  var verdict: String
  var command: RefactorCommand?
  var filesDiffering: [String]?
  var mismatches: JSON?
  var code: String?
  var reason: String?
  var instructions: String?
}

/// What verify prints: the verify v1 object, or (before any replay) an output v1 failure.
struct VerifyOutput: Decodable {
  var schema: String
  var ok: Bool
  var commits: [VerifiedCommit]?
  var code: String?
  var instructions: String?
}

struct Verified {
  var exitCode: Int32
  var output: VerifyOutput
  var stdout: String
  var stderr: String

  /// The commits of a verify v1 object (fails the test for an output v1 failure).
  func commits() throws -> [VerifiedCommit] {
    guard output.schema == "urn:jig:verify:1", let commits = output.commits else {
      throw TestFailure("expected verify output, got \(stdout)\n\(stderr)")
    }
    return commits
  }
}

/// `jig verify <argv...>` from `cwd`; stdout must be exactly one JSON line, and the exit
/// code 0 exactly when it is ok.
func verify(_ argv: [String], cwd: URL? = nil, environment: [String: String]? = nil) throws -> Verified {
  let finished = try runCommand([try setup(), "verify"] + argv, cwd: cwd, environment: environment, timeout: 300)
  let stdout = finished.stdoutText
  #expect(
    stdout.hasSuffix("\n") && stdout.firstIndex(of: "\n") == stdout.index(before: stdout.endIndex),
    "\(stdout)\n\(finished.stderrText)")
  let output = try decode(VerifyOutput.self, stdout)
  #expect(finished.exitCode == (output.ok ? 0 : 1), "\(stdout)")
  return Verified(exitCode: finished.exitCode, output: output, stdout: stdout, stderr: finished.stderrText)
}

/// Rewrites HEAD's `Refactor-Command` to run `args` (the same image), keeping the rest of the message and
/// the tree.
func amendRecordedArgs(_ dir: URL, _ args: [String]) throws {
  try amendRecorded(dir, args: args)
}

/// Rewrites HEAD's `Refactor-Command` with `image` and/or `args` (each kept when nil), keeping the rest of
/// the message and the tree.
func amendRecorded(_ dir: URL, image: String? = nil, args: [String]? = nil) throws {
  let message = try git(dir, ["log", "-1", "--format=%B"])
  let recorded = try #require(parseRefactorCommand(message))
  let json = try JSONSerialization.data(
    withJSONObject: ["args": args ?? recorded.args, "image": image ?? recorded.image],
    options: [.sortedKeys, .withoutEscapingSlashes])
  let lines = message.split(separator: "\n", omittingEmptySubsequences: false).map { line in
    line.hasPrefix("Refactor-Command: ") ? "Refactor-Command: " + String(decoding: json, as: UTF8.self) : String(line)
  }
  try git(dir, ["commit", "-q", "--amend", "-m", lines.joined(separator: "\n")])
}

/// The repo's state that verify must never change.
struct RepoState: Equatable {
  var status: String
  var refs: String
  var index: Data
  var config: Data
}

/// HEAD, every ref, the index file's and `.git/config`'s bytes (read before anything else may refresh the
/// index), then the porcelain status.
func repoState(_ dir: URL) throws -> RepoState {
  let index = try Data(contentsOf: dir.appendingPathComponent(".git/index"))
  let config = try Data(contentsOf: dir.appendingPathComponent(".git/config"))
  let refs = try git(dir, ["rev-parse", "HEAD", "--all"])
  return RepoState(status: try status(dir), refs: refs, index: index, config: config)
}

@Suite("verify (docker)", .serialized, .enabled(if: dockerAvailable, dockerMissing), .builtOnce)
struct VerifyTests {
  let temp = TempDirs()

  @Test("a fresh run verifies as identical, exit 0", .timeLimit(.minutes(3)))
  func verifyFreshRunIsIdentical() throws {
    let dir = try temp.repo()
    let ran = try runImage(repo: dir, image: PROBE, args: ["write", "a.txt"])
    let verified = try verify(["--repo", dir.path, "HEAD"])

    #expect(verified.exitCode == 0, "\(verified.stdout)\n\(verified.stderr)")
    #expect(verified.output.ok)
    let commits = try verified.commits()
    #expect(commits.count == 1)
    let only = try #require(commits.first)
    #expect(only.commit == ran.commit)
    #expect(only.verdict == "identical")
    #expect(only.command == RefactorCommand(image: ran.image, args: ["write", "a.txt"]))
    #expect(only.filesDiffering == [])
    #expect(only.mismatches == [])
    #expect(verified.stdout.contains(#""commit":""#) && !verified.stdout.contains("Effect") && !verified.stdout.contains(#""on""#))
  }

  @Test("trailers jig no longer writes (Refactor-Status, Refactor-Effect) are ignored: still identical", .timeLimit(.minutes(3)))
  func verifyIgnoresRemovedTrailers() throws {
    let dir = try temp.repo()
    _ = try runImage(repo: dir, image: PROBE, args: ["write", "a.txt"])
    let message = try git(dir, ["log", "-1", "--format=%B"])
    let amended = message.replacingOccurrences(
      of: "\nRefactor-Kind: refactor\n",
      with: "\nRefactor-Kind: refactor\nRefactor-Status: complete\nRefactor-Effect: sha256:"
        + String(repeating: "0", count: 64) + "\n")
    #expect(amended != message)
    try git(dir, ["commit", "-q", "--amend", "-m", amended])
    let commit = try headCommit(dir)
    let verified = try verify(["--repo", dir.path, "HEAD"])

    #expect(verified.exitCode == 0, "\(verified.stdout)\n\(verified.stderr)")
    let only = try #require(try verified.commits().first)
    #expect(only.commit == commit)
    #expect(only.verdict == "identical")
  }

  @Test("a commit amended by hand (message kept) is different, the edited file listed, exit 1", .timeLimit(.minutes(3)))
  func verifyHandEditedCommitIsDifferent() throws {
    let dir = try temp.repo()
    _ = try runImage(repo: dir, image: PROBE, args: ["write", "a.txt"])
    try write(dir.appendingPathComponent("a.txt"), "from image\nand by hand\n")
    try git(dir, ["commit", "-q", "--amend", "--no-edit", "-a"])
    let verified = try verify(["--repo", dir.path, "HEAD"])

    #expect(verified.exitCode == 1)
    #expect(!verified.output.ok)
    let only = try #require(try verified.commits().first)
    #expect(only.verdict == "different")
    #expect(only.filesDiffering == ["a.txt"])
    #expect(only.mismatches == [])
  }

  @Test("a commit whose subject was edited is different, the subject a mismatch", .timeLimit(.minutes(3)))
  func verifyEditedSubjectIsDifferent() throws {
    let dir = try temp.repo()
    _ = try runImage(repo: dir, image: PROBE, args: ["write", "a.txt"])
    let message = try git(dir, ["log", "-1", "--format=%B"])
    try git(dir, ["commit", "-q", "--amend", "-m", message.replacingOccurrences(of: "refactor(probe): write", with: "refactor(probe): edited")])
    let verified = try verify(["--repo", dir.path, "HEAD"])

    #expect(verified.exitCode == 1)
    let only = try #require(try verified.commits().first)
    #expect(only.verdict == "different")
    #expect(only.filesDiffering == [])
    #expect(only.mismatches == [["field": "subject", "recorded": "refactor(probe): edited", "replayed": "refactor(probe): write"]])
  }

  @Test("an image with random output is different", .timeLimit(.minutes(3)))
  func verifyRandomIsDifferent() throws {
    let dir = try temp.repo()
    _ = try runImage(repo: dir, image: PROBE, args: ["random"])
    let verified = try verify(["--repo", dir.path, "HEAD"])

    #expect(verified.exitCode == 1)
    let only = try #require(try verified.commits().first)
    #expect(only.verdict == "different")
    #expect(only.filesDiffering == ["r.txt"])
    #expect(only.mismatches == [])
  }

  @Test("a range skips hand-written commits and verifies the refactor commit", .timeLimit(.minutes(3)))
  func verifyRangeSkipsHandWritten() throws {
    let dir = try temp.repo()
    let base = try headCommit(dir)
    try commitFile(dir, "hand1.txt", "one\n")
    let first = try headCommit(dir)
    let ran = try runImage(repo: dir, image: PROBE, args: ["write", "a.txt"])
    try commitFile(dir, "hand2.txt", "two\n")
    let last = try headCommit(dir)
    let verified = try verify(["--repo", dir.path, "\(base)..HEAD"])

    #expect(verified.exitCode == 0, "\(verified.stdout)\n\(verified.stderr)")
    let commits = try verified.commits()
    #expect(commits.map(\.commit) == [first, ran.commit, last])
    #expect(commits.map(\.verdict) == ["skipped", "identical", "skipped"])
    #expect(commits[0].reason == "no Refactor-Command")
    #expect(commits[2].reason == "no Refactor-Command")
  }

  @Test("a range of only hand-written commits verifies nothing: not ok, exit 1", .timeLimit(.minutes(3)))
  func verifyRangeAllHandWrittenIsNotOk() throws {
    let dir = try temp.repo()
    let base = try headCommit(dir)
    try commitFile(dir, "hand1.txt", "one\n")
    try commitFile(dir, "hand2.txt", "two\n")
    let verified = try verify(["--repo", dir.path, "\(base)..HEAD"])

    #expect(verified.exitCode == 1)
    #expect(!verified.output.ok)
    #expect(try verified.commits().map(\.verdict) == ["skipped", "skipped"])
  }

  @Test("a replay that fails is failed with its code, and the range goes on", .timeLimit(.minutes(3)))
  func verifyRangeContinuesAfterFailure() throws {
    let dir = try temp.repo()
    let base = try headCommit(dir)
    _ = try runImage(repo: dir, image: PROBE, args: ["write", "a.txt"])
    try amendRecordedArgs(dir, ["fail"])
    let failing = try headCommit(dir)
    let ran = try runImage(repo: dir, image: PROBE, args: ["write", "b.txt"])
    let verified = try verify(["--repo", dir.path, "\(base)..HEAD"])

    #expect(verified.exitCode == 1)
    let commits = try verified.commits()
    #expect(commits.map(\.commit) == [failing, ran.commit])
    #expect(commits.map(\.verdict) == ["failed", "identical"])
    #expect(commits[0].code == "SYMBOL_NOT_FOUND")
    #expect(commits[0].instructions == "nope")
    #expect(commits[0].command?.args == ["fail"])
  }

  @Test("a single commit without Refactor-Command is an INVALID_ARGS error", .timeLimit(.minutes(2)))
  func verifySingleWithoutTrailersErrors() throws {
    let dir = try temp.repo()
    try commitFile(dir, "hand.txt", "hand\n")
    let verified = try verify(["--repo", dir.path, "HEAD"])

    #expect(verified.exitCode == 1)
    #expect(verified.output.schema == "urn:jig:output:1")
    #expect(verified.output.code == "INVALID_ARGS")
    #expect(verified.output.instructions?.contains("Refactor-Command") == true, "\(verified.stdout)")
  }

  @Test("a root commit, even with refactor trailers, is an INVALID_ARGS error", .timeLimit(.minutes(2)))
  func verifyRootCommitErrors() throws {
    let dir = try temp.repo()
    _ = try runImage(repo: dir, image: PROBE, args: ["write", "a.txt"])
    let message = try git(dir, ["log", "-1", "--format=%B"])
    let root = try git(dir, ["commit-tree", try treeOf(dir), "-m", message]).trimmingCharacters(in: .whitespacesAndNewlines)
    let verified = try verify(["--repo", dir.path, root])

    #expect(verified.exitCode == 1)
    #expect(verified.output.schema == "urn:jig:output:1")
    #expect(verified.output.code == "INVALID_ARGS")
    #expect(verified.output.instructions?.contains("root commit") == true, "\(verified.stdout)")
  }

  @Test("trailers followed by a hand-added paragraph are not read: INVALID_ARGS alone, skipped in a range", .timeLimit(.minutes(2)))
  func verifyTrailersNotLastAreNotGuessed() throws {
    let dir = try temp.repo()
    let base = try headCommit(dir)
    _ = try runImage(repo: dir, image: PROBE, args: ["write", "a.txt"])
    let message = try git(dir, ["log", "-1", "--format=%B"])
    try git(dir, ["commit", "-q", "--amend", "-m", message + "\nA paragraph added by hand after the trailers.\n"])
    let commit = try headCommit(dir)

    let single = try verify(["--repo", dir.path, "HEAD"])
    #expect(single.exitCode == 1)
    #expect(single.output.schema == "urn:jig:output:1")
    #expect(single.output.code == "INVALID_ARGS")
    #expect(single.output.instructions?.contains("no Refactor-Command") == true, "\(single.stdout)")

    let range = try verify(["--repo", dir.path, "\(base)..HEAD"])
    #expect(range.exitCode == 1)
    let commits = try range.commits()
    #expect(commits.map(\.commit) == [commit])
    #expect(commits.map(\.verdict) == ["skipped"])
    #expect(commits.first?.reason == "no Refactor-Command")
  }

  @Test("a single merge commit, even with refactor trailers, is an INVALID_ARGS error", .timeLimit(.minutes(2)))
  func verifyMergeCommitErrors() throws {
    let dir = try temp.repo()
    let base = try headCommit(dir)
    _ = try runImage(repo: dir, image: PROBE, args: ["write", "a.txt"])
    let refactor = try headCommit(dir)
    try git(dir, ["checkout", "-q", "-b", "other", base])
    try commitFile(dir, "other.txt", "other\n")
    let other = try headCommit(dir)
    let message = try git(dir, ["log", "-1", "--format=%B", refactor])
    let merge = try git(dir, ["commit-tree", try treeOf(dir, refactor), "-p", refactor, "-p", other, "-m", message])
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let verified = try verify(["--repo", dir.path, merge])

    #expect(verified.exitCode == 1)
    #expect(verified.output.schema == "urn:jig:output:1")
    #expect(verified.output.code == "INVALID_ARGS")
    #expect(verified.output.instructions?.contains("a merge commit (2 parents)") == true, "\(verified.stdout)")
  }

  @Test("a root commit with refactor trailers in a range is skipped as a root commit", .timeLimit(.minutes(2)))
  func verifyRangeSkipsRootCommit() throws {
    let dir = try temp.repo()
    _ = try runImage(repo: dir, image: PROBE, args: ["write", "a.txt"])
    let message = try git(dir, ["log", "-1", "--format=%B"])
    let tree = try treeOf(dir)
    let root = try git(dir, ["commit-tree", tree, "-m", message]).trimmingCharacters(in: .whitespacesAndNewlines)
    let hand = try git(dir, ["commit-tree", tree, "-p", root, "-m", "hand-written"])
      .trimmingCharacters(in: .whitespacesAndNewlines)
    // main's history shares nothing with root, so the range is exactly [root, hand].
    let verified = try verify(["--repo", dir.path, "main..\(hand)"])

    #expect(verified.exitCode == 1)
    let commits = try verified.commits()
    #expect(commits.map(\.commit) == [root, hand])
    #expect(commits.map(\.verdict) == ["skipped", "skipped"])
    #expect(commits.first?.reason == "a root commit (no parent to replay on)")
    #expect(commits.last?.reason == "no Refactor-Command")
  }

  @Test("an unpinned recorded image (a tag) is never replayed: INVALID_ARGS alone, invalid in a range", .timeLimit(.minutes(3)))
  func verifyUnpinnedImageIsInvalid() throws {
    let dir = try temp.repo()
    let base = try headCommit(dir)
    _ = try runImage(repo: dir, image: PROBE, args: ["write", "a.txt"])
    try amendRecorded(dir, image: PROBE)
    let commit = try headCommit(dir)

    let single = try verify(["--repo", dir.path, "HEAD"])
    #expect(single.exitCode == 1)
    #expect(single.output.schema == "urn:jig:output:1")
    #expect(single.output.code == "INVALID_ARGS")
    #expect(single.output.instructions?.contains("an unpinned image") == true, "\(single.stdout)")

    let range = try verify(["--repo", dir.path, "\(base)..HEAD"])
    #expect(range.exitCode == 1)
    let only = try #require(try range.commits().first)
    #expect(only.commit == commit)
    #expect(only.verdict == "invalid")
    #expect(only.code == "INVALID_ARGS")
    #expect(only.reason == "an unpinned image")
    #expect(only.instructions?.contains("<name>@sha256:<64 hex>") == true, "\(range.stdout)")
  }

  @Test("a pinned image this machine does not have fails, saying only that exact ID can replay it", .timeLimit(.minutes(3)))
  func verifyMissingPinnedImageFails() throws {
    let dir = try temp.repo()
    _ = try runImage(repo: dir, image: PROBE, args: ["write", "a.txt"])
    try amendRecorded(dir, image: PROBE + "@sha256:" + String(repeating: "0", count: 64))
    let verified = try verify(["--repo", dir.path, "HEAD"])

    #expect(verified.exitCode == 1)
    let only = try #require(try verified.commits().first)
    #expect(only.verdict == "failed")
    #expect(only.code == "IMAGE_NOT_FOUND")
    #expect(only.instructions?.contains("only a machine that has this exact image ID") == true, "\(verified.stdout)")
  }

  @Test("`verify` after the options is run as an image, and its IMAGE_NOT_FOUND says to put verify first", .timeLimit(.minutes(2)))
  func verifyAsImageNameHints() throws {
    let dir = try temp.repo()
    let ran = try run(["--repo", dir.path, "verify", "HEAD"])
    let failure = try #require(ran.output.failure)
    #expect(failure.code == "IMAGE_NOT_FOUND")
    #expect(failure.instructions.hasSuffix("put `verify` first: jig verify [options] <commit-or-range>."))
  }

  @Test("an empty range is an INVALID_ARGS error saying it has no commits", .timeLimit(.minutes(2)))
  func verifyEmptyRangeErrors() throws {
    let dir = try temp.repo()
    let verified = try verify(["--repo", dir.path, "HEAD..HEAD"])

    #expect(verified.exitCode == 1)
    #expect(verified.output.schema == "urn:jig:output:1")
    #expect(verified.output.code == "INVALID_ARGS")
    #expect(verified.output.instructions?.contains("has no commits to verify") == true, "\(verified.stdout)")
  }

  @Test("--on is not an option of verify: INVALID_ARGS with the usage, which has no --on", .timeLimit(.minutes(2)))
  func verifyOnIsUnknown() throws {
    let dir = try temp.repo()
    _ = try runImage(repo: dir, image: PROBE, args: ["write", "a.txt"])
    let verified = try verify(["--repo", dir.path, "--on", "HEAD~1", "HEAD"])

    #expect(verified.exitCode == 1)
    #expect(verified.output.schema == "urn:jig:output:1")
    #expect(verified.output.code == "INVALID_ARGS")
    let instructions = verified.output.instructions ?? ""
    #expect(instructions.hasPrefix("Unknown option --on for verify. "), "\(instructions)")
    #expect(
      instructions.contains("jig verify [--repo <path>] [--sandbox docker|rootlesskit] <commit-or-range>\n"),
      "\(instructions)")
  }

  @Test("an unknown commit is an INVALID_ARGS error", .timeLimit(.minutes(2)))
  func verifyUnknownCommitErrors() throws {
    let dir = try temp.repo()
    let verified = try verify(["--repo", dir.path, "no-such-branch"])

    #expect(verified.exitCode == 1)
    #expect(verified.output.schema == "urn:jig:output:1")
    #expect(verified.output.code == "INVALID_ARGS")
  }

  @Test("verify from a subdirectory of a dirty, staged repo changes nothing in it", .timeLimit(.minutes(3)))
  func verifyLeavesRepoUntouched() throws {
    let dir = try temp.repo()
    try commitFile(dir, "sub/s.txt", "s\n")
    let ran = try runImage(repo: dir, image: PROBE, args: ["write", "a.txt"])
    try write(dir.appendingPathComponent("a.txt"), "dirty\n")
    try write(dir.appendingPathComponent("staged.txt"), "staged\n")
    try git(dir, ["add", "staged.txt"])
    try write(dir.appendingPathComponent("sub/untracked.txt"), "untracked\n")
    let sub = dir.appendingPathComponent("sub")
    _ = try status(dir)  // let git refresh the index first, so only verify could change it
    let before = try repoState(dir)
    #expect(before.status.contains("a.txt") && before.status.contains("staged.txt"))

    let fromCwd = try verify(["HEAD"], cwd: sub)
    #expect(try repoState(dir) == before)
    let fromRepo = try verify(["--repo", sub.path, "HEAD"])
    #expect(try repoState(dir) == before)

    for verified in [fromCwd, fromRepo] {
      #expect(verified.exitCode == 0, "\(verified.stdout)\n\(verified.stderr)")
      let only = try #require(try verified.commits().first)
      #expect(only.commit == ran.commit)
      #expect(only.verdict == "identical")
    }
    #expect(try readText(dir.appendingPathComponent("a.txt")) == "dirty\n")
  }
}

extension DockerInterruptionSuites {
  @Suite("verify interruptions (docker)", .serialized, .enabled(if: dockerAvailable, dockerMissing), .builtOnce)
  struct VerifyInterruptionTests {
    let temp = TempDirs()

    @Test("SIGTERM during a replay: exit 143, an INTERNAL failure, no container and no temp folder left", .timeLimit(.minutes(3)))
    func verifyInterruptedLeavesNothing() throws {
      let dir = try temp.repo()
      let token = "verify-\(UUID().uuidString)"
      _ = try runImage(repo: dir, image: PROBE, args: ["sleep", "0", token])
      try amendRecordedArgs(dir, ["sleep", "600", token])
      let before = try headCommit(dir)
      let started = try startCommand([try setup(), "verify", "--repo", dir.path, "HEAD"])
      let container = try runningContainer(token: token)
      let workspace = try #require(container.workspace)
      let folder = URL(fileURLWithPath: workspace).deletingLastPathComponent()
      kill(started.pid, SIGTERM)
      let finished = try started.wait(timeout: 60)

      #expect(finished.exitCode == 143)
      let output = try onlyOutput(finished)
      #expect(output.code == "INTERNAL")
      #expect(output.instructions?.hasPrefix("interrupted by SIGTERM") == true, "\(output.instructions ?? "")")
      #expect(try containers(token: token).isEmpty)
      #expect(!fm.fileExists(atPath: folder.path), "left: \(folder.path)\n\(finished.stderrText)")
      if fm.fileExists(atPath: folder.path) { removeTree(folder) }
      #expect(try headCommit(dir) == before)
      #expect(try status(dir) == "")
    }
  }
}

@Suite("verify (rootlesskit)", .serialized, .enabled(if: rootlesskitAvailable, rootlesskitMissing), .builtOnce)
struct VerifyRootlesskitTests {
  let temp = TempDirs()

  @Test("a fresh rootlesskit run verifies as identical with rootlesskit", .timeLimit(.minutes(3)))
  func verifyFreshRunIsIdentical() throws {
    let dir = try temp.repo()
    let ran = try runImage(repo: dir, image: PROBE, args: ["write", "a.txt"], sandbox: "rootlesskit")
    let verified = try verify(["--repo", dir.path, "--sandbox", "rootlesskit", "HEAD"])

    #expect(verified.exitCode == 0, "\(verified.stdout)\n\(verified.stderr)")
    let only = try #require(try verified.commits().first)
    #expect(only.commit == ran.commit)
    #expect(only.verdict == "identical")
  }
}
