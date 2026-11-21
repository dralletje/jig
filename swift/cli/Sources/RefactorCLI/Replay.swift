import ChildProcess
import Foundation
import Git
import Report
import Sandbox

/// What a replay captured: the tree the image left, and what it reported.
public struct Replayed: Sendable {
  public var tree: String
  public var report: Report
}

/// Exports `base` through a temporary index, runs `pinned` with `args` in `sandbox`, parses the report,
/// runs checkLeftovers/checkCapture against `base`'s tree and returns the captured tree. Registers and
/// removes its temp folder exactly as runImage did (Lifecycle cleanup + unlessInterrupted defer).
public func replay(git: Git, base: String, pinned: PinnedImage, args: [String], sandbox: any Sandbox) throws -> Replayed {
  // 1. Export `base` through a temporary index.
  let head: [GitPath: TreeEntry]
  do {
    head = try lsTree(git, base)
  } catch let bad as NonUTF8Path {
    throw repoPathNotUTF8(bad.path)
  }
  // The removal is registered before the folders exist, and they are made while no interruption is
  // handled, so a signal at any moment leaves nothing behind.
  let workspace = try Workspace(repo: git)
  Lifecycle.shared.addCleanup(reporting: {
    workspace.remove()
    return workspace.leftover.map { ["the temporary folder \($0) (remove it: rm -rf '\($0)')"] } ?? []
  })
  try Lifecycle.shared.gated { try workspace.create() }
  // Remove the temp folder and index, whatever happens; once an interruption started, its cleanup owns
  // that (after the sandbox's: the image may still be writing into the folder until then).
  defer { Lifecycle.shared.unlessInterrupted { workspace.remove() } }
  try workspace.export(commit: base)
  let attributesBefore = try workspace.scan().attributes

  // 2. Run the image in the sandbox and read its report.
  let ran = try sandbox.run(pinned, arguments: args, workspace: workspace.dir)
  let report: Report
  switch ImageReport.parse(
    stdout: String(decoding: ran.stdout, as: UTF8.self), stderr: String(decoding: ran.stderr, as: UTF8.self),
    termination: ran.termination)
  {
  case .ok(let reported): report = reported
  case .failed(let error): throw error
  }

  // 3–4. Before git reads the export: no `.git` entries and no `.gitattributes` change. Then capture
  // the result with git and check it.
  try checkLeftovers(try workspace.scan(), attributesBefore: attributesBefore)
  let tree = try checkCapture(workspace, git: git, head: head, tree: try workspace.capture())
  return Replayed(tree: tree, report: report)
}
