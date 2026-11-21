import Foundation
import Report
import Testing

@testable import OCI

let amd64 = Platform(os: "linux", architecture: "amd64")
let arm64 = Platform(os: "linux", architecture: "arm64")
let toolBase = "https://ghcr.io/v2/acme/tool"
let toolTagURL = "https://ghcr.io/v2/acme/tool/manifests/1.0"

/// One platform's image as a fake registry serves it: config, layers and the manifest naming them.
struct FakeImage {
  var config: Data
  var layers: [Data]
  var manifest: Data
  var layerMediaType: String

  var manifestDigest: Digest { SHA256Hasher.digest(manifest) }
  var configDigest: Digest { SHA256Hasher.digest(config) }
  var layerDigests: [Digest] { layers.map { SHA256Hasher.digest($0) } }

  init(
    architecture: String, cmd: String, layers: [String] = ["layer one", "layer two"],
    layerMediaType: String = "application/vnd.oci.image.layer.v1.tar+gzip"
  ) {
    config = Data(#"{"architecture":"\#(architecture)","os":"linux","config":{"Cmd":["\#(cmd)"]}}"#.utf8)
    self.layers = layers.map { Data($0.utf8) }
    self.layerMediaType = layerMediaType
    let configDigest = SHA256Hasher.digest(config)
    let layerEntries = self.layers.map { layer in
      #"{"mediaType":"\#(layerMediaType)","digest":"\#(SHA256Hasher.digest(layer))","size":\#(layer.count)}"#
    }
    manifest = Data(
      (#"{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"mediaType":"application/vnd.oci.image.config.v1+json","digest":"\#(configDigest)","size":\#(config.count)},"layers":["#
        + layerEntries.joined(separator: ",") + "]}").utf8)
  }

  /// Serves the manifest by digest and every blob, under `ghcr.io/acme/tool`.
  func serve(on fake: FakeTransport) {
    fake.on("\(toolBase)/manifests/\(manifestDigest)", .manifest(manifest, mediaType: MediaType.ociManifest))
    fake.on("\(toolBase)/blobs/\(configDigest)", .ok(config))
    for layer in layers {
      fake.on("\(toolBase)/blobs/\(SHA256Hasher.digest(layer))", .ok(layer))
    }
  }
}

/// An OCI index of `entries` (image, architecture), plus an attestation entry.
func fakeIndex(_ entries: [(FakeImage, String)]) -> Data {
  var items = entries.map { image, architecture in
    #"{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"\#(image.manifestDigest)","size":\#(image.manifest.count),"platform":{"architecture":"\#(architecture)","os":"linux"}}"#
  }
  items.append(
    #"{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"sha256:\#(referenceHex)","size":10,"platform":{"architecture":"unknown","os":"unknown"}}"#
  )
  return Data(
    (#"{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":["#
      + items.joined(separator: ",") + "]}").utf8)
}

func refactorError(_ body: () throws -> Void) -> RefactorError? {
  do {
    try body()
    return nil
  } catch let error as RefactorError {
    return error
  } catch {
    Issue.record("not a RefactorError: \(error)")
    return nil
  }
}

/// A multi-platform `ghcr.io/acme/tool:1.0` (amd64 and arm64) in a fake registry.
func multiPlatformTool(_ fake: FakeTransport) -> (amd: FakeImage, arm: FakeImage, index: Data) {
  let amd = FakeImage(architecture: "amd64", cmd: "amd")
  let arm = FakeImage(architecture: "arm64", cmd: "arm")
  amd.serve(on: fake)
  arm.serve(on: fake)
  let index = fakeIndex([(amd, "amd64"), (arm, "arm64")])
  fake.on(toolTagURL, .manifest(index, mediaType: MediaType.ociIndex))
  return (amd, arm, index)
}

@Test func tagPinsTheIndexAndRunsThePlatformManifest() throws {
  try withTemporaryStore { store, _ in
    let fake = FakeTransport()
    let tool = multiPlatformTool(fake)
    let client = RegistryClient(transport: fake)
    let reference = try ImageReference.parse("ghcr.io/acme/tool:1.0")

    let onAmd = try ImagePuller(store: store, client: client, platform: amd64).resolve(reference)
    #expect(onAmd.pinned == SHA256Hasher.digest(tool.index))
    #expect(onAmd.manifest == tool.amd.manifestDigest)
    #expect(onAmd.configDescriptor.digest == tool.amd.configDigest)
    #expect(onAmd.config.cmd == ["amd"])
    #expect(onAmd.layers.map(\.digest) == tool.amd.layerDigests)
    #expect(onAmd.note == nil)
    // The index, the platform manifest, the config and the layers are all in the store.
    for digest in [onAmd.pinned, onAmd.manifest, tool.amd.configDigest] + tool.amd.layerDigests {
      #expect(store.has(digest))
    }
    #expect(store.lastTag("ghcr.io/acme/tool:1.0")?.digest == onAmd.pinned)
    #expect(store.lastTag("ghcr.io/acme/tool:1.0")?.mediaType == MediaType.ociIndex)
    // Layers go to disk through `download`.
    #expect(fake.requests.filter { $0.request.url.absoluteString.contains("/blobs/") }.allSatisfy { $0.download })

    let onArm = try ImagePuller(store: store, client: client, platform: arm64).resolve(reference)
    #expect(onArm.pinned == onAmd.pinned)
    #expect(onArm.manifest == tool.arm.manifestDigest)
    #expect(onArm.config.cmd == ["arm"])
  }
}

@Test func unreachableRegistryFallsBackToTheTagDownloadedEarlier() throws {
  try withTemporaryStore { store, _ in
    let fake = FakeTransport()
    let tool = multiPlatformTool(fake)
    let puller = ImagePuller(store: store, client: RegistryClient(transport: fake), platform: amd64)
    let reference = try ImageReference.parse("ghcr.io/acme/tool:1.0")
    let first = try puller.resolve(reference)

    fake.removeAll()
    fake.fallback(.status(503))
    let second = try puller.resolve(reference)
    #expect(second.pinned == first.pinned)
    #expect(second.manifest == tool.amd.manifestDigest)
    #expect(second.layers == first.layers)
    #expect(
      second.note
        == "ghcr.io could not be reached (HTTP 503); used the copy of ghcr.io/acme/tool:1.0 downloaded earlier: "
        + "\(first.pinned)")
  }
}

