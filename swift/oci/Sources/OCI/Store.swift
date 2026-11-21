import Foundation
import Report

#if canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#endif

/// jig's image store, in the OCI image layout: `oci-layout`, `index.json` and
/// `blobs/sha256/<hex>`, so other tools can read it. `index.json` also remembers which digest a tag
/// pointed to last (annotation `org.opencontainers.image.ref.name` = `<registry>/<repository>:<tag>`).
///
/// Several jig processes may fill the store at once. A blob is written to `<root>/tmp/.tmp-<pid>-<random>`
/// and renamed into `blobs/` only after its digest checks out, so no one sees a half-written blob;
/// `index.json` is changed under an exclusive `flock` on `<root>/index.lock`, written to a temporary
/// file and renamed over the old one, so no change is lost and no one reads a half-written index.
public struct OCIStore: Sendable {
  let root: URL

  public init(root: URL) {
    self.root = root
  }

  /// `$XDG_CACHE_HOME/jig/oci` (an absolute XDG_CACHE_HOME only), else `$HOME/.cache/jig/oci`; nil
  /// without either.
  public static func defaultRoot(environment: [String: String]) -> URL? {
    if let xdg = environment["XDG_CACHE_HOME"], xdg.hasPrefix("/") {
      return URL(fileURLWithPath: xdg).appendingPathComponent("jig/oci")
    }
    if let home = environment["HOME"], home.hasPrefix("/") {
      return URL(fileURLWithPath: home).appendingPathComponent(".cache/jig/oci")
    }
    return nil
  }

  /// Where the blob (or manifest) `digest` is, or would be, stored.
  public func blobURL(_ digest: Digest) -> URL {
    root.appendingPathComponent("blobs/sha256").appendingPathComponent(digest.hex)
  }

  /// The store has the blob `digest`. Blobs only appear complete and checked, so being there is enough.
  public func has(_ digest: Digest) -> Bool {
    var st = stat()
    return lstat(blobURL(digest).path, &st) == 0 && (st.st_mode & S_IFMT) == S_IFREG
  }

