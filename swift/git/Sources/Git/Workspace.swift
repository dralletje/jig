import ChildProcess
import Foundation
import Report

#if canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#endif

/// What a `.gitattributes` entry in the folder is, to tell whether the image changed it.
public enum AttributesEntry: Equatable, Sendable {
  case file(Data, executable: Bool)
  case symlink([UInt8])
  case directory
  case other(UInt32)
}

/// What a walk of the folder found: `.git` entries, and every `.gitattributes` entry with its content.
public struct FolderScan: Sendable {
  public var dotGit: [GitPath] = []
  public var attributes: [GitPath: AttributesEntry] = [:]
}

private func imageFailed(_ instructions: String) -> RefactorError {
  RefactorError(code: .IMAGE_FAILED, instructions: instructions)
}

private func errnoText() -> String { String(cString: strerror(errno)) }

private let fileTypeMask: UInt32 = 0o170000
private let directoryType: UInt32 = 0o040000
private let regularType: UInt32 = 0o100000
private let symlinkType: UInt32 = 0o120000

/// The `.gitattributes` paths whose entry differs between two scans (added, removed or changed).
func changedAttributes(before: [GitPath: AttributesEntry], after: [GitPath: AttributesEntry]) -> [GitPath] {
  Set(before.keys).union(after.keys).filter { before[$0] != after[$0] }.sorted()
}

/// The folder the image works in, and the temporary index that ties it to the repo, both in one
/// temporary folder. The export is a checkout of one commit through that index (never `git archive`, so
/// `.gitattributes` `export-ignore` and `export-subst` do not apply); the capture is `git add -A` into
/// the same index with the export as the work tree. The repo's own index and work tree are never touched.
public final class Workspace: @unchecked Sendable {
  /// The temporary folder holding both.
  public let root: URL
  /// The folder mounted as `/workspace`.
  public let dir: URL
  private let indexDir: URL
  private let gitDir: String
  private let repo: Git
  private let removal = NSLock()
  private var removed = false

  /// Picks the temporary folders' paths; `create()` makes them and `remove()` deletes them. Register the
  /// removal (with the interruption's cleanups) before `create()`, so no moment exists in which the
  /// folders are there and nobody would remove them.
  public init(repo: Git) throws {
    self.repo = repo
    gitDir = try repo(["rev-parse", "--absolute-git-dir"]).trimmingCharacters(in: .newlines)
    root = FileManager.default.temporaryDirectory.appendingPathComponent("jig-\(UUID().uuidString)")
    dir = root.appendingPathComponent("workspace")
    indexDir = root.appendingPathComponent("index")
  }

