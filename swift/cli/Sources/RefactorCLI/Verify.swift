import ChildProcess
import Foundation
import Git
import OCI
import Report
import Sandbox

/// Replays refactor commits and compares each with what it recorded (`jig verify`).
///
/// `target` is one commit, or a range (anything with `..`: `git rev-list --reverse --no-merges`, oldest
/// first). Each commit's recorded `Refactor-Command` is resolved with `sandbox` and replayed on the
/// commit's parent through a temporary index as a run does, but nothing is committed: the repo's work
/// tree, index, refs and config are never written, and a dirty work tree is fine.
///
/// A single commit that cannot be verified (no `Refactor-Command`, a root or merge commit, unreadable
/// trailers) throws `INVALID_ARGS` with instructions; in a range it is `skipped` (or `invalid`) and the
/// others go on; a range with no commits (or only merges) throws `INVALID_ARGS`. A replay that fails
/// (resolving the image, the image itself, the capture checks) is `failed` with the error's code and
/// instructions, and a range goes on after it.
public func verifyCommits(repo: String, target: String, sandbox: any Sandbox) throws -> [CommitVerification] {
  let top = try Git(cwd: URL(fileURLWithPath: repo))(["rev-parse", "--show-toplevel"])
    .trimmingCharacters(in: .newlines)
  let git = Git(cwd: URL(fileURLWithPath: top))

  guard target.contains("..") else {
    let commit = try resolveCommit(
      git, target,
      unknown: "The commit \(target) is not a commit of this repository. Give a commit (a hash, branch or tag), "
        + "or a range such as main..HEAD.")
    switch try readRecorded(git, commit) {
    case .recorded(let recorded, let parent):
      return [verifyOne(git, commit: commit, recorded: recorded, parent: parent, sandbox: sandbox)]
    case .skipped(let reason, let instructions), .invalid(let reason, let instructions):
      throw RefactorError(code: .INVALID_ARGS, instructions: "\(commit) cannot be verified: \(reason). \(instructions)")
    }
  }

  let listed: String
  do {
    listed = try git(["--no-replace-objects", "rev-list", "--reverse", "--no-merges", "--end-of-options", target, "--"])
  } catch let failed as CommandFailed {
    throw RefactorError(
      code: .INVALID_ARGS,
      instructions: "The range \(target) cannot be listed: "
        + "\(failed.stderr.trimmingCharacters(in: .whitespacesAndNewlines)). Give a range of commits of this "
        + "repository, such as main..HEAD.")
  }
  let commits = listed.split(separator: "\n").map(String.init)
  if commits.isEmpty {
    throw RefactorError(
      code: .INVALID_ARGS,
      instructions: "The range \(target) has no commits to verify (merge commits are not verified). Give a range "
        + "that holds the refactor commits, such as main..HEAD.")
  }
  return try commits.map { commit in
    switch try readRecorded(git, commit) {
    case .recorded(let recorded, let parent):
      return verifyOne(git, commit: commit, recorded: recorded, parent: parent, sandbox: sandbox)
    case .skipped(let reason, _):
      return CommitVerification(commit: commit, verdict: .skipped, reason: reason)
    case .invalid(let reason, let instructions):
      return CommitVerification(
        commit: commit, verdict: .invalid, code: .INVALID_ARGS, reason: reason, instructions: instructions)
    }
  }
}

/// The full hash of the commit `rev` names, or `INVALID_ARGS` with `unknown` as its instructions.
private func resolveCommit(_ git: Git, _ rev: String, unknown: String) throws -> String {
  do {
    return try git(["--no-replace-objects", "rev-parse", "--verify", "--quiet", "--end-of-options", "\(rev)^{commit}"])
      .trimmingCharacters(in: .newlines)
  } catch is CommandFailed {
    throw RefactorError(code: .INVALID_ARGS, instructions: unknown)
  }
}

/// What a commit recorded and its one parent, or why it is not one to verify.
private enum Recorded {
  case recorded(RecordedCommand, parent: String)
  /// Not a refactor commit on one parent: a short reason, and what to do instead.
  case skipped(String, String)
  /// Refactor trailers that cannot be read: a short reason, and what to do.
  case invalid(String, String)
}

