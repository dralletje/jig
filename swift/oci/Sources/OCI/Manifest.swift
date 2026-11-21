import Foundation
import Report

#if canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#endif

/// The media types of manifests and layers jig reads, OCI's and Docker's.
public enum MediaType {
  public static let ociManifest = "application/vnd.oci.image.manifest.v1+json"
  public static let ociIndex = "application/vnd.oci.image.index.v1+json"
  public static let dockerManifest = "application/vnd.docker.distribution.manifest.v2+json"
  public static let dockerList = "application/vnd.docker.distribution.manifest.list.v2+json"
  /// The `Accept` header of a manifest request: every manifest and index type we read.
  public static let accept = [ociManifest, ociIndex, dockerManifest, dockerList].joined(separator: ",")

  /// A gzip-compressed tar layer.
  public static func isGzipLayer(_ mediaType: String) -> Bool {
    mediaType == "application/vnd.oci.image.layer.v1.tar+gzip"
      || mediaType == "application/vnd.oci.image.layer.nondistributable.v1.tar+gzip"
      || mediaType == "application/vnd.docker.image.rootfs.diff.tar.gzip"
      || mediaType == "application/vnd.docker.image.rootfs.foreign.diff.tar.gzip"
  }

  /// An uncompressed tar layer.
  public static func isPlainLayer(_ mediaType: String) -> Bool {
    mediaType == "application/vnd.oci.image.layer.v1.tar"
      || mediaType == "application/vnd.oci.image.layer.nondistributable.v1.tar"
      || mediaType == "application/vnd.docker.image.rootfs.diff.tar"
  }

  /// A zstd-compressed tar layer, which jig does not read.
  public static func isZstdLayer(_ mediaType: String) -> Bool {
    mediaType == "application/vnd.oci.image.layer.v1.tar+zstd"
      || mediaType == "application/vnd.oci.image.layer.nondistributable.v1.tar+zstd"
  }
}

/// The platform an image runs on, as an index names it: `linux`/`arm64`/`v8`.
public struct Platform: Codable, Equatable, Sendable {
  public var os: String
  public var architecture: String
  public var variant: String?

  public init(os: String, architecture: String, variant: String? = nil) {
    self.os = os
    self.architecture = architecture
    self.variant = variant
  }

  /// This machine: `linux` and its architecture in OCI's words (`x86_64` is `amd64`, `aarch64` is
  /// `arm64`; any other as `uname -m` says it).
  public static let host: Platform = {
    var names = utsname()
    uname(&names)
    let machine = withUnsafeBytes(of: &names.machine) { bytes in
      String(decoding: bytes.prefix(while: { $0 != 0 }), as: UTF8.self)
    }
    if machine == "x86_64" {
      return Platform(os: "linux", architecture: "amd64")
    }
    if machine == "aarch64" {
      return Platform(os: "linux", architecture: "arm64")
    }
    return Platform(os: "linux", architecture: machine)
  }()
}

/// A reference to a blob or manifest: its type, digest and size, and in an index its platform.
public struct Descriptor: Codable, Equatable, Sendable {
  public var mediaType: String
  public var digest: Digest
  public var size: Int64
  public var platform: Platform?
  public var annotations: [String: String]?

  public init(
    mediaType: String, digest: Digest, size: Int64, platform: Platform? = nil, annotations: [String: String]? = nil
  ) {
    self.mediaType = mediaType
    self.digest = digest
    self.size = size
    self.platform = platform
    self.annotations = annotations
  }
}

/// One platform's image: its config blob and its layers, bottom first.
public struct ImageManifest: Codable, Equatable, Sendable {
  public var config: Descriptor
  public var layers: [Descriptor]

  public init(config: Descriptor, layers: [Descriptor]) {
    self.config = config
    self.layers = layers
  }
}

/// A multi-platform image: one manifest per platform (and attestations, as `unknown/unknown`).
public struct ImageIndex: Codable, Equatable, Sendable {
  public var manifests: [Descriptor]

  public init(manifests: [Descriptor]) {
    self.manifests = manifests
  }

