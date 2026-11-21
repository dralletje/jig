import ChildProcess
import Foundation
import Report

/// A path as git stores it: exact bytes. Equal, hashed and ordered by its bytes (the order git uses),
/// never by Unicode equivalence, so `é` and `e` + U+0301 are two paths.
public struct GitPath: Hashable, Comparable, Sendable, CustomStringConvertible {
  public let bytes: [UInt8]

  public init(bytes: [UInt8]) { self.bytes = bytes }
  public init(_ text: String) { bytes = Array(text.utf8) }

  /// The path as text, or nil when it is not valid UTF-8.
  public var utf8: String? { String(validating: bytes, as: UTF8.self) }

  /// The path as text; bytes that are not valid UTF-8 shown as `\xNN` (for messages only).
  public var description: String {
    if let text = utf8 { return text }
    return bytes.map { byte in
      (0x20..<0x7f).contains(byte) && byte != 0x5c ? String(UnicodeScalar(byte)) : String(format: "\\x%02x", byte)
    }.joined()
  }

  /// The last `/`-separated component.
  public var lastComponent: ArraySlice<UInt8> {
    guard let slash = bytes.lastIndex(of: 0x2f) else { return bytes[...] }
    return bytes[(slash + 1)...]
  }

  public func isNamed(_ name: String) -> Bool { Array(lastComponent) == Array(name.utf8) }

  /// Whether `self` is inside the folder `folder`.
  public func isInside(_ folder: GitPath) -> Bool {
    bytes.count > folder.bytes.count && bytes.starts(with: folder.bytes) && bytes[folder.bytes.count] == 0x2f
  }

  public static func < (a: GitPath, b: GitPath) -> Bool { a.bytes.lexicographicallyPrecedes(b.bytes) }
}

/// A path that is not valid UTF-8: refused, never decoded lossily.
public struct NonUTF8Path: Error, RefactorErrorConvertible {
  public var path: GitPath

  public init(path: GitPath) { self.path = path }

  public var refactorError: RefactorError { repoPathNotUTF8(path) }
}

/// The environment for git: ours without any `GIT_*` variable (a caller's `GIT_DIR`, `GIT_INDEX_FILE`,
/// `GIT_OBJECT_DIRECTORY`, `GIT_CONFIG_PARAMETERS`, ... cannot point git somewhere else or change its
/// config), plus `GIT_OPTIONAL_LOCKS=0` and `explicit`. No optional locks: a `git status` stopped part
/// way (SIGKILL after an interruption's grace) must never leave `.git/index.lock` in the user's repo, and
/// nothing here needs the index's stat cache written back.
func gitEnvironment(base: [String: String], explicit: [String: String]) -> [String: String] {
  var env = base.filter { !$0.key.hasPrefix("GIT_") }
  env["GIT_OPTIONAL_LOCKS"] = "0"
  for (key, value) in explicit { env[key] = value }
  return env
}

/// Git in one repo, with a cleaned environment (`gitEnvironment`); `environment` sets what is needed.
public struct Git: Sendable {
  public var cwd: URL
  public var environment: [String: String]

  public init(cwd: URL, environment: [String: String] = [:]) {
    self.cwd = cwd
    self.environment = environment
  }

  /// Runs `git <args>`, however it ends.
  public func raw(_ args: [String], stdin: Data? = nil) throws -> ProcessOutput {
    try runProcess(
      "git", args, cwd: cwd,
      environment: gitEnvironment(base: ProcessInfo.processInfo.environment, explicit: environment), stdin: stdin)
  }

  /// Runs `git <args>` and returns its stdout as bytes; a failure throws `CommandFailed`.
  public func data(_ args: [String], stdin: Data? = nil) throws -> Data {
    let run = try raw(args, stdin: stdin)
    guard run.succeeded else {
      throw CommandFailed(command: ["git"] + args, termination: run.termination, stderr: run.stderrText)
    }
    return run.stdout
  }

  /// Runs `git <args>` and returns its stdout as text (hashes, refs: never paths); a failure throws
  /// `CommandFailed`.
  @discardableResult
  public func callAsFunction(_ args: [String], stdin: Data? = nil) throws -> String {
    String(decoding: try data(args, stdin: stdin), as: UTF8.self)
  }
}

/// Splits `-z` output into its records, as bytes.
public func nulSeparated(_ data: Data) -> [[UInt8]] {
  data.split(separator: 0, omittingEmptySubsequences: true).map(Array.init)
}