@Test func refusingRegistryNeverFallsBack() throws {
  try withTemporaryStore { store, _ in
    let fake = FakeTransport()
    _ = multiPlatformTool(fake)
    let puller = ImagePuller(store: store, client: RegistryClient(transport: fake), platform: amd64)
    let reference = try ImageReference.parse("ghcr.io/acme/tool:1.0")
    _ = try puller.resolve(reference)

    fake.removeAll()
    fake.fallback(.status(400))
    let error = refactorError { _ = try puller.resolve(reference) }
    #expect(error?.code == .REGISTRY_UNAVAILABLE)
    #expect(
      error?.instructions
        == "ghcr.io refused to give ghcr.io/acme/tool:1.0 (unexpected HTTP 400 for manifest 1.0). Run again later; "
        + "if it keeps happening, the registry or a proxy in between is not working as a registry should.")
  }
}

@Test func oversizedManifestNeverFallsBack() throws {
  try withTemporaryStore { store, _ in
    let fake = FakeTransport()
    _ = multiPlatformTool(fake)
    let puller = ImagePuller(store: store, client: RegistryClient(transport: fake), platform: amd64)
    let reference = try ImageReference.parse("ghcr.io/acme/tool:1.0")
    _ = try puller.resolve(reference)

    fake.on(toolTagURL, .ok(Data(count: (4 << 20) + 1), headers: ["content-type": MediaType.ociIndex]))
    let error = refactorError { _ = try puller.resolve(reference) }
    #expect(error?.code == .REGISTRY_UNAVAILABLE)
    #expect(error?.instructions.contains("(manifest 1.0 is larger than 4194304 bytes)") == true)
  }
}