  /// The manifest for `platform` (same os and architecture), or nil when the image has none. For
  /// arm64 one with variant `v8` or without a variant comes first. Attestations are never picked.
  public func manifest(for platform: Platform) -> Descriptor? {
    let candidates = manifests.filter { descriptor in
      guard let candidate = descriptor.platform else { return false }
      if candidate.os == "unknown" && candidate.architecture == "unknown" { return false }
      return candidate.os == platform.os && candidate.architecture == platform.architecture
    }
    if platform.architecture == "arm64" {
      let preferred = candidates.first { descriptor in
        descriptor.platform?.variant == "v8" || descriptor.platform?.variant == nil
      }
      if let preferred { return preferred }
    }
    return candidates.first
  }
}

/// A manifest as a registry sends it: one platform's image, or an index of them.
public enum ParsedManifest: Equatable, Sendable {
  case image(ImageManifest)
  case index(ImageIndex)

  /// `data` read as the type `mediaType` names (a `Content-Type`; parameters such as `charset` are
  /// ignored). When that is not a manifest type (`application/json`, empty), the body's own
  /// `mediaType` field says which it is.
  public static func parse(_ data: Data, mediaType: String) throws -> ParsedManifest {
    var type = String(mediaType.split(separator: ";", omittingEmptySubsequences: false)[0])
      .trimmingCharacters(in: .whitespaces)
    let known = [MediaType.ociManifest, MediaType.ociIndex, MediaType.dockerManifest, MediaType.dockerList]
    if !known.contains(type) {
      struct Body: Decodable { var mediaType: String? }
      if let body = try? JSONDecoder().decode(Body.self, from: data), let bodyType = body.mediaType {
        type = bodyType
      }
    }
    do {
      if type == MediaType.ociManifest || type == MediaType.dockerManifest {
        return .image(try JSONDecoder().decode(ImageManifest.self, from: data))
      }
      if type == MediaType.ociIndex || type == MediaType.dockerList {
        return .index(try JSONDecoder().decode(ImageIndex.self, from: data))
      }
    } catch {
      throw RefactorError(
        code: .INTERNAL,
        instructions: "The registry sent a \(type) manifest jig cannot read (\(error)). Check that the image "
          + "reference is right and the registry is a container registry, then run again; if it fails the same way, "
          + "report it as a jig bug.")
    }
    throw RefactorError(
      code: .INTERNAL,
      instructions: "The registry sent an unsupported manifest type \(type); jig reads OCI and Docker v2 "
        + "manifests and indexes only. Use an image published in one of those formats (a current docker push or "
        + "buildx push writes them).")
  }
}

/// The parts of an image's config blob a sandbox needs: `config.Entrypoint`, `config.Cmd` and
/// `config.Env`, each empty when the image leaves it out or sets it to null.
public struct ImageConfigFile: Codable, Equatable, Sendable {
  public var entrypoint: [String]
  public var cmd: [String]
  public var env: [String]

  public init(entrypoint: [String] = [], cmd: [String] = [], env: [String] = []) {
    self.entrypoint = entrypoint
    self.cmd = cmd
    self.env = env
  }

  private enum CodingKeys: String, CodingKey {
    case config
  }

  private enum ConfigKeys: String, CodingKey {
    case entrypoint = "Entrypoint"
    case cmd = "Cmd"
    case env = "Env"
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    guard container.contains(.config), try !container.decodeNil(forKey: .config) else {
      self.init()
      return
    }
    let config = try container.nestedContainer(keyedBy: ConfigKeys.self, forKey: .config)
    self.init(
      entrypoint: try config.decodeIfPresent([String].self, forKey: .entrypoint) ?? [],
      cmd: try config.decodeIfPresent([String].self, forKey: .cmd) ?? [],
      env: try config.decodeIfPresent([String].self, forKey: .env) ?? [])
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    var config = container.nestedContainer(keyedBy: ConfigKeys.self, forKey: .config)
    try config.encode(entrypoint, forKey: .entrypoint)
    try config.encode(cmd, forKey: .cmd)
    try config.encode(env, forKey: .env)
  }
}
