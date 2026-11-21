import Foundation
import Report

#if canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#endif

/// One usable cache entry: the image's files as a plain folder, and its configuration.
struct CacheEntry: Equatable, Sendable {
  var directory: URL
  var rootfs: URL
  var config: ImageConfig
}

/// The image folder cache: `<root>/<hex of the image id>/` holds `rootfs/` (the files of
/// `docker export` for a local image, the unpacked layers for a registry image, keyed by its platform
/// manifest digest), `config.json` and `marker`. An entry is built in `<root>/.tmp-<pid>-<random>/`
/// and renamed into place only when complete, the marker written last; an entry whose marker, config
/// or folders do not check out is moved aside and rebuilt.
struct RootfsCache: Sendable {
  static let markerName = "marker"
  static let configName = "config.json"
  static let rootfsName = "rootfs"
  static let formatLine = "jig rootfs v1"
  /// Folders the sandbox mounts over: they must be real, empty-or-not directories in the image folder.
  static let mountPoints = ["proc", "tmp", "dev", "workspace"]

  var root: URL
  /// Told about the build folder, so an interruption removes it.
  var registry: RunRegistry? = nil

  /// `$XDG_CACHE_HOME/jig/rootfs` (an absolute XDG_CACHE_HOME only, as the spec says),
  /// else `$HOME/.cache/jig/rootfs`; nil without either.
  static func defaultRoot(environment: [String: String]) -> URL? {
    if let xdg = environment["XDG_CACHE_HOME"], xdg.hasPrefix("/") {
      return URL(fileURLWithPath: xdg).appendingPathComponent("jig/rootfs")
    }
    if let home = environment["HOME"], home.hasPrefix("/") {
      return URL(fileURLWithPath: home).appendingPathComponent(".cache/jig/rootfs")
    }
    return nil
  }

  static func markerContent(imageID: String) -> String { "\(formatLine)\n\(imageID)\n" }

  func entryURL(imageID: String) -> URL {
    precondition(isImageID(imageID))
    return root.appendingPathComponent(String(imageID.dropFirst("sha256:".count)))
  }

  /// The entry for `imageID` when it exists and checks out, else nil.
  func load(imageID: String) -> CacheEntry? {
    guard isImageID(imageID) else { return nil }
    return Self.check(entryURL(imageID: imageID), imageID: imageID)
  }

  static func check(_ dir: URL, imageID: String) -> CacheEntry? {
    guard isRealDirectory(dir.path),
      let marker = try? Data(contentsOf: dir.appendingPathComponent(markerName)),
      String(decoding: marker, as: UTF8.self) == markerContent(imageID: imageID),
      let configData = try? Data(contentsOf: dir.appendingPathComponent(configName)),
      let config = try? JSONDecoder().decode(ImageConfig.self, from: configData)
    else { return nil }
    let rootfs = dir.appendingPathComponent(rootfsName)
    guard isRealDirectory(rootfs.path) else { return nil }
    for point in mountPoints where !isRealDirectory(rootfs.appendingPathComponent(point).path) { return nil }
    return CacheEntry(directory: dir, rootfs: rootfs, config: config)
  }

  /// The entry for `imageID`, built with `build` when it is missing or damaged. `build` fills the
  /// given `rootfs` folder (and may use `scratch` for temporary files) and returns the configuration.
  func ensure(imageID: String, build: (_ rootfs: URL, _ scratch: URL) throws -> ImageConfig) throws -> CacheEntry {
    guard isImageID(imageID) else { throw RefactorError(.INTERNAL, "not an image id: \(imageID)") }
    if let entry = load(imageID: imageID) { return entry }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    sweepStale()

    let final = entryURL(imageID: imageID)
    if fileExists(final.path) {
      if let entry = Self.check(final, imageID: imageID) { return entry }
      moveAsideAndRemove(final)
    }

    let tmp = root.appendingPathComponent(".tmp-\(getpid())-\(randomSuffix())")
    try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    var keepTmp = false
    defer {
      if !keepTmp { Self.forceRemove(tmp) }
      registry?.removeTemporary(tmp.path)
    }
    try registry?.addTemporary(tmp.path)
    let rootfs = tmp.appendingPathComponent(Self.rootfsName)
    let scratch = tmp.appendingPathComponent("scratch")
    try FileManager.default.createDirectory(at: rootfs, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o755])
    try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    let config = try build(rootfs, scratch)
    Self.forceRemove(scratch)
    try Self.prepareMountPoints(rootfs)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    try encoder.encode(config).write(to: tmp.appendingPathComponent(Self.configName))
    try Data(Self.markerContent(imageID: imageID).utf8).write(to: tmp.appendingPathComponent(Self.markerName))

