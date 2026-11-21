import ChildProcess
import Foundation
import Testing

@testable import Git

/// A throwaway, empty git repo.
private func emptyRepo() throws -> Git {
  let dir = FileManager.default.temporaryDirectory.appendingPathComponent("trailer-tests-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: false)
  let git = Git(cwd: dir)
  try git(["init", "-q", "-b", "main"])
  return git
}

/// Commits `message` (no file changes) on top of `parents`, or as a root commit; returns its hash.
private func commit(_ git: Git, _ message: String, parents: [String] = []) throws -> String {
  let tree = try git(["mktree"], stdin: Data()).trimmingCharacters(in: .whitespacesAndNewlines)
  let args = ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit-tree", tree]
    + parents.flatMap { ["-p", $0] }
  return try git(args, stdin: Data(message.utf8)).trimmingCharacters(in: .whitespacesAndNewlines)
}

private let command = #"{"args":["rename","--to","b c"],"image":"probe@sha256:abc"}"#

private let refactorMessage = """
  refactor(x): rename a to b

  Renamed it.

  Refactor-Command: \(command)
  Refactor-Kind: refactor
  Refactor-Status: complete
  Refactor-Effect: sha256:00
  Co-Authored-By: jig <bot@example.com>

  """

@Test func readsTrailersFromLastBlock() throws {
  let git = try emptyRepo()
  defer { try? FileManager.default.removeItem(at: git.cwd) }
  let root = try commit(git, "init\n")
  let message = """
    refactor(x): rename a to b

    Not-A-Trailer-Here: this paragraph is the body, not the last block

    Refactor-Command: \(command)
    Refactor-Kind: sweep
    Refactor-Kind: refactor
    Refactor-Status: complete
    Refactor-Effect: sha256:00
    Co-Authored-By: jig <bot@example.com>

    """
  let hash = try commit(git, message, parents: [root])
  let read = try readCommitTrailers(git, hash)
  #expect(read.parents == [root])
  #expect(read.subject == "refactor(x): rename a to b")
  #expect(read.trailers == [
    "Refactor-Command": command,
    "Refactor-Kind": "refactor",  // repeated: the last one
    "Refactor-Status": "complete",
    "Refactor-Effect": "sha256:00",
    "Co-Authored-By": "jig <bot@example.com>",
  ])
}

@Test func trailersAfterAmendedParagraphAreNotGuessed() throws {
  let git = try emptyRepo()
  defer { try? FileManager.default.removeItem(at: git.cwd) }
  let root = try commit(git, "init\n")
  let hash = try commit(git, refactorMessage + "\nEdited by hand afterwards, in a paragraph of its own.\n", parents: [root])
  let read = try readCommitTrailers(git, hash)
  #expect(read.trailers["Refactor-Command"] == nil)
  #expect(read.trailers == [:])
}

@Test func rootCommitHasNoParents() throws {
  let git = try emptyRepo()
  defer { try? FileManager.default.removeItem(at: git.cwd) }
  let hash = try commit(git, refactorMessage)
  let read = try readCommitTrailers(git, hash)
  #expect(read.parents == [])
  #expect(read.trailers["Refactor-Command"] == command)
}

@Test func mergeHasTwoParents() throws {
  let git = try emptyRepo()
  defer { try? FileManager.default.removeItem(at: git.cwd) }
  let a = try commit(git, "a\n")
  let b = try commit(git, "b\n")
  let merge = try commit(git, refactorMessage, parents: [a, b])
  let read = try readCommitTrailers(git, merge)
  #expect(read.parents == [a, b])
  #expect(read.subject == "refactor(x): rename a to b")
}

@Test func replaceRefsAreIgnored() throws {
  let git = try emptyRepo()
  defer { try? FileManager.default.removeItem(at: git.cwd) }
  let root = try commit(git, "init\n")
  let real = try commit(git, refactorMessage, parents: [root])
  let other = try commit(git, "hand-written\n\nRefactor-Command: {}\n", parents: [])
  try git(["replace", real, other])
  let read = try readCommitTrailers(git, real)
  #expect(read.parents == [root])
  #expect(read.subject == "refactor(x): rename a to b")
  #expect(read.trailers["Refactor-Command"] == command)
}

@Test func anUnknownCommitThrows() throws {
  let git = try emptyRepo()
  defer { try? FileManager.default.removeItem(at: git.cwd) }
  _ = try commit(git, "init\n")
  #expect(throws: (any Error).self) { try readCommitTrailers(git, "0000000000000000000000000000000000000000") }
  #expect(throws: (any Error).self) { try readCommitTrailers(git, "--all") }
}
