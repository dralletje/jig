import Foundation
import Report

#if canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#endif

/// Unpacks an image's layers, bottom first, into the folder `rootfs` (made when missing): each
/// layer's `file` is its blob, gzip-compressed or plain tar as its descriptor's media type says.
///
/// Whiteouts remove what lower layers put there: `.wh.<name>` removes `<name>`, `.wh..wh..opq`
/// empties its folder. Files, folders and symlinks keep their permission bits, without setuid and
/// setgid; the caller owns everything. Devices, FIFOs and other entries are skipped.
///
/// No entry writes outside `rootfs`. Every path is taken relative to `rootfs` and walked one
/// component at a time from an open folder, never following a symlink: an absolute path, a `..`,
/// a path through a symlink (from this layer or an earlier one), or a hard link to something
/// outside or missing fails with `IMAGE_FAILED` before anything of that entry is written.
public func unpackLayers(_ layers: [(descriptor: Descriptor, file: URL)], into rootfs: URL) throws {
  try FileManager.default.createDirectory(at: rootfs, withIntermediateDirectories: true)
  let root = open(rootfs.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
  guard root >= 0 else { throw unpackFailed("open \(rootfs.path)") }
  defer { close(root) }

  var unpacker = Unpacker(root: root)
  for layer in layers {
    let mediaType = layer.descriptor.mediaType
    let name = "the image's layer \(layer.descriptor.digest)"
    if MediaType.isZstdLayer(mediaType) {
      throw RefactorError(
        code: .INTERNAL,
        instructions: "\(name) is zstd-compressed (\(mediaType)), and jig does not support zstd layers yet. Use "
          + "an image whose layers are gzip-compressed (what docker build and docker push make by default).")
    }
    if MediaType.isGzipLayer(mediaType) {
      var gzip = try GzipReader(fileAt: layer.file)
      var tar = TarReader(name: name) { count in try gzip.read(upTo: count) }
      try unpacker.unpack(&tar, digest: layer.descriptor.digest)
      continue
    }
    if MediaType.isPlainLayer(mediaType) {
      let handle = try FileHandle(forReadingFrom: layer.file)
      defer { try? handle.close() }
      var tar = TarReader(name: name) { count in try handle.read(upToCount: count) ?? Data() }
      try unpacker.unpack(&tar, digest: layer.descriptor.digest)
      continue
    }
    throw RefactorError(
      code: .IMAGE_FAILED,
      instructions: "\(name) has the media type \(mediaType), which is not a tar layer jig can read. Use another "
        + "image.")
  }
  try unpacker.applyFolderModes()
}

/// Unpacking state across layers. Every operation goes through file descriptors of folders inside
/// `root`, opened with `O_NOFOLLOW`, so a symlink in the image is never followed by jig.
private struct Unpacker {
  let root: Int32
  /// The modes folders get once all layers are unpacked, by path. Until then every folder stays
  /// writable and searchable by its owner, so later entries and layers can go into it.
  var folderModes: [String: UInt32] = [:]
  /// The paths the current layer made or changed (with their parent folders): whiteouts and opaque
  /// folders remove only what lower layers put there.
  var touched: Set<String> = []

  init(root: Int32) {
    self.root = root
  }

  mutating func unpack(_ tar: inout TarReader, digest: Digest) throws {
    touched = []
    while let entry = try tar.next() {
      let components = try relativeComponents(entry.path, entry: entry.path, digest: digest)
      // The archive's own top folder (`./`): rootfs itself, which is the caller's.
      if components.isEmpty { continue }
      let path = components.joined(separator: "/")
      let base = components[components.count - 1]
      let parentComponents = Array(components.dropLast())

      if base == ".wh..wh..opq" {
        guard let parent = try openFolder(parentComponents, create: false, entry: entry.path, digest: digest) else {
          continue
        }
        defer { close(parent) }
        let parentPath = parentComponents.joined(separator: "/")
        for child in try childNames(parent) {
          try removeLower(parent, child, path: parentPath.isEmpty ? child : parentPath + "/" + child)
        }
        continue
      }
      if base.hasPrefix(".wh.") {
        let name = String(base.dropFirst(4))
        guard !name.isEmpty, name != ".", name != "..", !name.contains("/") else {
          throw outside(entry.path, digest: digest)
        }
        guard let parent = try openFolder(parentComponents, create: false, entry: entry.path, digest: digest) else {
          continue
        }
        defer { close(parent) }
        let parentPath = parentComponents.joined(separator: "/")
        try removeLower(parent, name, path: parentPath.isEmpty ? name : parentPath + "/" + name)
        continue
      }
      if entry.kind == .other { continue }

      // The hard link's target is checked before anything of this entry is written.
      var target: (folder: Int32, name: String)?
      if entry.kind == .hardLink {
        let targetComponents = try relativeComponents(
          entry.linkTarget, entry: "\(entry.path) (a hard link to \(entry.linkTarget))", digest: digest)
        guard !targetComponents.isEmpty else {
          throw outside("\(entry.path) (a hard link to \(entry.linkTarget))", digest: digest)
        }
        if targetComponents == components {
          // A link to itself: what is there stays.
          continue
        }
        guard
          let targetFolder = try openFolder(
            Array(targetComponents.dropLast()), create: false,
            entry: "\(entry.path) (a hard link to \(entry.linkTarget))", digest: digest)
        else {
          throw outside("\(entry.path) (a hard link to \(entry.linkTarget))", digest: digest)
        }
        let targetName = targetComponents[targetComponents.count - 1]
        var info = stat()
        guard fstatat(targetFolder, targetName, &info, AT_SYMLINK_NOFOLLOW) == 0,
          info.st_mode & S_IFMT != S_IFDIR
        else {
          close(targetFolder)
          throw outside("\(entry.path) (a hard link to \(entry.linkTarget))", digest: digest)
        }
        target = (targetFolder, targetName)
      }
      defer {
        if let target { close(target.folder) }
      }

      for index in components.indices {
        touched.insert(components[0...index].joined(separator: "/"))
      }
      guard let parent = try openFolder(parentComponents, create: true, entry: entry.path, digest: digest) else {
        throw outside(entry.path, digest: digest)
      }
      defer { close(parent) }

      if entry.kind == .directory {
        var info = stat()
        if fstatat(parent, base, &info, AT_SYMLINK_NOFOLLOW) == 0 && info.st_mode & S_IFMT != S_IFDIR {
          try removeTree(parent, base)
          dropFolderModes(under: path)
        }
        if fstatat(parent, base, &info, AT_SYMLINK_NOFOLLOW) != 0 {
          guard mkdirat(parent, base, 0o700) == 0 else { throw unpackFailed("create the folder \(path)") }
        }
        let folder = openat(parent, base, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard folder >= 0 else { throw unpackFailed("open the folder \(path)") }
        defer { close(folder) }
        guard fchmod(folder, mode_t(entry.mode & 0o1777 | 0o700)) == 0 else {
          throw unpackFailed("set the mode of \(path)")
        }
        folderModes[path] = entry.mode & 0o1777
        continue
      }

      // Anything else replaces what is there (a file, a symlink, a folder), never writes through it.
      try removeTree(parent, base)
      dropFolderModes(under: path)

      if entry.kind == .symlink {
        guard symlinkat(entry.linkTarget, parent, base) == 0 else { throw unpackFailed("create the symlink \(path)") }
        continue
      }
      if entry.kind == .hardLink, let target {
        guard linkat(target.folder, target.name, parent, base, 0) == 0 else {
          throw unpackFailed("create the hard link \(path) to \(entry.linkTarget)")
        }
        continue
      }

      let file = openat(parent, base, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
      guard file >= 0 else { throw unpackFailed("create the file \(path)") }
      defer { close(file) }
      while true {
        let piece = try tar.readContent(upTo: 1024 * 1024)
        if piece.isEmpty { break }
        try piece.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
          var written = 0
          while written < bytes.count {
            let count = write(file, bytes.baseAddress! + written, bytes.count - written)
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { throw unpackFailed("write the file \(path)") }
            written += count
          }
        }
      }
      guard fchmod(file, mode_t(entry.mode & 0o1777)) == 0 else { throw unpackFailed("set the mode of \(path)") }
    }
  }

  /// Gives every folder an entry named the mode it asked for, deepest first, so a folder that is
  /// not searchable any more is never walked through.
  func applyFolderModes() throws {
    let paths = folderModes.keys.sorted { left, right in
      left.split(separator: "/").count > right.split(separator: "/").count
    }
    for path in paths {
      let components = path.split(separator: "/").map(String.init)
      guard let folder = try? openFolder(components, create: false, entry: path, digest: nil) else { continue }
      defer { close(folder) }
      guard fchmod(folder, mode_t(folderModes[path]!)) == 0 else { throw unpackFailed("set the mode of \(path)") }
    }
  }

  /// Forgets the modes of `path` and everything under it: they were removed.
  mutating func dropFolderModes(under path: String) {
    for key in folderModes.keys where key == path || key.hasPrefix(path + "/") {
      folderModes[key] = nil
    }
  }

  /// Removes what lower layers put at `name` in `folder`: all of it when this layer did not touch
  /// it; when this layer made the folder, only what is in it from lower layers.
  mutating func removeLower(_ folder: Int32, _ name: String, path: String) throws {
    if !touched.contains(path) {
      try removeTree(folder, name)
      dropFolderModes(under: path)
      return
    }
    var info = stat()
    guard fstatat(folder, name, &info, AT_SYMLINK_NOFOLLOW) == 0, info.st_mode & S_IFMT == S_IFDIR else { return }
    let child = openat(folder, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard child >= 0 else { throw unpackFailed("open the folder \(path)") }
    defer { close(child) }
    for grandchild in try childNames(child) {
      try removeLower(child, grandchild, path: path + "/" + grandchild)
    }
  }

  /// Opens the folder `components` below `root` (root itself when empty), checking each component
  /// with `fstatat` without following symlinks: a symlink or file there is an escape attempt. With
  /// `create`, missing folders are made (`0o755`); without, a missing one gives nil.
  func openFolder(_ components: [String], create: Bool, entry: String, digest: Digest?) throws -> Int32? {
    var folder = dup(root)
    guard folder >= 0 else { throw unpackFailed("open the image folder") }
    for (index, component) in components.enumerated() {
      var created = false
      var info = stat()
      if fstatat(folder, component, &info, AT_SYMLINK_NOFOLLOW) != 0 {
        guard errno == ENOENT else {
          close(folder)
          throw unpackFailed("look at \(components[0...index].joined(separator: "/"))")
        }
        if !create {
          close(folder)
          return nil
        }
        guard mkdirat(folder, component, 0o755) == 0 else {
          close(folder)
          throw unpackFailed("create the folder \(components[0...index].joined(separator: "/"))")
        }
        created = true
      } else if info.st_mode & S_IFMT != S_IFDIR {
        close(folder)
        guard let digest else { return nil }
        throw outside(entry, digest: digest)
      }
      // O_NOFOLLOW: should the component have become a symlink since the check, this fails.
      let next = openat(folder, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      close(folder)
      guard next >= 0 else {
        guard let digest else { return nil }
        throw outside(entry, digest: digest)
      }
      folder = next
      if created {
        // The umask may have taken bits away: a folder no entry names gets 0o755.
        fchmod(folder, 0o755)
      }
    }
    return folder
  }
}

/// The components of a path in a layer, relative to the image folder: `.` and empty ones dropped.
/// An absolute path, a `..` or a NUL byte is an escape attempt.
private func relativeComponents(_ path: String, entry: String, digest: Digest) throws -> [String] {
  guard !path.hasPrefix("/"), !path.contains("\0") else { throw outside(entry, digest: digest) }
  var components: [String] = []
  for component in path.split(separator: "/", omittingEmptySubsequences: true) {
    if component == "." { continue }
    guard component != ".." else { throw outside(entry, digest: digest) }
    components.append(String(component))
  }
  return components
}

/// The names in `folder`, without `.` and `..`.
private func childNames(_ folder: Int32) throws -> [String] {
  let listing = openat(folder, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
  guard listing >= 0, let directory = fdopendir(listing) else {
    if listing >= 0 { close(listing) }
    throw unpackFailed("list a folder")
  }
  defer { closedir(directory) }
  var names: [String] = []
  while let item = readdir(directory) {
    let name = withUnsafePointer(to: &item.pointee.d_name) { pointer in
      pointer.withMemoryRebound(to: CChar.self, capacity: MemoryLayout.size(ofValue: item.pointee.d_name)) {
        String(cString: $0)
      }
    }
    if name == "." || name == ".." { continue }
    names.append(name)
  }
  return names
}

/// Removes `name` in `folder` and, for a folder, everything in it; never follows a symlink.
/// Nothing there is fine.
private func removeTree(_ folder: Int32, _ name: String) throws {
  var info = stat()
  guard fstatat(folder, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else {
    guard errno == ENOENT else { throw unpackFailed("look at \(name)") }
    return
  }
  if info.st_mode & S_IFMT != S_IFDIR {
    guard unlinkat(folder, name, 0) == 0 else { throw unpackFailed("remove \(name)") }
    return
  }
  let child = openat(folder, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
  guard child >= 0 else { throw unpackFailed("open the folder \(name)") }
  // A folder of the image that is not writable (its final mode is applied only at the end).
  fchmod(child, 0o700)
  for grandchild in try childNames(child) {
    do {
      try removeTree(child, grandchild)
    } catch {
      close(child)
      throw error
    }
  }
  close(child)
  guard unlinkat(folder, name, AT_REMOVEDIR) == 0 else { throw unpackFailed("remove the folder \(name)") }
}

private func outside(_ path: String, digest: Digest) -> RefactorError {
  RefactorError(
    code: .IMAGE_FAILED,
    instructions: "the image's layer \(digest) has an entry outside the image: \(path). jig refuses to unpack it; "
      + "use another image.")
}

/// A system call failed while unpacking, with what jig was doing and the system's reason.
private func unpackFailed(_ doing: String) -> RefactorError {
  let reason = String(cString: strerror(errno))
  return RefactorError(
    code: .IMAGE_FAILED,
    instructions: "jig could not unpack the image: \(doing) failed (\(reason)). Check the free space and "
      + "permissions of jig's cache folder, then run again.")
}