/// Splits `-z` output into paths; the first one that is not valid UTF-8 throws `NonUTF8Path`.
public func nulSeparatedPaths(_ data: Data) throws -> [GitPath] {
  try nulSeparated(data).map { record in
    let path = GitPath(bytes: record)
    guard path.utf8 != nil else { throw NonUTF8Path(path: path) }
    return path
  }
}

/// One entry of `git ls-tree -r -z`: `<mode> SP <type> SP <object> TAB <path>`.
public struct TreeEntry: Equatable, Sendable {
  public var mode: String
  public var type: String
  public var object: String
  public var path: GitPath

  public static let gitlinkMode = "160000"

  /// Nil for a record that is not an ls-tree entry. The path is kept as bytes, valid UTF-8 or not.
  public init?(lsTreeRecord record: [UInt8]) {
    guard let tab = record.firstIndex(of: 0x09),
      let header = String(validating: record[..<tab], as: UTF8.self)
    else { return nil }
    let fields = header.split(separator: " ")
    guard fields.count == 3 else { return nil }
    mode = String(fields[0])
    type = String(fields[1])
    object = String(fields[2])
    path = GitPath(bytes: Array(record[(tab + 1)...]))
  }

  init?(lsTreeRecord record: String) { self.init(lsTreeRecord: Array(record.utf8)) }
}

/// Every entry of `tree`, recursively (gitlinks are entries, not descended into), by exact path. A path
/// that is not valid UTF-8 throws `NonUTF8Path`.
public func lsTree(_ git: Git, _ tree: String) throws -> [GitPath: TreeEntry] {
  var entries: [GitPath: TreeEntry] = [:]
  for record in nulSeparated(try git.data(["ls-tree", "-r", "-z", "--full-tree", tree])) {
    guard let entry = TreeEntry(lsTreeRecord: record) else {
      throw CommandFailed(
        command: ["git", "ls-tree"], termination: .exited(0),
        stderr: "unexpected output: \(GitPath(bytes: record))")
    }
    guard entry.path.utf8 != nil else { throw NonUTF8Path(path: entry.path) }
    entries[entry.path] = entry
  }
  return entries
}

/// The refusal for a path already in the repo that is not valid UTF-8.
public func repoPathNotUTF8(_ path: GitPath) -> RefactorError {
  RefactorError(
    code: .DIRTY_WORKTREE,
    instructions: "The repository has a path that is not valid UTF-8: \(path) (bytes that are not UTF-8 shown as "
      + "\\xNN). jig only handles UTF-8 paths; rename it to a UTF-8 name (git mv) and commit, then "
      + "run again.")
}

/// Refuses a dirty tree, including edits that `git status` hides: assume-unchanged entries (a lowercase
/// tag in `git ls-files -v`) and skip-worktree entries (`S`). Also refuses a path that is not valid UTF-8.
public func assertClean(_ git: Git) throws {
  // Quoted paths: the list is shown as text, and must not depend on the user's core.quotePath.
  let dirty = try git(["--no-optional-locks", "-c", "core.quotePath=true", "status", "--porcelain"]).split(separator: "\n").map(String.init)
  if !dirty.isEmpty {
    throw RefactorError(
      code: .DIRTY_WORKTREE,
      instructions: "The working tree has uncommitted changes:\n\(dirty.joined(separator: "\n"))\n"
        + "Commit or stash them, then run again.")
  }
  var hidden: [GitPath] = []
  for record in nulSeparated(try git.data(["ls-files", "-v", "-z"])) {
    guard record.count > 2, record[1] == 0x20 else { continue }
    let path = GitPath(bytes: Array(record[2...]))
    guard path.utf8 != nil else { throw repoPathNotUTF8(path) }
    let tag = record[0]
    if (0x61...0x7a).contains(tag) || tag == 0x53 { hidden.append(path) }
  }
  if !hidden.isEmpty {
    throw RefactorError(
      code: .DIRTY_WORKTREE,
      instructions: "These files are hidden from git status (assume-unchanged or skip-worktree):\n"
        + "\(hidden.map(\.description).joined(separator: "\n"))\n"
        + "Clear the flag (git update-index --no-assume-unchanged / --no-skip-worktree), commit or drop "
        + "their changes, then run again.")
  }
}

/// Sorts paths by their UTF-8 bytes, the order git itself uses.
func sortedPaths(_ paths: [String]) -> [String] {
  paths.sorted { Array($0.utf8).lexicographicallyPrecedes(Array($1.utf8)) }
}
