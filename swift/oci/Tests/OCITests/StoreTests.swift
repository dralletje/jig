import Foundation
import Report
import Testing

@testable import OCI

#if canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#endif

/// A store in a fresh temporary folder; `body` gets it, the folder is removed afterwards.
func withTemporaryStore(_ body: (OCIStore, URL) throws -> Void) throws {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("oci-store-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: root) }
  try body(OCIStore(root: root), root)
}

@Test func defaultRootFollowsXDGThenHome() {
  #expect(OCIStore.defaultRoot(environment: ["XDG_CACHE_HOME": "/c", "HOME": "/h"])?.path == "/c/jig/oci")
  #expect(OCIStore.defaultRoot(environment: ["XDG_CACHE_HOME": "relative", "HOME": "/h"])?.path == "/h/.cache/jig/oci")
  #expect(OCIStore.defaultRoot(environment: ["HOME": "/h"])?.path == "/h/.cache/jig/oci")
  #expect(OCIStore.defaultRoot(environment: [:]) == nil)
}

@Test func putThenHas() throws {
  try withTemporaryStore { store, root in
    let data = Data(#"{"schemaVersion":2}"#.utf8)
    let digest = SHA256Hasher.digest(data)
    #expect(!store.has(digest))
    try store.put(data, as: digest)
    #expect(store.has(digest))
    #expect(try Data(contentsOf: store.blobURL(digest)) == data)
    #expect(store.blobURL(digest).path == root.appendingPathComponent("blobs/sha256/\(digest.hex)").path)
    // A second put of the same bytes is fine.
    try store.put(data, as: digest)
    #expect(try String(contentsOf: root.appendingPathComponent("oci-layout"), encoding: .utf8) == #"{"imageLayoutVersion":"1.0.0"}"#)
    let index = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("index.json"))) as? [String: Any]
    #expect(index?["schemaVersion"] as? Int == 2)
  }
}

@Test func putWithWrongBytesStoresNothing() throws {
  try withTemporaryStore { store, _ in
    let digest = SHA256Hasher.digest(Data("right".utf8))
    #expect {
      try store.put(Data("wrong".utf8), as: digest)
    } throws: { error in
      (error as? RefactorError)?.code == .REGISTRY_UNAVAILABLE
    }
    #expect(!store.has(digest))
  }
}

@Test func adoptMovesACheckedFileIn() throws {
  try withTemporaryStore { store, root in
    let data = Data("a layer".utf8)
    let digest = SHA256Hasher.digest(data)
    let file = try store.temporaryFile()
    #expect(file.deletingLastPathComponent().path == root.appendingPathComponent("tmp").path)
    #expect(file.lastPathComponent.hasPrefix(".tmp-\(getpid())-"))
    try data.write(to: file)
    try store.adopt(file, as: digest)
    #expect(store.has(digest))
    #expect(!FileManager.default.fileExists(atPath: file.path))
    #expect(try Data(contentsOf: store.blobURL(digest)) == data)
  }
}

@Test func adoptWithWrongBytesThrowsAndLeavesNoBlob() throws {
  try withTemporaryStore { store, _ in
    let digest = SHA256Hasher.digest(Data("expected".utf8))
    let file = try store.temporaryFile()
    try Data("something else".utf8).write(to: file)
    #expect {
      try store.adopt(file, as: digest)
    } throws: { error in
      (error as? RefactorError)?.code == .REGISTRY_UNAVAILABLE
    }
    #expect(!store.has(digest))
    #expect(!FileManager.default.fileExists(atPath: file.path))
  }
}

@Test func recordTagReplacesOnlyThatName() throws {
  try withTemporaryStore { store, root in
    let first = Descriptor(
      mediaType: MediaType.ociIndex, digest: SHA256Hasher.digest(Data("one".utf8)), size: 3)
    let second = Descriptor(
      mediaType: MediaType.ociIndex, digest: SHA256Hasher.digest(Data("two".utf8)), size: 3)
    let other = Descriptor(
      mediaType: MediaType.dockerManifest, digest: SHA256Hasher.digest(Data("other".utf8)), size: 5)
    #expect(store.lastTag("docker.io/library/node:26") == nil)
    try store.recordTag("docker.io/library/node:26", first)
    try store.recordTag("ghcr.io/acme/tool:1", other)
    try store.recordTag("docker.io/library/node:26", second)

    #expect(store.lastTag("docker.io/library/node:26")?.digest == second.digest)
    #expect(store.lastTag("docker.io/library/node:26")?.mediaType == MediaType.ociIndex)
    #expect(store.lastTag("ghcr.io/acme/tool:1")?.digest == other.digest)
    #expect(store.lastTag("docker.io/library/node:22") == nil)

    let data = try Data(contentsOf: root.appendingPathComponent("index.json"))
    let index = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    let manifests = index?["manifests"] as? [[String: Any]] ?? []
    #expect(manifests.count == 2)
    let names = manifests.compactMap { ($0["annotations"] as? [String: String])?["org.opencontainers.image.ref.name"] }
    #expect(Set(names) == ["docker.io/library/node:26", "ghcr.io/acme/tool:1"])
  }
}

