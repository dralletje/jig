import ChildProcess
import Foundation
import Testing

@testable import Git

/// A throwaway git repo with one commit.
private func makeRepo() throws -> URL {
  let dir = FileManager.default.temporaryDirectory.appendingPathComponent("git-tests-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: false)
  for args in [
    ["init", "-q", "-b", "main"], ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q",
      "--allow-empty", "-m", "init"],
  ] {
    let run = try runProcess("git", args, cwd: dir)
    guard run.succeeded else { throw CommandFailed(command: ["git"] + args, termination: run.termination, stderr: run.stderrText) }
  }
  return dir
}

@Test func aRemovalThatFailedIsTriedAgainAndOnlyThenCountsAsDone() throws {
  let repo = try makeRepo()
  defer { try? FileManager.default.removeItem(at: repo) }
  let workspace = try Workspace(repo: Git(cwd: repo))
  try workspace.create()
  // A folder the removal cannot empty (no write bit), like one an image is still writing into.
  let stuck = workspace.dir.appendingPathComponent("ro")
  try FileManager.default.createDirectory(at: stuck, withIntermediateDirectories: false)
  try Data("x".utf8).write(to: stuck.appendingPathComponent("x"))
  try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: stuck.path)
  defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: stuck.path) }

  #expect(workspace.remove() == false)
  #expect(FileManager.default.fileExists(atPath: workspace.root.path))
  #expect(workspace.leftover == workspace.root.path)

  try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: stuck.path)
  #expect(workspace.remove() == true)
  #expect(!FileManager.default.fileExists(atPath: workspace.root.path))
  #expect(workspace.leftover == nil)
  #expect(workspace.remove() == true)  // once done, done
}

@Test func aWorkspaceIsRemovableBeforeItsFoldersExist() throws {
  let repo = try makeRepo()
  defer { try? FileManager.default.removeItem(at: repo) }
  // The folders are made by `create()`, after the removal is registered: removing first is fine, and
  // a removal that ran first means `create()` makes nothing.
  let workspace = try Workspace(repo: Git(cwd: repo))
  #expect(!FileManager.default.fileExists(atPath: workspace.root.path))
  #expect(workspace.remove() == true)
  #expect(throws: (any Error).self) { try workspace.create() }
  #expect(!FileManager.default.fileExists(atPath: workspace.root.path))
}

@Test func gitNeverTakesOptionalLocks() {
  let env = gitEnvironment(base: ["PATH": "/bin", "GIT_OPTIONAL_LOCKS": "1"], explicit: [:])
  #expect(env == ["PATH": "/bin", "GIT_OPTIONAL_LOCKS": "0"])
}