@Test func blobsAreBoundedByTheirDescriptorSizes() throws {
  try withTemporaryStore { store, _ in
    let fake = FakeTransport()
    let tool = multiPlatformTool(fake)
    _ = try ImagePuller(store: store, client: RegistryClient(transport: fake), platform: amd64)
      .resolve(try ImageReference.parse("ghcr.io/acme/tool:1.0"))
    var expected: [String: Int64] = ["\(toolBase)/blobs/\(tool.amd.configDigest)": Int64(tool.amd.config.count)]
    for layer in tool.amd.layers {
      expected["\(toolBase)/blobs/\(SHA256Hasher.digest(layer))"] = Int64(layer.count)
    }
    let downloads = fake.requests.filter { $0.download }
    #expect(downloads.count == 3)
    for download in downloads {
      #expect(download.limit == expected[download.request.url.absoluteString])
    }
  }
}

@Test func layerLargerThanItsDescriptorIsRegistryUnavailable() throws {
  try withTemporaryStore { store, _ in
    let fake = FakeTransport()
    let tool = multiPlatformTool(fake)
    fake.on("\(toolBase)/blobs/\(tool.amd.layerDigests[0])", .ok(Data("layer one, and then some".utf8)))
    let puller = ImagePuller(store: store, client: RegistryClient(transport: fake), platform: amd64)
    let error = refactorError { _ = try puller.resolve(try ImageReference.parse("ghcr.io/acme/tool:1.0")) }
    #expect(error?.code == .REGISTRY_UNAVAILABLE)
    #expect(
      error?.instructions.contains("(blob \(tool.amd.layerDigests[0]) is larger than the 9 bytes its descriptor gives)")
        == true)
    #expect(!store.has(tool.amd.layerDigests[0]))
    #expect(store.lastTag("ghcr.io/acme/tool:1.0") == nil)
  }
}

@Test func movedTagIsFollowed() throws {
  try withTemporaryStore { store, _ in
    let fake = FakeTransport()
    let tool = multiPlatformTool(fake)
    let puller = ImagePuller(store: store, client: RegistryClient(transport: fake), platform: amd64)
    let reference = try ImageReference.parse("ghcr.io/acme/tool:1.0")
    let first = try puller.resolve(reference)

    let newer = FakeImage(architecture: "amd64", cmd: "newer", layers: ["layer one", "layer three"])
    newer.serve(on: fake)
    let newIndex = fakeIndex([(newer, "amd64"), (tool.arm, "arm64")])
    fake.on(toolTagURL, .manifest(newIndex, mediaType: MediaType.ociIndex))
    let second = try puller.resolve(reference)
    #expect(second.pinned == SHA256Hasher.digest(newIndex))
    #expect(second.pinned != first.pinned)
    #expect(second.manifest == newer.manifestDigest)
    #expect(second.config.cmd == ["newer"])
    #expect(second.note == nil)
    #expect(store.lastTag("ghcr.io/acme/tool:1.0")?.digest == second.pinned)
  }
}

@Test func pinnedDigestInTheStoreNeedsNoRequest() throws {
  try withTemporaryStore { store, _ in
    let fake = FakeTransport()
    let tool = multiPlatformTool(fake)
    let puller = ImagePuller(store: store, client: RegistryClient(transport: fake), platform: amd64)
    let first = try puller.resolve(try ImageReference.parse("ghcr.io/acme/tool:1.0"))

    fake.removeAll()
    fake.fallback(.failure("network is down"))
    let before = fake.requests.count
    let pinned = try puller.resolve(try ImageReference.parse("ghcr.io/acme/tool:1.0@\(first.pinned)"))
    #expect(fake.requests.count == before)
    #expect(pinned.pinned == first.pinned)
    #expect(pinned.manifest == tool.amd.manifestDigest)
    #expect(pinned.config.cmd == ["amd"])
    #expect(pinned.note == nil)
  }
}

