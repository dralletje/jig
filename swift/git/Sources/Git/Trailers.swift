import ChildProcess
import Foundation

/// A commit's parents, subject and the trailers of its message.
public struct CommitTrailers: Equatable, Sendable {
  public var parents: [String]
  public var subject: String
  /// Key as written → value (unfolded). A key given more than once: its last value.
  public var trailers: [String: String]

  public init(parents: [String], subject: String, trailers: [String: String]) {
    self.parents = parents
    self.subject = subject
    self.trailers = trailers
  }
}

/// Reads `commit`'s parents, subject and trailers. The trailers are git's own parse
/// (`%(trailers:only,unfold)`): only the message's last paragraph, and only when it is a trailer block, so
/// a trailer block followed by a hand-added paragraph gives no trailers rather than a guess.
public func readCommitTrailers(_ git: Git, _ commit: String) throws -> CommitTrailers {
  // NUL between fields and between trailers, \u{1} between a trailer's key and value: neither occurs in
  // a hash, a subject or an unfolded trailer.
  let format = "--format=%P%x00%s%x00%(trailers:only,unfold,separator=%x00,key_value_separator=%x01)"
  let text = try git([
    "--no-replace-objects", "-c", "trailer.separators=:", "log", "-1", "--no-show-signature", "--encoding=UTF-8", format,
    "--end-of-options", commit, "--",
  ])
  var fields = text.split(separator: "\0", omittingEmptySubsequences: false).map(String.init)
  // The output ends in a newline (after the last trailer, or after the subject when there are none).
  if let last = fields.indices.last, fields[last].hasSuffix("\n") { fields[last].removeLast() }
  guard fields.count >= 2 else {
    throw CommandFailed(command: ["git", "log", format, commit], termination: .exited(0), stderr: "unexpected output: \(text)")
  }
  var trailers: [String: String] = [:]
  for entry in fields.dropFirst(2) where !entry.isEmpty {
    guard let separator = entry.firstIndex(of: "\u{1}") else { continue }
    trailers[String(entry[..<separator])] = String(entry[entry.index(after: separator)...])
  }
  return CommitTrailers(
    parents: fields[0].split(separator: " ").map(String.init), subject: fields[1], trailers: trailers)
}
