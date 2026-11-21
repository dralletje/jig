import Foundation
import Report
import Testing

@testable import OCI

/// Every entry of the tar archive `file`, with its content (the archives here are small).
func readTarArchive(_ file: URL) throws -> [(entry: TarEntry, content: Data)] {
  let handle = try FileHandle(forReadingFrom: file)
  defer { try? handle.close() }
  var reader = TarReader(name: file.path) { count in try handle.read(upToCount: count) ?? Data() }
  var entries: [(entry: TarEntry, content: Data)] = []
  while let entry = try reader.next() {
    var content = Data()
    while true {
      let piece = try reader.readContent(upTo: 64 * 1024)
      if piece.isEmpty { break }
      content += piece
    }
    entries.append((entry, content))
  }
  return entries
}

/// A one-layer image put into `store`; the manifest's own `mediaType` field is `manifestType`, or
/// left out when nil.
func storeOneLayerImage(_ store: OCIStore, manifestType: String?) throws -> ResolvedImage {
  let layer = Data("pretend this is a gzip layer".utf8)
  let layerDescriptor = Descriptor(
    mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: SHA256Hasher.digest(layer), size: Int64(layer.count))
  let config = Data(#"{"architecture":"amd64","os":"linux","config":{"Cmd":["node"]},"rootfs":{"type":"layers","diff_ids":[]}}"#.utf8)
  let configDescriptor = Descriptor(
    mediaType: "application/vnd.oci.image.config.v1+json", digest: SHA256Hasher.digest(config), size: Int64(config.count))
  let typeField = manifestType.map { #""mediaType":"\#($0)","# } ?? ""
  let manifest = Data(
    (#"{"schemaVersion":2,"# + typeField
      + #""config":{"mediaType":"application/vnd.oci.image.config.v1+json","digest":"\#(configDescriptor.digest)","size":\#(config.count)},"#
      + #""layers":[{"mediaType":"application/vnd.oci.image.layer.v1.tar+gzip","digest":"\#(layerDescriptor.digest)","size":\#(layer.count)}]}"#)
      .utf8)
  let manifestDigest = SHA256Hasher.digest(manifest)
  try store.put(layer, as: layerDescriptor.digest)
  try store.put(config, as: configDescriptor.digest)
  try store.put(manifest, as: manifestDigest)
  return ResolvedImage(
    pinned: manifestDigest, manifest: manifestDigest, configDescriptor: configDescriptor,
    config: ImageConfigFile(cmd: ["node"]), layers: [layerDescriptor])
}

@Test func dockerNameIsDerivedFromTheManifest() {
  let digest = SHA256Hasher.digest(Data("manifest".utf8))
  #expect(dockerName(for: digest) == "jig-oci.invalid/\(digest.hex):image")
}

@Test func archiveOfAOneLayerImageHasExactlyItsEntries() throws {
  try withTemporaryStore { store, root in
    let image = try storeOneLayerImage(store, manifestType: MediaType.dockerManifest)
    let archive = root.appendingPathComponent("image.tar")
    try writeDockerArchive(image, from: store, to: archive)
    let entries = try readTarArchive(archive)
    let name = dockerName(for: image.manifest)

    #expect(
      entries.map(\.entry.path) == [
        "oci-layout", "index.json", "manifest.json", "blobs/", "blobs/sha256/",
        "blobs/sha256/\(image.manifest.hex)", "blobs/sha256/\(image.configDescriptor.digest.hex)",
        "blobs/sha256/\(image.layers[0].digest.hex)",
      ])
    #expect(entries.map(\.entry.kind) == [.file, .file, .file, .directory, .directory, .file, .file, .file])
    for (entry, content) in entries where entry.path.hasPrefix("blobs/sha256/") && entry.kind == .file {
      let digest = Digest("sha256:" + entry.path.dropFirst("blobs/sha256/".count))!
      #expect(content == (try Data(contentsOf: store.blobURL(digest))))
    }
    #expect(String(decoding: entries[0].content, as: UTF8.self) == #"{"imageLayoutVersion":"1.0.0"}"#)

    let index = try JSONSerialization.jsonObject(with: entries[1].content) as? [String: Any]
    #expect(index?["schemaVersion"] as? Int == 2)
    #expect(index?["mediaType"] as? String == MediaType.ociIndex)
    let manifests = index?["manifests"] as? [[String: Any]] ?? []
    #expect(manifests.count == 1)
    #expect(manifests.first?["digest"] as? String == image.manifest.description)
    #expect(manifests.first?["mediaType"] as? String == MediaType.dockerManifest)
    #expect(manifests.first?["size"] as? Int == entries[5].content.count)
    #expect(
      manifests.first?["annotations"] as? [String: String] == [
        "io.containerd.image.name": name, "org.opencontainers.image.ref.name": name,
      ])

    let dockerManifest = try JSONSerialization.jsonObject(with: entries[2].content) as? [[String: Any]] ?? []
    #expect(dockerManifest.count == 1)
    #expect(dockerManifest.first?["RepoTags"] as? [String] == [name])
    #expect(dockerManifest.first?["Config"] as? String == "blobs/sha256/\(image.configDescriptor.digest.hex)")
    #expect(dockerManifest.first?["Layers"] as? [String] == ["blobs/sha256/\(image.layers[0].digest.hex)"])
  }
}

@Test func aManifestWithoutAMediaTypeIsAnOCIManifest() throws {
  try withTemporaryStore { store, root in
    let image = try storeOneLayerImage(store, manifestType: nil)
    let archive = root.appendingPathComponent("image.tar")
    try writeDockerArchive(image, from: store, to: archive)
    let entries = try readTarArchive(archive)
    let index = try JSONSerialization.jsonObject(with: entries[1].content) as? [String: Any]
    let manifests = index?["manifests"] as? [[String: Any]] ?? []
    #expect(manifests.first?["mediaType"] as? String == MediaType.ociManifest)
  }
}

@Test func aMissingBlobFailsBeforeWriting() throws {
  try withTemporaryStore { store, root in
    var image = try storeOneLayerImage(store, manifestType: MediaType.ociManifest)
    let missing = SHA256Hasher.digest(Data("not stored".utf8))
    image.layers.append(Descriptor(mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: missing, size: 10))
    let archive = root.appendingPathComponent("image.tar")
    #expect {
      try writeDockerArchive(image, from: store, to: archive)
    } throws: { error in
      (error as? RefactorError)?.code == .INTERNAL
    }
    #expect(!FileManager.default.fileExists(atPath: archive.path))
  }
}