@Test func pinnedDigestWithALayerMissingNeverFallsBack() throws {
  try withTemporaryStore { store, _ in
    let fake = FakeTransport()
    let tool = multiPlatformTool(fake)
    let puller = ImagePuller(store: store, client: RegistryClient(transport: fake), platform: amd64)
    let first = try puller.resolve(try ImageReference.parse("ghcr.io/acme/tool:1.0"))
    try FileManager.default.removeItem(at: store.blobURL(tool.amd.layerDigests[1]))

    fake.removeAll()
    fake.fallback(.failure("network is down"))
    let error = refactorError {
      _ = try puller.resolve(try ImageReference.parse("ghcr.io/acme/tool:1.0@\(first.pinned)"))
    }
    #expect(error?.code == .REGISTRY_UNAVAILABLE)
    #expect(error?.instructions.contains("network is down") == true)
    #expect(!store.has(tool.amd.layerDigests[1]))
  }
}

@Test func pinnedIndexDigestDownloadsTheHostPlatformManifest() throws {
  try withTemporaryStore { store, _ in
    let fake = FakeTransport()
    let tool = multiPlatformTool(fake)
    let indexDigest = SHA256Hasher.digest(tool.index)
    fake.on("\(toolBase)/manifests/\(indexDigest)", .manifest(tool.index, mediaType: MediaType.ociIndex))
    let puller = ImagePuller(store: store, client: RegistryClient(transport: fake), platform: arm64)

    let resolved = try puller.resolve(try ImageReference.parse("ghcr.io/acme/tool@\(indexDigest)"))
    #expect(resolved.pinned == indexDigest)
    #expect(resolved.manifest == tool.arm.manifestDigest)
    #expect(resolved.config.cmd == ["arm"])
    #expect(!fake.urls.contains(toolTagURL))
    for digest in [indexDigest, tool.arm.manifestDigest, tool.arm.configDigest] + tool.arm.layerDigests {
      #expect(store.has(digest))
    }
  }
}

@Test func unreachableRegistryForATagNeverSeenFails() throws {
  try withTemporaryStore { store, _ in
    let fake = FakeTransport()
    fake.fallback(.status(503))
    let puller = ImagePuller(store: store, client: RegistryClient(transport: fake), platform: amd64)
    let error = refactorError { _ = try puller.resolve(try ImageReference.parse("ghcr.io/acme/tool:1.0")) }
    #expect(error?.code == .REGISTRY_UNAVAILABLE)
    #expect(error?.instructions.contains("ghcr.io could not be reached (HTTP 503)") == true)
  }
}

@Test func unknownRepositoryIsNotFoundWithLocalhostInstructions() throws {
  try withTemporaryStore { store, _ in
    let fake = FakeTransport()
    let puller = ImagePuller(store: store, client: RegistryClient(transport: fake), platform: amd64)
    let error = refactorError { _ = try puller.resolve(try ImageReference.parse("ghcr.io/acme/nothing:1.0")) }
    #expect(error?.code == .IMAGE_NOT_FOUND)
    #expect(
      error?.instructions
        == "There is no image ghcr.io/acme/nothing:1.0 in its registry, or it is private (jig only downloads public "
        + "images). For an image in local Docker, tag it localhost/acme/nothing and use that name; otherwise push it.")
  }
}

@Test func indexWithoutThisPlatformIsNotFound() throws {
  try withTemporaryStore { store, _ in
    let fake = FakeTransport()
    let s390x = FakeImage(architecture: "s390x", cmd: "big")
    s390x.serve(on: fake)
    fake.on(toolTagURL, .manifest(fakeIndex([(s390x, "s390x")]), mediaType: MediaType.ociIndex))
    let puller = ImagePuller(store: store, client: RegistryClient(transport: fake), platform: amd64)
    let error = refactorError { _ = try puller.resolve(try ImageReference.parse("ghcr.io/acme/tool:1.0")) }
    #expect(error?.code == .IMAGE_NOT_FOUND)
    #expect(error?.instructions == "ghcr.io/acme/tool:1.0 has no linux/amd64 build.")
    #expect(store.lastTag("ghcr.io/acme/tool:1.0") == nil)
  }
}

