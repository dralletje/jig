import Foundation
import Report

/// The name a registry image is loaded into Docker under: `jig-oci.invalid/<manifest hex>:image`.
/// `.invalid` never resolves, so Docker can never pull something else under that name.
public func dockerName(for manifest: Digest) -> String {
  "jig-oci.invalid/\(manifest.hex):image"
}

/// Writes `image` as an archive `docker load` reads, with its blobs from `store`: `oci-layout`,
/// `index.json` (one descriptor for the platform manifest, named `dockerName(for:)` by the
/// annotations `io.containerd.image.name` and `org.opencontainers.image.ref.name`), `manifest.json`
/// (Docker's own list of config, name and layers), and `blobs/sha256/` with the platform manifest,
/// the config and the layers. Both Docker's classic image store and the containerd image store load
/// it. Blobs are streamed from the store; no layer is ever all in memory.
public func writeDockerArchive(_ image: ResolvedImage, from store: OCIStore, to file: URL) throws {
  for digest in [image.manifest, image.configDescriptor.digest] + image.layers.map(\.digest) {
    guard store.has(digest) else {
      throw RefactorError(
        code: .INTERNAL,
        instructions: "The image's blob \(digest) is missing from jig's image store at \(store.root.path). "
          + "Delete the folder \(store.root.path) (it is a download cache) and run again.")
    }
  }

  // The platform manifest: its media type from its own `mediaType` field (OCI when it has none).
  let manifestData: Data
  do {
    manifestData = try Data(contentsOf: store.blobURL(image.manifest))
  } catch {
    throw RefactorError(
      code: .INTERNAL,
      instructions: "jig could not read the manifest \(image.manifest) from its image store: \(error). Delete the "
        + "folder \(store.root.path) (it is a download cache) and run again.")
  }
  struct ManifestBody: Decodable { var mediaType: String? }
  let manifestType = (try? JSONDecoder().decode(ManifestBody.self, from: manifestData))?.mediaType ?? MediaType.ociManifest

  let name = dockerName(for: image.manifest)
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]

  struct ArchiveIndex: Encodable {
    var schemaVersion: Int
    var mediaType: String
    var manifests: [Descriptor]
  }
  let index = ArchiveIndex(
    schemaVersion: 2,
    mediaType: MediaType.ociIndex,
    manifests: [
      Descriptor(
        mediaType: manifestType, digest: image.manifest, size: Int64(manifestData.count),
        annotations: ["io.containerd.image.name": name, "org.opencontainers.image.ref.name": name])
    ])

  struct DockerManifestEntry: Encodable {
    var Config: String
    var RepoTags: [String]
    var Layers: [String]
  }
  let dockerManifest = [
    DockerManifestEntry(
      Config: "blobs/sha256/\(image.configDescriptor.digest.hex)",
      RepoTags: [name],
      Layers: image.layers.map { "blobs/sha256/\($0.digest.hex)" })
  ]

  guard FileManager.default.createFile(atPath: file.path, contents: nil) else {
    throw RefactorError(
      code: .INTERNAL,
      instructions: "jig could not create the Docker archive \(file.path). Check that the folder is writable, then "
        + "run again.")
  }
  let handle: FileHandle
  do {
    handle = try FileHandle(forWritingTo: file)
  } catch {
    throw RefactorError(
      code: .INTERNAL,
      instructions: "jig could not open the Docker archive \(file.path): \(error). Check that the folder is "
        + "writable, then run again.")
  }
  defer { try? handle.close() }

  var tar = TarWriter(handle: handle, name: "the Docker archive \(file.path)")
  try tar.addFile("oci-layout", data: Data(#"{"imageLayoutVersion":"1.0.0"}"#.utf8))
  try tar.addFile("index.json", data: try encoder.encode(index))
  try tar.addFile("manifest.json", data: try encoder.encode(dockerManifest))
  try tar.addDirectory("blobs")
  try tar.addDirectory("blobs/sha256")
  try tar.addFile("blobs/sha256/\(image.manifest.hex)", data: manifestData)
  // A layer may appear twice in a manifest (the same bytes at two places); its blob goes in once.
  var written: Set<Digest> = [image.manifest]
  for digest in [image.configDescriptor.digest] + image.layers.map(\.digest) {
    if written.contains(digest) { continue }
    written.insert(digest)
    try tar.addFile("blobs/sha256/\(digest.hex)", contentsOf: store.blobURL(digest))
  }
  try tar.finish()
}