    if rename(tmp.path, final.path) == 0 {
      keepTmp = true
    } else {
      // Another process finished the same entry first: use theirs.
      let err = errno
      guard err == EEXIST || err == ENOTEMPTY, let entry = Self.check(final, imageID: imageID) else {
        throw RefactorError(.INTERNAL, "could not move the image folder into the cache at \(final.path): \(String(cString: strerror(err)))")
      }
      return entry
    }
    guard let entry = Self.check(final, imageID: imageID) else {
      throw RefactorError(.INTERNAL, "the image folder at \(final.path) does not check out right after it was built")
    }
    return entry
  }

  /// The four mount points become real directories: whatever the image has there (a file, a symlink)
  /// is replaced, so no mount can be pointed elsewhere by the image.
  static func prepareMountPoints(_ rootfs: URL) throws {
    chmod(rootfs.path, 0o755)
    for point in mountPoints {
      let path = rootfs.appendingPathComponent(point).path
      if fileExists(path) && !isRealDirectory(path) { forceRemove(URL(fileURLWithPath: path)) }
      if !fileExists(path) {
        guard mkdir(path, 0o755) == 0 else {
          throw RefactorError(.INTERNAL, "could not create \(path): \(String(cString: strerror(errno)))")
        }
      }
    }
  }

  /// Removes leftovers of entries moved aside, and of builds whose process is gone and whose folder
  /// was last changed over an hour ago. The age matters: a jig in another PID namespace (a container
  /// sharing the cache) has a pid this process cannot see, so a missing pid alone does not mean its
  /// build is dead.
  func sweepStale() {
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: root.path) else { return }
    for name in names {
      if name.hasPrefix(".trash-") {
        Self.forceRemove(root.appendingPathComponent(name))
      } else if name.hasPrefix(".tmp-") {
        let parts = name.split(separator: "-")
        guard parts.count >= 3, let pid = pid_t(parts[1]), kill(pid, 0) != 0, errno == ESRCH else { continue }
        let dir = root.appendingPathComponent(name)
        var st = stat()
        guard lstat(dir.path, &st) == 0 else { continue }
        guard time(nil) - st.st_mtim.tv_sec > 3600 else { continue }
        Self.forceRemove(dir)
      }
    }
  }

  private func moveAsideAndRemove(_ dir: URL) {
    let trash = root.appendingPathComponent(".trash-\(getpid())-\(randomSuffix())")
    if rename(dir.path, trash.path) == 0 { Self.forceRemove(trash) } else { Self.forceRemove(dir) }
  }

  /// Deletes `url` and everything under it, also read-only folders (the image has some). Never
  /// follows symlinks.
  static func forceRemove(_ url: URL) {
    makeOwnerWritable(url.path)
    try? FileManager.default.removeItem(at: url)
  }

  private static func makeOwnerWritable(_ path: String) {
    var st = stat()
    guard lstat(path, &st) == 0, (st.st_mode & S_IFMT) == S_IFDIR else { return }
    chmod(path, (st.st_mode & 0o7777) | 0o700)
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: path) else { return }
    for name in names { makeOwnerWritable(path + "/" + name) }
  }
}

func randomSuffix() -> String {
  String(UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "").prefix(12))
}

func fileExists(_ path: String) -> Bool {
  var st = stat()
  return lstat(path, &st) == 0
}

/// A directory, not a symlink to one.
func isRealDirectory(_ path: String) -> Bool {
  var st = stat()
  return lstat(path, &st) == 0 && (st.st_mode & S_IFMT) == S_IFDIR
}
