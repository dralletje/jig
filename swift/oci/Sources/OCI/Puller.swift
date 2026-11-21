import Foundation
import Report

/// Resolves registry references to images in the store: asks the registry what a tag points to,
/// downloads what the store does not have yet, and remembers tag → digest. A tag whose registry
/// cannot be reached falls back to the copy downloaded earlier; a pinned digest never falls back.
public struct ImagePuller: Sendable {
  /// Where the images go; also where a sandbox makes its temporary files (`temporaryFile()`).
  public let store: OCIStore
  let client: RegistryClient
  let platform: Platform

  public init(store: OCIStore, client: RegistryClient, platform: Platform = .host) {
    self.store = store
    self.client = client
    self.platform = platform
  }

  /// `ref` resolved for `platform`, with its manifest, config and layers in the store. Throws
  /// `RefactorError`: `IMAGE_NOT_FOUND` when the registry does not have it (or it is private) or it has
  /// no build for this platform, `REGISTRY_UNAVAILABLE` when the registry cannot be reached, refuses
  /// with an unexpected answer or sends damaged data, `INTERNAL` for zstd layers. Only an unreachable
  /// registry (`RegistryError.unavailable`) makes a tag fall back.
  public func resolve(_ ref: ImageReference) throws -> ResolvedImage {
    if let digest = ref.digest {
      // A pinned digest (a replay): the store when it has everything, else the registry. No fallback.
      if let stored = try fromStore(ref, digest) { return stored }
      do {
        var manifestData: Data
        var manifestType = ""
        if store.has(digest) {
          manifestData = try readBlob(digest)
        } else {
          let fetched = try client.manifest(ref, digest.description)
          manifestData = fetched.data
          manifestType = fetched.mediaType
        }
        return try download(ref, pinned: digest, manifestData, manifestType)
      } catch let error as RegistryError {
        throw refactorError(error, ref)
      }
    }

    guard let tag = ref.tag, let taggedName = ref.taggedName else {
      throw RefactorError(
        code: .INTERNAL,
        instructions: "The image reference \(displayName(ref)) has neither a tag nor a digest. Report it as a jig bug.")
    }

    let fetched: (digest: Digest, mediaType: String, data: Data)
    do {
      fetched = try client.manifest(ref, tag)
    } catch RegistryError.unavailable(let reason) {
      guard let last = store.lastTag(taggedName), var stored = try fromStore(ref, last.digest) else {
        throw refactorError(.unavailable(reason), ref)
      }
      stored.note =
        "\(ref.registry) could not be reached (\(reason)); used the copy of \(taggedName) downloaded earlier: "
        + "\(stored.pinned)"
      return stored
    } catch let error as RegistryError {
      throw refactorError(error, ref)
    }

    let resolved: ResolvedImage
    do {
      resolved = try download(ref, pinned: fetched.digest, fetched.data, fetched.mediaType)
    } catch let error as RegistryError {
      throw refactorError(error, ref)
    }
    let parsed = try parseManifest(fetched.data, fetched.mediaType)
    var recordedType = fetched.mediaType
    let known = [MediaType.ociManifest, MediaType.ociIndex, MediaType.dockerManifest, MediaType.dockerList]
    if !known.contains(recordedType) {
      if case .index = parsed {
        recordedType = MediaType.ociIndex
      } else {
        recordedType = MediaType.ociManifest
      }
    }
    try store.recordTag(
      taggedName, Descriptor(mediaType: recordedType, digest: fetched.digest, size: Int64(fetched.data.count)))
    return resolved
  }

  /// The reference the commit records: `typed` as it is when it already names a digest, else
  /// `<typed>@<pinned>`.
  public func pinnedReference(typed: String, _ resolved: ResolvedImage) -> String {
    if typed.contains("@") { return typed }
    return "\(typed)@\(resolved.pinned)"
  }

  // MARK: - From the store