@Test func singlePlatformTagPinsItsManifest() throws {
  try withTemporaryStore { store, _ in
    let fake = FakeTransport()
    let image = FakeImage(architecture: "amd64", cmd: "only")
    image.serve(on: fake)
    fake.on(toolTagURL, .manifest(image.manifest, mediaType: MediaType.ociManifest))
    let reference = try ImageReference.parse("ghcr.io/acme/tool:1.0")

    let resolved = try ImagePuller(store: store, client: RegistryClient(transport: fake), platform: amd64)
      .resolve(reference)
    #expect(resolved.pinned == image.manifestDigest)
    #expect(resolved.manifest == image.manifestDigest)
    #expect(resolved.config.cmd == ["only"])
    #expect(store.lastTag("ghcr.io/acme/tool:1.0")?.mediaType == MediaType.ociManifest)

    // The same image on arm64: its config says amd64.
    let error = refactorError {
      _ = try ImagePuller(store: store, client: RegistryClient(transport: fake), platform: arm64).resolve(reference)
    }
    #expect(error?.code == .IMAGE_NOT_FOUND)
    #expect(error?.instructions == "ghcr.io/acme/tool:1.0 has no linux/arm64 build.")
  }
}

@Test func zstdLayersAreRefused() throws {
  try withTemporaryStore { store, _ in
    let fake = FakeTransport()
    let image = FakeImage(
      architecture: "amd64", cmd: "z", layerMediaType: "application/vnd.oci.image.layer.v1.tar+zstd")
    image.serve(on: fake)
    fake.on(toolTagURL, .manifest(image.manifest, mediaType: MediaType.ociManifest))
    let puller = ImagePuller(store: store, client: RegistryClient(transport: fake), platform: amd64)
    let error = refactorError { _ = try puller.resolve(try ImageReference.parse("ghcr.io/acme/tool:1.0")) }
    #expect(error?.code == .INTERNAL)
    #expect(error?.instructions == "ghcr.io/acme/tool:1.0 has zstd-compressed layers, which jig does not support yet.")
    for digest in image.layerDigests {
      #expect(!store.has(digest))
    }
  }
}

@Test func damagedBlobIsRegistryUnavailable() throws {
  try withTemporaryStore { store, _ in
    let fake = FakeTransport()
    let tool = multiPlatformTool(fake)
    fake.on("\(toolBase)/blobs/\(tool.amd.layerDigests[0])", .ok(Data("damaged".utf8)))
    let puller = ImagePuller(store: store, client: RegistryClient(transport: fake), platform: amd64)
    let error = refactorError { _ = try puller.resolve(try ImageReference.parse("ghcr.io/acme/tool:1.0")) }
    #expect(error?.code == .REGISTRY_UNAVAILABLE)
    #expect(!store.has(tool.amd.layerDigests[0]))
    #expect(store.lastTag("ghcr.io/acme/tool:1.0") == nil)
  }
}

@Test func pinnedReferenceAddsTheDigestOnce() throws {
  try withTemporaryStore { store, _ in
    let puller = ImagePuller(store: store, client: RegistryClient(transport: FakeTransport()), platform: amd64)
    let pinned = Digest("sha256:" + referenceHex)!
    let config = Descriptor(mediaType: "application/vnd.oci.image.config.v1+json", digest: pinned, size: 2)
    let resolved = ResolvedImage(
      pinned: pinned, manifest: pinned, configDescriptor: config, config: ImageConfigFile(), layers: [])
    #expect(puller.pinnedReference(typed: "node:26", resolved) == "node:26@\(pinned)")
    #expect(puller.pinnedReference(typed: "ghcr.io/a/b:1@\(pinned)", resolved) == "ghcr.io/a/b:1@\(pinned)")
  }
}
