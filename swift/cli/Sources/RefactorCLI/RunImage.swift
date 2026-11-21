import ChildProcess
import Foundation
import Git
import Report
import Sandbox

/// A successful run: the new commit on top of `parent`, and what it changed.
public struct RunResult: Equatable, Sendable {
  public var commit: String
  public var parent: String
  public var image: String
  public var args: [String]
  public var report: Report
  public var filesChanged: [String]
  /// What the output says besides the commit: that a cached image was used because its registry could
  /// not be reached (`PinnedImage.note`). Empty for most runs.
  public var notes: [String] = []

  public var json: String {
    successJSON(
      commit: commit, parent: parent, image: image, args: args, report: report, filesChanged: filesChanged,
      notes: notes)
  }
}

/// Runs `image` with `args` in `sandbox` on an export of `HEAD`, without network, and commits what it
/// changed on top of `HEAD`. The commit records the image pinned (a registry image by the digest its tag
/// points to, a `localhost/` image by its local ID) and the args, so running them
/// on the parent replays it. Nothing is validated, and nothing is written to the work tree, index or refs
/// before the final fast-forward. An interruption (see `installInterruptHandlers`) runs the sandbox's
/// cleanup and removes the temporary folders; during the fast-forward it waits for it.
public func runImage(repo: String, image: String, args: [String], message: String?, sandbox: any Sandbox) throws
  -> RunResult
{
  // 1. The repo root, clean, and its config.
  let top = try Git(cwd: URL(fileURLWithPath: repo))(["rev-parse", "--show-toplevel"])
    .trimmingCharacters(in: .newlines)
  let git = Git(cwd: URL(fileURLWithPath: top))
  try assertClean(git)
  let config = try loadConfig(repo: git.cwd)

  // 2. The image, pinned (downloaded first when it is a registry image the store does not have).
  let pinned: PinnedImage
  do {
    pinned = try sandbox.resolve(image)
  } catch {
    // `verify` after other options is the run form with an image named verify: say how to verify.
    var failure = RefactorError.from(error)
    guard image == "verify", failure.code == .IMAGE_NOT_FOUND else { throw error }
    failure.instructions += " To verify commits, put `verify` first: jig verify [options] <commit-or-range>."
    throw failure
  }

  // 3–6. Replay the image on an export of HEAD and capture what it left (the temp folder is gone after).
  let parent = try git(["rev-parse", "--verify", "HEAD^{commit}"]).trimmingCharacters(in: .newlines)
  let replayed = try replay(git: git, base: parent, pinned: pinned, args: args, sandbox: sandbox)
  let tree = replayed.tree
  let report = replayed.report

  // 7. Nothing changed.
  let parentTree = try git(["rev-parse", "\(parent)^{tree}"]).trimmingCharacters(in: .newlines)
  if tree == parentTree {
    throw RefactorError(
      code: .NO_CHANGES,
      instructions: "The image changed nothing (it said: \(report.summary)). There is nothing to commit; "
        + "check the arguments if a change was expected.")
  }

  // 8. The commit, without hooks.
  let text = commitMessage(
    report: report, message: message, image: pinned.reference, args: args, coAuthor: config.coAuthor)
  let commit = try git(["commit-tree", tree, "-p", parent], stdin: Data(text.utf8))
    .trimmingCharacters(in: .newlines)

  // 9. Move the branch (or detached HEAD), index and files.
  try fastForward(git, parent: parent, commit: commit)

  // 11. What changed.
  let names = try git.data(["diff", "--no-renames", "--name-only", "-z", parent, commit])
  return RunResult(
    commit: commit, parent: parent, image: pinned.reference, args: args, report: report,
    filesChanged: try nulSeparatedPaths(names).sorted().map(\.description),
    notes: pinned.note.map { [$0] } ?? [])
}