  /// `pinned` resolved from the store alone, or nil when the store does not have all of it (the
  /// pinned manifest or index, the platform manifest, its config and every layer).
  private func fromStore(_ ref: ImageReference, _ pinned: Digest) throws -> ResolvedImage? {
    guard store.has(pinned) else { return nil }
    let pinnedData = try readBlob(pinned)
    let manifestDigest: Digest
    let image: ImageManifest
    switch try parseManifest(pinnedData, "") {
    case .index(let index):
      guard let entry = index.manifest(for: platform) else { throw noBuild(ref) }
      guard store.has(entry.digest) else { return nil }
      guard case .image(let platformImage) = try parseManifest(try readBlob(entry.digest), entry.mediaType) else {
        throw nestedIndex(ref)
      }
      manifestDigest = entry.digest
      image = platformImage
    case .image(let single):
      manifestDigest = pinned
      image = single
    }
    guard store.has(image.config.digest) else { return nil }
    for layer in image.layers {
      guard store.has(layer.digest) else { return nil }
    }
    let config = try readConfig(ref, image.config.digest, checkPlatform: manifestDigest == pinned)
    try refuseZstd(ref, image)
    return ResolvedImage(
      pinned: pinned, manifest: manifestDigest, configDescriptor: image.config, config: config, layers: image.layers)
  }

  // MARK: - From the registry

  /// Stores the pinned manifest or index `pinnedData` and downloads what the store is missing: the
  /// platform manifest (for an index), the config, then the layers. Throws `RegistryError` for the
  /// registry's failures, `RefactorError` for everything else.
  private func download(_ ref: ImageReference, pinned: Digest, _ pinnedData: Data, _ mediaType: String) throws
    -> ResolvedImage
  {
    try store.put(pinnedData, as: pinned)
    let manifestDigest: Digest
    let image: ImageManifest
    switch try parseManifest(pinnedData, mediaType) {
    case .index(let index):
      guard let entry = index.manifest(for: platform) else { throw noBuild(ref) }
      var platformData: Data
      var platformType = entry.mediaType
      if store.has(entry.digest) {
        platformData = try readBlob(entry.digest)
      } else {
        let fetched = try client.manifest(ref, entry.digest.description)
        platformData = fetched.data
        platformType = fetched.mediaType
        try store.put(platformData, as: entry.digest)
      }
      guard case .image(let platformImage) = try parseManifest(platformData, platformType) else {
        throw nestedIndex(ref)
      }
      manifestDigest = entry.digest
      image = platformImage
    case .image(let single):
      manifestDigest = pinned
      image = single
    }

    try downloadBlob(ref, image.config)
    let config = try readConfig(ref, image.config.digest, checkPlatform: manifestDigest == pinned)
    try refuseZstd(ref, image)
    for layer in image.layers {
      try downloadBlob(ref, layer)
    }
    return ResolvedImage(
      pinned: pinned, manifest: manifestDigest, configDescriptor: image.config, config: config, layers: image.layers)
  }

  /// Downloads the blob `descriptor` names into the store, unless it is there already; no more than
  /// the descriptor's size.
  private func downloadBlob(_ ref: ImageReference, _ descriptor: Descriptor) throws {
    if store.has(descriptor.digest) { return }
    let file = try store.temporaryFile()
    do {
      try client.downloadBlob(ref, descriptor.digest, size: descriptor.size, to: file)
    } catch {
      try? FileManager.default.removeItem(at: file)
      throw error
    }
    try store.adopt(file, as: descriptor.digest)
  }

  // MARK: - Reading

  private func readBlob(_ digest: Digest) throws -> Data {
    do {
      return try Data(contentsOf: store.blobURL(digest))
    } catch {
      throw RefactorError(
        code: .INTERNAL,
        instructions: "jig could not read \(store.blobURL(digest).path) from its image store: \(error). Check "
          + "that the folder is readable, then run again.")
    }
  }

  /// `data` as a manifest or index. A stored manifest has no `Content-Type` and may leave out its
  /// `mediaType` field (OCI allows that): then it is an index when it lists `manifests`.
  private func parseManifest(_ data: Data, _ mediaType: String) throws -> ParsedManifest {
    let known = [MediaType.ociManifest, MediaType.ociIndex, MediaType.dockerManifest, MediaType.dockerList]
    if known.contains(mediaType) {
      return try ParsedManifest.parse(data, mediaType: mediaType)
    }
    struct Shape: Decodable {
      var mediaType: String?
      var manifests: [Descriptor]?
    }
    if let shape = try? JSONDecoder().decode(Shape.self, from: data), shape.mediaType == nil {
      if shape.manifests != nil {
        return try ParsedManifest.parse(data, mediaType: MediaType.ociIndex)
      }
      return try ParsedManifest.parse(data, mediaType: MediaType.ociManifest)
    }
    return try ParsedManifest.parse(data, mediaType: mediaType)
  }