/// An index.json that exists but cannot be read is an error, not an empty index: recording a tag must
/// not rewrite it with only the new entry.
@Test(.enabled(if: getuid() != 0, "root reads files whatever their mode"))
func recordTagThrowsWhenTheIndexCannotBeRead() throws {
  try withTemporaryStore { store, root in
    let kept = Descriptor(
      mediaType: MediaType.ociIndex, digest: SHA256Hasher.digest(Data("kept".utf8)), size: 4)
    let new = Descriptor(
      mediaType: MediaType.ociIndex, digest: SHA256Hasher.digest(Data("new".utf8)), size: 3)
    try store.recordTag("ghcr.io/acme/kept:1", kept)
    let indexPath = root.appendingPathComponent("index.json").path
    #expect(chmod(indexPath, 0o000) == 0)
    defer { chmod(indexPath, 0o600) }
    #expect {
      try store.recordTag("ghcr.io/acme/new:1", new)
    } throws: { error in
      (error as? RefactorError)?.code == .INTERNAL
    }
    chmod(indexPath, 0o600)
    #expect(store.lastTag("ghcr.io/acme/kept:1")?.digest == kept.digest)
    #expect(store.lastTag("ghcr.io/acme/new:1") == nil)
  }
}

/// Review Focus 1: two pulls at once. 8 threads × 25 tags of distinct names, each also adopting the
/// same blob, every thread through its own `OCIStore` value: `index.json` keeps all 200 names and
/// the blob is whole.
@Test func concurrentRecordTagAndAdoptLoseNothing() throws {
  try withTemporaryStore { _, root in
    var bytes = [UInt8](repeating: 0, count: 256 * 1024)
    for index in bytes.indices { bytes[index] = UInt8(truncatingIfNeeded: index &* 31 &+ 7) }
    let blob = Data(bytes)
    let blobDigest = SHA256Hasher.digest(blob)
    let failures = FailureList()

    DispatchQueue.concurrentPerform(iterations: 8) { thread in
      let store = OCIStore(root: root)
      for round in 0..<25 {
        do {
          let file = try store.temporaryFile()
          try blob.write(to: file)
          try store.adopt(file, as: blobDigest)
          let name = "ghcr.io/acme/image\(thread):\(round)"
          let descriptor = Descriptor(
            mediaType: MediaType.ociManifest, digest: SHA256Hasher.digest(Data(name.utf8)), size: Int64(round))
          try store.recordTag(name, descriptor)
        } catch {
          failures.add("\(thread)/\(round): \(error)")
        }
      }
    }

    #expect(failures.all.isEmpty)
    let store = OCIStore(root: root)
    let data = try Data(contentsOf: root.appendingPathComponent("index.json"))
    let index = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    let manifests = index?["manifests"] as? [[String: Any]] ?? []
    #expect(manifests.count == 200)
    for thread in 0..<8 {
      for round in 0..<25 {
        let name = "ghcr.io/acme/image\(thread):\(round)"
        #expect(store.lastTag(name)?.digest == SHA256Hasher.digest(Data(name.utf8)))
      }
    }
    #expect(try SHA256Hasher.digest(fileAt: store.blobURL(blobDigest)) == blobDigest)
    // Every temporary file was either adopted or removed.
    #expect(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("tmp").path).isEmpty)
  }
}

/// Review Focus 5: leftovers of an interrupted pull are swept on the next use, once over an hour old;
/// ours stay, also when old.
@Test func temporaryFileSweepsLeftoversOfDeadProcesses() throws {
  try withTemporaryStore { store, root in
    let tmp = root.appendingPathComponent("tmp")
    try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
    // PID 2^22 + 1 is above pid_max's ceiling: never alive.
    let dead = tmp.appendingPathComponent(".tmp-4194305-x")
    let ours = tmp.appendingPathComponent(".tmp-\(getpid())-y")
    try Data("half a layer".utf8).write(to: dead)
    try Data("in progress".utf8).write(to: ours)
    let twoHoursAgo = Date(timeIntervalSinceNow: -7200)
    for file in [dead, ours] {
      try FileManager.default.setAttributes([.modificationDate: twoHoursAgo], ofItemAtPath: file.path)
    }
    let file = try store.temporaryFile()
    #expect(!FileManager.default.fileExists(atPath: dead.path))
    #expect(FileManager.default.fileExists(atPath: ours.path))
    #expect(FileManager.default.fileExists(atPath: file.path))
  }
}

/// A file of a pid this process cannot see, written recently, may be a live download of a jig in
/// another PID namespace: it stays.
@Test func temporaryFileKeepsFreshFilesOfUnseenProcesses() throws {
  try withTemporaryStore { store, root in
    let tmp = root.appendingPathComponent("tmp")
    try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
    let fresh = tmp.appendingPathComponent(".tmp-4194305-z")
    try Data("downloading elsewhere".utf8).write(to: fresh)
    _ = try store.temporaryFile()
    #expect(FileManager.default.fileExists(atPath: fresh.path))
  }
}

/// Errors collected from several threads.
final class FailureList: @unchecked Sendable {
  private let lock = NSLock()
  private var items: [String] = []

  func add(_ item: String) {
    lock.lock()
    items.append(item)
    lock.unlock()
  }

  var all: [String] {
    lock.lock()
    defer { lock.unlock() }
    return items
  }
}