private func readRecorded(_ git: Git, _ commit: String) throws -> Recorded {
  let read = try readCommitTrailers(git, commit)
  guard let command = read.trailers["Refactor-Command"] else {
    return .skipped(
      "no Refactor-Command",
      "Only commits jig made can be verified (their Refactor-Command trailer in the last "
        + "paragraph of the message); review a hand-written commit by reading it.")
  }
  guard read.parents.count == 1, let parent = read.parents.first else {
    if read.parents.isEmpty {
      return .skipped(
        "a root commit (no parent to replay on)",
        "A refactor commit is replayed on its parent, and a root commit has none; review it by reading it.")
    }
    return .skipped(
      "a merge commit (\(read.parents.count) parents)",
      "A refactor commit has exactly one parent, and a merge is not replayed; verify the commits it merges "
        + "instead.")
  }
  // Other trailers (a hand-added one, or one an older jig wrote) are ignored.
  guard let kind = read.trailers["Refactor-Kind"] else {
    return .invalid(
      "no Refactor-Kind",
      "The commit has a Refactor-Command trailer but no Refactor-Kind. Verify only commits jig made, "
        + "with their trailers unchanged.")
  }
  do {
    let recorded = try parseRecordedCommand(json: command, kind: kind, subject: read.subject)
    // Only a pinned image replays what was run: a tag would pin to today's image, a path to whatever file
    // the branch has there now.
    guard PinnedImage.split(recorded.image) != nil else {
      return .invalid(
        "an unpinned image",
        "The recorded image \(recorded.image) is not pinned: it must be <name>@sha256:<64 hex>, as "
          + "jig records it. This commit was not made by jig, or its trailers were "
          + "edited; review it by reading it.")
    }
    return .recorded(recorded, parent: parent)
  } catch let error as RefactorError {
    return .invalid("unreadable Refactor-Command", error.instructions)
  }
}

/// Replays `recorded` on `parent` and compares it (tree, kind and subject) with the commit. Any failure
/// to resolve, replay or compare is the verdict `failed`, with the error's code and instructions.
private func verifyOne(
  _ git: Git, commit: String, recorded: RecordedCommand, parent: String, sandbox: any Sandbox
) -> CommitVerification {
  do {
    let pinned = try sandbox.resolve(recorded.image)
    let replayed = try replay(git: git, base: parent, pinned: pinned, args: recorded.args, sandbox: sandbox)
    let tree = try git(["--no-replace-objects", "rev-parse", "\(commit)^{tree}"]).trimmingCharacters(in: .newlines)
    let treesEqual = replayed.tree == tree
    var differing: [String] = []
    if !treesEqual {
      let names = try git.data([
        "--no-replace-objects", "diff-tree", "-r", "--no-renames", "--name-only", "-z", replayed.tree, tree,
      ])
      differing = try nulSeparatedPaths(names).sorted().map(\.description)
    }
    let (judged, mismatches) = verdict(recorded: recorded, replayed: replayed.report, treesEqual: treesEqual)
    return CommitVerification(
      commit: commit, verdict: judged, command: recorded, filesDiffering: differing, mismatches: mismatches)
  } catch {
    let failure = RefactorError.from(error)
    var instructions = failure.instructions
    if failure.code == .IMAGE_NOT_FOUND, isLocalImage(recorded.image) {
      instructions +=
        " A localhost/ image is taken from this machine's Docker: only a machine that has this exact image ID "
        + "can replay the commit, and rebuilding the image usually gives a new ID."
    }
    if failure.code == .IMAGE_NOT_FOUND, !isLocalImage(recorded.image) {
      instructions +=
        " jig downloads a registry image by the digest the commit pinned, never by its tag, so the registry "
        + "must still have that digest."
    }
    return CommitVerification(
      commit: commit, verdict: .failed, command: recorded, code: failure.code, instructions: instructions)
  }
}