  /// The stored config blob `digest`, read. For a single-platform image (`checkPlatform`), its `os` and
  /// `architecture` must be this platform's.
  private func readConfig(_ ref: ImageReference, _ digest: Digest, checkPlatform: Bool) throws -> ImageConfigFile {
    let data = try readBlob(digest)
    let config: ImageConfigFile
    do {
      config = try JSONDecoder().decode(ImageConfigFile.self, from: data)
    } catch {
      throw RefactorError(
        code: .INTERNAL,
        instructions: "The config of \(displayName(ref)) (\(digest)) cannot be read: \(error). Check that the "
          + "image was built by a container build tool; if it was, report it as a jig bug.")
    }
    if checkPlatform {
      struct ConfigPlatform: Decodable {
        var os: String?
        var architecture: String?
      }
      let configPlatform = try? JSONDecoder().decode(ConfigPlatform.self, from: data)
      if let os = configPlatform?.os, os != platform.os {
        throw noBuild(ref)
      }
      if let architecture = configPlatform?.architecture, architecture != platform.architecture {
        throw noBuild(ref)
      }
    }
    return config
  }

  private func refuseZstd(_ ref: ImageReference, _ image: ImageManifest) throws {
    for layer in image.layers {
      if MediaType.isZstdLayer(layer.mediaType) {
        throw RefactorError(
          code: .INTERNAL,
          instructions: "\(displayName(ref)) has zstd-compressed layers, which jig does not support yet.")
      }
    }
  }

  // MARK: - Errors

  /// `ref` as it reads normalized: `<registry>/<repository>[:<tag>][@<digest>]`.
  private func displayName(_ ref: ImageReference) -> String {
    var text = ref.taggedName ?? ref.name
    if let digest = ref.digest { text += "@\(digest)" }
    return text
  }

  private func noBuild(_ ref: ImageReference) -> RefactorError {
    RefactorError(
      code: .IMAGE_NOT_FOUND,
      instructions: "\(displayName(ref)) has no \(platform.os)/\(platform.architecture) build.")
  }

  private func nestedIndex(_ ref: ImageReference) -> RefactorError {
    RefactorError(
      code: .INTERNAL,
      instructions: "The \(platform.os)/\(platform.architecture) entry of \(displayName(ref))'s index is "
        + "itself an index, which jig does not read. Use an image whose index lists platform manifests.")
  }

  private func refactorError(_ error: RegistryError, _ ref: ImageReference) -> RefactorError {
    switch error {
    case .notFound:
      return RefactorError(
        code: .IMAGE_NOT_FOUND,
        instructions: "There is no image \(displayName(ref)) in its registry, or it is private (jig only "
          + "downloads public images). For an image in local Docker, tag it localhost/\(ref.repository) and use "
          + "that name; otherwise push it.")
    case .unavailable(let reason):
      return RefactorError(
        code: .REGISTRY_UNAVAILABLE,
        instructions: "\(ref.registry) could not be reached (\(reason)) to get \(displayName(ref)). Check the "
          + "network connection and run again later.")
    case .refused(let reason):
      return RefactorError(
        code: .REGISTRY_UNAVAILABLE,
        instructions: "\(ref.registry) refused to give \(displayName(ref)) (\(reason)). Run again later; if it "
          + "keeps happening, the registry or a proxy in between is not working as a registry should.")
    case .digestMismatch(let expected, let actual):
      return RefactorError(
        code: .REGISTRY_UNAVAILABLE,
        instructions: "\(ref.registry) sent bytes for \(displayName(ref)) that do not match \(expected) (they are "
          + "\(actual)); nothing was stored. Run again later; if it keeps happening, the registry or a proxy in "
          + "between is serving damaged data.")
    }
  }
}