  /// A new, empty file in `<root>/tmp/`, named `.tmp-<pid>-<random>`, to download into and then
  /// `adopt`. Leftovers of processes that are gone (an interrupted pull) are removed first.
  public func temporaryFile() throws -> URL {
    try ensureLayout()
    let tmp = root.appendingPathComponent("tmp")
    sweepStale(tmp)
    let file = tmp.appendingPathComponent(".tmp-\(getpid())-\(storeRandomSuffix())")
    let fd = open(file.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
    guard fd >= 0 else {
      throw RefactorError(
        code: .INTERNAL,
        instructions: "jig could not create a temporary file in its image store at \(file.path): "
          + "\(String(cString: strerror(errno))). Check that the folder is writable, then run again.")
    }
    close(fd)
    return file
  }

  /// Moves `file` (made by `temporaryFile`) into the store as the blob `digest`, after hashing it. When
  /// the bytes are not `digest`, `file` is deleted and nothing is stored. When the blob is already
  /// there (another process was faster), that one stays and `file` is deleted.
  public func adopt(_ file: URL, as digest: Digest) throws {
    let actual: Digest
    do {
      actual = try SHA256Hasher.digest(fileAt: file)
    } catch {
      try? FileManager.default.removeItem(at: file)
      throw RefactorError(
        code: .INTERNAL,
        instructions: "jig could not read the downloaded file \(file.path): \(error). Run again; if it "
          + "fails the same way, report it as a jig bug.")
    }
    guard actual == digest else {
      try? FileManager.default.removeItem(at: file)
      throw RefactorError(
        code: .REGISTRY_UNAVAILABLE,
        instructions: "The registry sent bytes that do not match \(digest) (they are \(actual)); nothing "
          + "was stored. Run again later; if it keeps happening, the registry or a proxy in between is "
          + "serving damaged data.")
    }
    try moveIntoBlobs(file, digest)
  }

  /// Stores `data` (a manifest) as the blob `digest`, after checking its hash; nothing is stored when
  /// it does not match.
  public func put(_ data: Data, as digest: Digest) throws {
    let actual = SHA256Hasher.digest(data)
    guard actual == digest else {
      throw RefactorError(
        code: .REGISTRY_UNAVAILABLE,
        instructions: "The registry sent a manifest that does not match \(digest) (it is \(actual)); "
          + "nothing was stored. Run again later; if it keeps happening, the registry or a proxy in "
          + "between is serving damaged data.")
    }
    if has(digest) { return }
    let file = try temporaryFile()
    do {
      try data.write(to: file)
    } catch {
      try? FileManager.default.removeItem(at: file)
      throw RefactorError(
        code: .INTERNAL,
        instructions: "jig could not write to its image store at \(file.path): \(error). Check that "
          + "the folder is writable and the disk is not full, then run again.")
    }
    try moveIntoBlobs(file, digest)
  }

  /// Remembers that `taggedName` (`<registry>/<repository>:<tag>`) pointed to `descriptor`: its entry
  /// in `index.json` is replaced, the entries of other names stay.
  public func recordTag(_ taggedName: String, _ descriptor: Descriptor) throws {
    try ensureLayout()
    var entry = descriptor
    var annotations = entry.annotations ?? [:]
    annotations["org.opencontainers.image.ref.name"] = taggedName
    entry.annotations = annotations
    try updateIndex { manifests in
      manifests.removeAll { $0.annotations?["org.opencontainers.image.ref.name"] == taggedName }
      manifests.append(entry)
    }
  }

  /// What `taggedName` pointed to when it was last recorded, or nil.
  public func lastTag(_ taggedName: String) -> Descriptor? {
    guard let data = try? Data(contentsOf: root.appendingPathComponent("index.json")),
      let index = try? JSONDecoder().decode(StoreIndex.self, from: data)
    else { return nil }
    return index.manifests.last { $0.annotations?["org.opencontainers.image.ref.name"] == taggedName }
  }

  // MARK: - Layout and index

  /// `index.json` as the OCI image layout has it.
  private struct StoreIndex: Codable {
    var schemaVersion: Int
    var mediaType: String?
    var manifests: [Descriptor]
  }

  /// The folders, `oci-layout`, and an empty `index.json` when there is none yet.
  private func ensureLayout() throws {
    for folder in [root, root.appendingPathComponent("tmp"), root.appendingPathComponent("blobs/sha256")] {
      do {
        try FileManager.default.createDirectory(
          at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      } catch {
        throw RefactorError(
          code: .INTERNAL,
          instructions: "jig could not create its image store folder \(folder.path): \(error). Check that "
            + "the folder is writable, then run again.")
      }
    }
    let layout = root.appendingPathComponent("oci-layout")
    if !FileManager.default.fileExists(atPath: layout.path) {
      let file = root.appendingPathComponent("tmp/.tmp-\(getpid())-\(storeRandomSuffix())")
      try writeAndRename(Data(#"{"imageLayoutVersion":"1.0.0"}"#.utf8), file, layout)
    }
    if !FileManager.default.fileExists(atPath: root.appendingPathComponent("index.json").path) {
      try updateIndex { _ in }
    }
  }

  /// Reads `index.json`, lets `change` change its entries, and writes it back, all under an exclusive
  /// `flock` on `<root>/index.lock`; the new file is written beside it and renamed over it.
  private func updateIndex(_ change: (inout [Descriptor]) -> Void) throws {
    let lockPath = root.appendingPathComponent("index.lock").path
    let fd = open(lockPath, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
    guard fd >= 0 else {
      throw RefactorError(
        code: .INTERNAL,
        instructions: "jig could not open the lock file of its image store at \(lockPath): "
          + "\(String(cString: strerror(errno))). Check that the folder is writable, then run again.")
    }
    defer { close(fd) }
    while flock(fd, LOCK_EX) != 0 {
      guard errno == EINTR else {
        throw RefactorError(
          code: .INTERNAL,
          instructions: "jig could not lock its image store at \(lockPath): "
            + "\(String(cString: strerror(errno))). Run again; if it fails the same way, report it as a "
            + "jig bug.")
      }
    }
    defer { flock(fd, LOCK_UN) }

    let indexURL = root.appendingPathComponent("index.json")
    var index = StoreIndex(schemaVersion: 2, mediaType: MediaType.ociIndex, manifests: [])
    // Only a missing index.json starts empty: any other failure to read it (permissions, I/O, too many
    // open files) would otherwise rewrite it with only this change and forget every other tag.
    var st = stat()
    let indexExists: Bool
    if lstat(indexURL.path, &st) == 0 {
      indexExists = true
    } else if errno == ENOENT {
      indexExists = false
    } else {
      throw RefactorError(
        code: .INTERNAL,
        instructions: "jig could not look at the index of its image store, \(indexURL.path): "
          + "\(String(cString: strerror(errno))). Check that the folder is readable, then run again.")
    }
    if indexExists {
      let data: Data
      do {
        data = try Data(contentsOf: indexURL)
      } catch {
        throw RefactorError(
          code: .INTERNAL,
          instructions: "jig could not read the index of its image store, \(indexURL.path): \(error). "
            + "Check that the file is readable, then run again.")
      }
      do {
        index = try JSONDecoder().decode(StoreIndex.self, from: data)
      } catch {
        throw RefactorError(
          code: .INTERNAL,
          instructions: "The index of jig's image store, \(indexURL.path), cannot be read: \(error). "
            + "Delete the folder \(root.path) (it is a download cache) and run again.")
      }
    }
    change(&index.manifests)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let data = try encoder.encode(index)
    let file = root.appendingPathComponent("tmp/.tmp-\(getpid())-\(storeRandomSuffix())")
    try writeAndRename(data, file, indexURL)
  }

  /// Writes `data` to the temporary `file` and renames it to `final`.
  private func writeAndRename(_ data: Data, _ file: URL, _ final: URL) throws {
    do {
      try data.write(to: file)
    } catch {
      try? FileManager.default.removeItem(at: file)
      throw RefactorError(
        code: .INTERNAL,
        instructions: "jig could not write to its image store at \(file.path): \(error). Check that "
          + "the folder is writable and the disk is not full, then run again.")
    }
    guard rename(file.path, final.path) == 0 else {
      let err = errno
      try? FileManager.default.removeItem(at: file)
      throw RefactorError(
        code: .INTERNAL,
        instructions: "jig could not move \(file.path) to \(final.path): \(String(cString: strerror(err))). "
          + "Check that the folder is writable, then run again.")
    }
  }

  /// Renames the checked `file` to the blob `digest`. A blob already there stays (its bytes are the
  /// same); a race between two renames of the same bytes is harmless, as `rename` is atomic.
  private func moveIntoBlobs(_ file: URL, _ digest: Digest) throws {
    if has(digest) {
      try? FileManager.default.removeItem(at: file)
      return
    }
    let final = blobURL(digest)
    do {
      try FileManager.default.createDirectory(
        at: final.deletingLastPathComponent(), withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700])
    } catch {
      try? FileManager.default.removeItem(at: file)
      throw RefactorError(
        code: .INTERNAL,
        instructions: "jig could not create its image store folder \(final.deletingLastPathComponent().path): "
          + "\(error). Check that the folder is writable, then run again.")
    }
    guard rename(file.path, final.path) == 0 else {
      let err = errno
      try? FileManager.default.removeItem(at: file)
      throw RefactorError(
        code: .INTERNAL,
        instructions: "jig could not move \(file.path) into its image store at \(final.path): "
          + "\(String(cString: strerror(err))). Check that the folder is writable, then run again.")
    }
  }

  /// Removes `.tmp-<pid>-*` files in `tmp` whose process is gone and that were last written over an
  /// hour ago. The age matters: a jig in another PID namespace (a container sharing the cache) has a
  /// pid this process cannot see, so a missing pid alone does not mean its download is dead.
  private func sweepStale(_ tmp: URL) {
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: tmp.path) else { return }
    for name in names where name.hasPrefix(".tmp-") {
      let parts = name.split(separator: "-")
      guard parts.count >= 3, let pid = pid_t(parts[1]), kill(pid, 0) != 0, errno == ESRCH else { continue }
      let file = tmp.appendingPathComponent(name)
      var st = stat()
      guard lstat(file.path, &st) == 0 else { continue }
      guard time(nil) - st.st_mtim.tv_sec > 3600 else { continue }
      try? FileManager.default.removeItem(at: file)
    }
  }
}

private func storeRandomSuffix() -> String {
  String(UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "").prefix(12))
}