@Test func tarWriterWritesLongNamesAndStreamsFiles() throws {
  let folder = FileManager.default.temporaryDirectory.appendingPathComponent("tar-writer-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: folder) }

  // Larger than one read piece, and not a multiple of 512.
  var bytes = [UInt8](repeating: 0, count: (1 << 20) + 1234)
  for index in bytes.indices { bytes[index] = UInt8(truncatingIfNeeded: index &* 7 &+ 3) }
  let source = folder.appendingPathComponent("source")
  try Data(bytes).write(to: source)
  let longName = String(repeating: "directory/", count: 15) + "file-with-a-long-name.txt"
  let longFolder = String(repeating: "folder/", count: 20)

  let archive = folder.appendingPathComponent("out.tar")
  #expect(FileManager.default.createFile(atPath: archive.path, contents: nil))
  let handle = try FileHandle(forWritingTo: archive)
  var writer = TarWriter(handle: handle, name: "a test archive")
  try writer.addDirectory("short", mode: 0o700)
  try writer.addDirectory(longFolder)
  try writer.addFile(longName, data: Data("hello".utf8), mode: 0o600)
  try writer.addFile("streamed", contentsOf: source)
  try writer.addFile("empty", data: Data())
  try writer.finish()
  try handle.close()

  let entries = try readTarArchive(archive)
  #expect(entries.map(\.entry.path) == ["short/", longFolder, longName, "streamed", "empty"])
  #expect(entries.map(\.entry.kind) == [.directory, .directory, .file, .file, .file])
  #expect(entries.map(\.entry.mode) == [0o700, 0o755, 0o600, 0o644, 0o644])
  #expect(entries[2].content == Data("hello".utf8))
  #expect(entries[3].content == Data(bytes))
  #expect(entries[4].content.isEmpty)

  // The system's tar reads it too, long names included.
  let listing = try runCommand("tar", ["-tf", archive.path])
  #expect(listing.status == 0)
  #expect(listing.output.split(separator: "\n").map(String.init) == ["short/", longFolder, longName, "streamed", "empty"])
}

// MARK: - The real `docker load`

/// `program` (found on PATH) with `arguments`; its exit status and what it printed on stdout.
/// stderr goes to the test's stderr.
func runCommand(_ program: String, _ arguments: [String]) throws -> (status: Int32, output: String) {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
  process.arguments = [program] + arguments
  let pipe = Pipe()
  process.standardOutput = pipe
  process.standardInput = FileHandle.nullDevice
  try process.run()
  let output = pipe.fileHandleForReading.readDataToEndOfFile()
  process.waitUntilExit()
  return (process.terminationStatus, String(decoding: output, as: UTF8.self))
}

/// The local image the Docker check saves and loads back: built by jig's own image builds.
let dockerCheckImage = "localhost/jig/prettier:local"

/// Docker answers and has `dockerCheckImage`.
let dockerCheckPossible: Bool = {
  guard let version = try? runCommand("docker", ["version", "--format", "{{.Server.Version}}"]), version.status == 0
  else { return false }
  guard let inspect = try? runCommand("docker", ["image", "inspect", "--format", "{{.Id}}", dockerCheckImage]),
    inspect.status == 0
  else { return false }
  return true
}()

/// A real image goes through the store and back into Docker: `docker save` of a local image, its
/// blobs put into a fresh store, the `ResolvedImage` built from its manifest by hand (no puller),
/// then `writeDockerArchive`, `docker load`, `docker image inspect` and `docker run` of the name.
@Test(.enabled(if: dockerCheckPossible, "needs Docker and the image \(dockerCheckImage)"))
func dockerLoadsTheArchiveAndRunsIt() throws {
  try withTemporaryStore { store, root in
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let saved = root.appendingPathComponent("saved.tar")
    let save = try runCommand("docker", ["save", dockerCheckImage, "-o", saved.path])
    try #require(save.status == 0)

    // Every blob of the saved archive into the store; index.json kept to start from.
    var savedIndex = Data()
    let handle = try FileHandle(forReadingFrom: saved)
    defer { try? handle.close() }
    var reader = TarReader(name: saved.path) { count in try handle.read(upToCount: count) ?? Data() }
    while let entry = try reader.next() {
      if entry.path == "index.json" {
        while true {
          let piece = try reader.readContent(upTo: 64 * 1024)
          if piece.isEmpty { break }
          savedIndex += piece
        }
        continue
      }
      guard entry.kind == .file, entry.path.hasPrefix("blobs/sha256/"),
        let digest = Digest("sha256:" + entry.path.dropFirst("blobs/sha256/".count))
      else { continue }
      let file = try store.temporaryFile()
      let output = try FileHandle(forWritingTo: file)
      while true {
        let piece = try reader.readContent(upTo: 1 << 20)
        if piece.isEmpty { break }
        try output.write(contentsOf: piece)
      }
      try output.close()
      try store.adopt(file, as: digest)
    }

    // From the saved index to this machine's platform manifest, as the puller would.
    let top = try JSONDecoder().decode(ImageIndex.self, from: savedIndex)
    var descriptor = try #require(top.manifests.first)
    var manifest: ImageManifest?
    while manifest == nil {
      let data = try Data(contentsOf: store.blobURL(descriptor.digest))
      switch try ParsedManifest.parse(data, mediaType: descriptor.mediaType) {
      case .image(let image):
        manifest = image
      case .index(let index):
        descriptor = try #require(index.manifest(for: Platform.host))
      }
    }
    let platformManifest = try #require(manifest)
    let config = try JSONDecoder().decode(
      ImageConfigFile.self, from: Data(contentsOf: store.blobURL(platformManifest.config.digest)))
    let image = ResolvedImage(
      pinned: top.manifests[0].digest, manifest: descriptor.digest, configDescriptor: platformManifest.config,
      config: config, layers: platformManifest.layers)

    let archive = root.appendingPathComponent("load.tar")
    try writeDockerArchive(image, from: store, to: archive)

    let name = dockerName(for: image.manifest)
    _ = try runCommand("docker", ["rmi", "--force", name])
    defer { _ = try? runCommand("docker", ["rmi", "--force", name]) }
    let load = try runCommand("docker", ["load", "--input", archive.path])
    #expect(load.status == 0)
    #expect(load.output.contains(name))
    let inspect = try runCommand("docker", ["image", "inspect", "--format", "{{json .RepoTags}}", name])
    #expect(inspect.status == 0)
    #expect(inspect.output.contains(name))
    let run = try runCommand(
      "docker", ["run", "--rm", "--network", "none", "--entrypoint", "node", name, "--version"])
    #expect(run.status == 0)
    #expect(run.output.hasPrefix("v"))
  }
}