  /// Creates the temporary folders. Fails once `remove()` succeeded: what is removed stays removed.
  public func create() throws {
    removal.lock()
    defer { removal.unlock() }
    guard !removed else {
      throw RefactorError(code: .INTERNAL, instructions: "the temporary folder \(root.path) was already removed")
    }
    let attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o700]
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: attributes)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: false, attributes: attributes)
    try FileManager.default.createDirectory(at: indexDir, withIntermediateDirectories: false, attributes: attributes)
  }

  private var index: String { indexDir.appendingPathComponent("index").path }

  /// Git on the temporary index. Settings that would write next to the repo's own index, or ask a
  /// monitor about the wrong work tree, are off.
  private func gitRunner(workTree: Bool) -> Git {
    var environment = ["GIT_INDEX_FILE": index, "GIT_DIR": gitDir]
    if workTree { environment["GIT_WORK_TREE"] = dir.path }
    return Git(cwd: workTree ? dir : repo.cwd, environment: environment)
  }

  private let settings = ["-c", "core.fsmonitor=false", "-c", "core.splitIndex=false", "-c", "core.untrackedCache=false"]

  @discardableResult
  private func git(_ args: [String], workTree: Bool = true) throws -> String {
    try gitRunner(workTree: workTree)(settings + args)
  }

  /// Fills the folder with the files of `commit` and nothing else: no `.git`, nothing untracked.
  public func export(commit: String) throws {
    try git(["read-tree", commit], workTree: false)
    try git(["checkout-index", "-a", "-f", "--prefix=\(dir.path)/"], workTree: false)
  }

  /// Stages the folder as it is now into the temporary index (still equal to the exported commit) and
  /// returns the tree. Git applies the ignore rules (the folder's `.gitignore` files,
  /// `.git/info/exclude`, `core.excludesFile`), so new ignored files are left out.
  public func capture() throws -> String {
    do {
      try git(["add", "-A"])
    } catch let failed as CommandFailed {
      throw imageFailed(
        "git could not add what the image left (\(failed.termination)): "
          + "\(failed.stderr.trimmingCharacters(in: .whitespacesAndNewlines)). Nothing was committed; report the "
          + "image as broken (it left files git cannot stage).")
    }
    return try writeTree()
  }

  public func writeTree() throws -> String {
    try git(["write-tree"]).trimmingCharacters(in: .newlines)
  }

  /// Puts a gitlink back into the temporary index (the image removed its empty folder).
  public func restore(_ entry: TreeEntry) throws {
    guard let path = entry.path.utf8 else { throw NonUTF8Path(path: entry.path) }
    try git(["update-index", "--add", "--cacheinfo", "\(entry.mode),\(entry.object),\(path)"])
  }

  /// Ignored `.gitignore` files that git still reads: those in folders that are not ignored themselves.
  /// `--directory` lists an ignored folder once, so `.gitignore` files inside it (which git never reads)
  /// do not show up.
  public func ignoredGitignores() throws -> [GitPath] {
    let out = try gitRunner(workTree: true).data(
      settings + ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"])
    return nulSeparated(out).map { GitPath(bytes: $0) }.filter { $0.isNamed(".gitignore") }
  }

  /// Walks the whole folder (symlinks are never followed) by raw names: every entry named `.git`, and
  /// every `.gitattributes` entry with its content. A name that is not valid UTF-8, or an entry it
  /// cannot inspect (it might be a folder holding a `.git`), is `IMAGE_FAILED` rather than skipped.
  public func scan() throws -> FolderScan {
    var result = FolderScan()
    let top = open(dir.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard top >= 0 else { throw imageFailed("could not read what the image left in .: \(errnoText()). \(unreadable)") }
    try walk(top, rel: [], into: &result)
    result.dotGit.sort()
    return result
  }

  private let unreadable =
    "Nothing was committed; the image must leave files and folders the host can read. Report the image as broken."

  /// Walks the folder open as `fd` (closed when done); `rel` is its path in the folder.
  private func walk(_ fd: Int32, rel: [UInt8], into result: inout FolderScan) throws {
    guard let stream = fdopendir(fd) else {
      close(fd)
      throw imageFailed("could not read what the image left in \(GitPath(bytes: rel)): \(errnoText()). \(unreadable)")
    }
    defer { closedir(stream) }
    let where_ = rel.isEmpty ? "." : GitPath(bytes: rel).description
    while true {
      errno = 0
      guard let entry = readdir(stream) else {
        if errno != 0 {
          throw imageFailed("could not read what the image left in \(where_): \(errnoText()). \(unreadable)")
        }
        return
      }
      let name: [UInt8] = withUnsafeBytes(of: entry.pointee.d_name) { Array($0.prefix(while: { $0 != 0 })) }
      if name == [0x2e] || name == [0x2e, 0x2e] { continue }
      let path = GitPath(bytes: rel.isEmpty ? name : rel + [0x2f] + name)
      guard path.utf8 != nil else {
        throw imageFailed(
          "the image created a path that is not valid UTF-8: \(path) (bytes that are not UTF-8 shown as \\xNN). "
            + "Nothing was committed; jig only handles UTF-8 paths. Report the image as broken.")
      }
      if name == Array(".git".utf8) {
        result.dotGit.append(path)
        continue
      }
      var info = stat()
      let statted = name.withUnsafeBufferPointer { buffer -> Int32 in
        let cName = buffer.map { CChar(bitPattern: $0) } + [0]
        return fstatat(dirfd(stream), cName, &info, AT_SYMLINK_NOFOLLOW)
      }
      guard statted == 0 else {
        throw imageFailed("could not read what the image left at \(path): \(errnoText()). \(unreadable)")
      }
      let type = UInt32(info.st_mode) & fileTypeMask
      let cName = name.map { CChar(bitPattern: $0) } + [0]
      if name == Array(".gitattributes".utf8) {
        result.attributes[path] = try attributesEntry(dirfd(stream), cName, type: type, mode: UInt32(info.st_mode), path)
      }
      if type == directoryType {
        let child = openat(dirfd(stream), cName, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard child >= 0 else {
          throw imageFailed("could not read what the image left in \(path): \(errnoText()). \(unreadable)")
        }
        try walk(child, rel: path.bytes, into: &result)
      }
    }
  }

  private func attributesEntry(_ parent: Int32, _ cName: [CChar], type: UInt32, mode: UInt32, _ path: GitPath) throws
    -> AttributesEntry
  {
    switch type {
    case directoryType: return .directory
    case symlinkType:
      var buffer = [CChar](repeating: 0, count: 4096)
      let n = readlinkat(parent, cName, &buffer, buffer.count)
      guard n >= 0 else { throw imageFailed("could not read what the image left at \(path): \(errnoText()). \(unreadable)") }
      return .symlink(buffer[0..<n].map { UInt8(bitPattern: $0) })
    case regularType:
      let fd = openat(parent, cName, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
      guard fd >= 0 else { throw imageFailed("could not read what the image left at \(path): \(errnoText()). \(unreadable)") }
      defer { close(fd) }
      var data = Data()
      var buffer = [UInt8](repeating: 0, count: 65536)
      while true {
        let n = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
        if n > 0 {
          data.append(contentsOf: buffer[0..<n])
        } else if n < 0 && errno == EINTR {
          continue
        } else if n < 0 {
          throw imageFailed("could not read what the image left at \(path): \(errnoText()). \(unreadable)")
        } else {
          break
        }
      }
      return .file(data, executable: mode & 0o111 != 0)
    default: return .other(type)
    }
  }

  /// Deletes the temporary folders (the run and an interruption may both ask); true when they are gone.
  /// Only a removal that succeeded counts: after a failure (something still writing into the folder,
  /// say) the next call tries again. A failure is one line on stderr, never an error: the commit may
  /// already have landed.
  @discardableResult
  public func remove() -> Bool {
    removal.lock()
    defer { removal.unlock() }
    guard !removed else { return true }
    let exportRemoved = Workspace.remove(dir)
    let indexRemoved = Workspace.remove(indexDir)
    removed = exportRemoved && indexRemoved && Workspace.remove(root)
    return removed
  }

  /// The temporary folder's path until a `remove()` succeeded (after a failed one: what is left); nil
  /// once it is gone.
  public var leftover: String? {
    removal.lock()
    defer { removal.unlock() }
    return removed ? nil : root.path
  }

  /// Removes `url`; true when it is gone (also when it never existed).
  private static func remove(_ url: URL) -> Bool {
    var info = stat()
    if lstat(url.path, &info) != 0 && errno == ENOENT { return true }
    do {
      try FileManager.default.removeItem(at: url)
      return true
    } catch {
      let reason = String(describing: error).split(whereSeparator: \.isNewline).joined(separator: " ")
      FileHandle.standardError.write(Data("jig: could not remove \(url.path): \(reason)\n".utf8))
      return false
    }
  }
}
