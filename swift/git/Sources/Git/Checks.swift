import ChildProcess
import Foundation
import Report

private func imageFailed(_ instructions: String) -> RefactorError {
  RefactorError(code: .IMAGE_FAILED, instructions: instructions)
}

/// The next step after an image broke one of the host's rules: nothing was committed.
private let ruleBroken = "Nothing was committed. Run the image with arguments that leave these alone, or report the image."

private func joined(_ paths: [GitPath]) -> String { paths.map(\.description).joined(separator: ", ") }

/// The checks on what the image left, before git reads the export: no `.git` entry (`git add -A` would
/// open a repo a gitfile points at) and no change to a `.gitattributes` (it could select a host filter
/// driver during the capture). `attributesBefore` is the export's scan before the image ran.
public func checkLeftovers(_ scan: FolderScan, attributesBefore: [GitPath: AttributesEntry]) throws {
  if !scan.dotGit.isEmpty {
    throw imageFailed("the image created a .git entry: \(joined(scan.dotGit)). \(ruleBroken)")
  }
  let attributes = changedAttributes(before: attributesBefore, after: scan.attributes)
  if !attributes.isEmpty {
    throw imageFailed("the image changed a .gitattributes file: \(joined(attributes)). \(ruleBroken)")
  }
}

/// The checks that run on the captured tree, before anything is committed: no `.gitignore` change, no
/// new or changed gitlink. Gitlinks of `head` the image removed (their folder is empty in the export, so
/// removing it is not a change to the submodule) are put back. Returns the final tree.
public func checkCapture(_ workspace: Workspace, git: Git, head: [GitPath: TreeEntry], tree: String) throws -> String {
  var captured: [GitPath: TreeEntry]
  do {
    captured = try lsTree(git, tree)
  } catch let bad as NonUTF8Path {
    throw imageFailed("the image created a path that is not valid UTF-8: \(bad.path). \(ruleBroken)")
  }
  let changed = Set(head.keys).union(captured.keys).filter { head[$0] != captured[$0] && $0.isNamed(".gitignore") }
  let hidden = try workspace.ignoredGitignores()
  if !changed.isEmpty || !hidden.isEmpty {
    throw imageFailed("the image changed a .gitignore file: \(joined(Set(changed).union(hidden).sorted())). \(ruleBroken)")
  }

  let gitlinks = captured.values.filter { $0.mode == TreeEntry.gitlinkMode && head[$0.path] != $0 }.map(\.path).sorted()
  if !gitlinks.isEmpty {
    throw imageFailed("the image added or changed a gitlink: \(joined(gitlinks)). \(ruleBroken)")
  }

  var final = tree
  for entry in head.values.sorted(by: { $0.path < $1.path })
  where entry.mode == TreeEntry.gitlinkMode && captured[entry.path] != entry {
    if captured[entry.path] == nil && !captured.keys.contains(where: { $0.isInside(entry.path) }) {
      do {
        try workspace.restore(entry)
      } catch let failure as CommandFailed {
        // A file/folder conflict in the temporary index: the image's doing.
        throw imageFailed(
          "the image left something that conflicts with the submodule \(entry.path): "
            + "\(failure.stderr.trimmingCharacters(in: .whitespacesAndNewlines)). \(ruleBroken)")
      }
      captured[entry.path] = entry
      final = try workspace.writeTree()
    } else {
      throw imageFailed("the image replaced the submodule \(entry.path). \(ruleBroken)")
    }
  }
  return final
}

/// Which code a refused merge gets: the repo moved or changed while the image ran (`DIRTY_WORKTREE`), or
/// anything else (`IMAGE_FAILED`, e.g. git refusing to overwrite an ignored file).
func mergeRefusalCode(headMoved: Bool, dirty: Bool) -> ErrorCode {
  headMoved || dirty ? .DIRTY_WORKTREE : .IMAGE_FAILED
}

private func repoChanged(commit: String, stderr: String?) -> RefactorError {
  let git = stderr.map { " (git: \($0.trimmingCharacters(in: .whitespacesAndNewlines)))" } ?? ""
  return RefactorError(
    code: .DIRTY_WORKTREE,
    instructions: "The repository changed while the image ran; the commit \(commit) was not applied\(git). "
      + "Leave the repository alone while jig runs, then run again (or apply \(commit) yourself).")
}

/// Moves the branch (or detached HEAD), index and files from `parent` to `commit`. Git refuses to
/// overwrite ignored files. No hooks run (`post-merge` would be the one that does). If the repo changed
/// while the image ran, that is the caller's doing: `DIRTY_WORKTREE`. An interruption during the
/// fast-forward waits for it (`Lifecycle.mergeWindow`), so the repo is never left half-updated.
public func fastForward(_ git: Git, parent: String, commit: String) throws {
  let headNow = try git(["rev-parse", "HEAD"]).trimmingCharacters(in: .newlines)
  if mergeRefusalCode(headMoved: headNow != parent, dirty: false) == .DIRTY_WORKTREE {
    throw repoChanged(commit: commit, stderr: nil)
  }
  let merge = try Lifecycle.shared.mergeWindow(
    commit: commit, landed: { (try? git(["rev-parse", "HEAD"]))?.trimmingCharacters(in: .newlines) == commit }
  ) {
    try git.raw(["-c", "core.hooksPath=/dev/null", "merge", "--ff-only", "--no-overwrite-ignore", commit])
  }
  if !merge.succeeded {
    let dirty = !(try git(["--no-optional-locks", "status", "--porcelain"])).isEmpty
    let headMoved = (try? git(["rev-parse", "HEAD"]).trimmingCharacters(in: .newlines)) != parent
    if mergeRefusalCode(headMoved: headMoved, dirty: dirty) == .DIRTY_WORKTREE {
      throw repoChanged(commit: commit, stderr: merge.stderrText)
    }
    throw RefactorError(
      code: .IMAGE_FAILED,
      instructions: "git could not apply the commit \(commit) to the repo (\(merge.termination)): "
        + "\(merge.stderrText.trimmingCharacters(in: .whitespacesAndNewlines)). The repository is unchanged. "
        + "Move away the files git names (often ignored files where the image created tracked ones), then run "
        + "again, or apply \(commit) yourself.")
  }
}
