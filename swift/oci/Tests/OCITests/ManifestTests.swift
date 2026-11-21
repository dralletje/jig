import Foundation
import Report
import Testing

@testable import OCI

// Shaped like what Docker Hub serves for `node:26` today: two platforms, each with a BuildKit
// attestation manifest (`unknown/unknown`), and an arm v7 build.
private let ociIndexFixture = """
  {
    "manifests": [
      {
        "annotations": {
          "com.docker.official-images.bashbrew.arch": "amd64",
          "org.opencontainers.image.base.name": "buildpack-deps:bookworm",
          "org.opencontainers.image.created": "2026-11-12T19:33:42Z",
          "org.opencontainers.image.version": "26.2.0"
        },
        "digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "platform": {
          "architecture": "amd64",
          "os": "linux"
        },
        "size": 2318
      },
      {
        "annotations": {
          "com.docker.official-images.bashbrew.arch": "amd64",
          "vnd.docker.reference.digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
          "vnd.docker.reference.type": "attestation-manifest"
        },
        "digest": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "platform": {
          "architecture": "unknown",
          "os": "unknown"
        },
        "size": 841
      },
      {
        "digest": "sha256:3333333333333333333333333333333333333333333333333333333333333333",
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "platform": {
          "architecture": "arm",
          "os": "linux",
          "variant": "v7"
        },
        "size": 2318
      },
      {
        "annotations": {
          "com.docker.official-images.bashbrew.arch": "arm64v8"
        },
        "digest": "sha256:4444444444444444444444444444444444444444444444444444444444444444",
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "platform": {
          "architecture": "arm64",
          "os": "linux",
          "variant": "v8"
        },
        "size": 2318
      },
      {
        "annotations": {
          "vnd.docker.reference.digest": "sha256:4444444444444444444444444444444444444444444444444444444444444444",
          "vnd.docker.reference.type": "attestation-manifest"
        },
        "digest": "sha256:5555555555555555555555555555555555555555555555555555555555555555",
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "platform": {
          "architecture": "unknown",
          "os": "unknown"
        },
        "size": 841
      }
    ],
    "mediaType": "application/vnd.oci.image.index.v1+json",
    "schemaVersion": 2
  }
  """

// A Docker v2 manifest as `docker push` of a classic build writes it.
private let dockerManifestFixture = """
  {
     "schemaVersion": 2,
     "mediaType": "application/vnd.docker.distribution.manifest.v2+json",
     "config": {
        "mediaType": "application/vnd.docker.container.image.v1+json",
        "size": 7023,
        "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
     },
     "layers": [
        {
           "mediaType": "application/vnd.docker.image.rootfs.diff.tar.gzip",
           "size": 32654,
           "digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        },
        {
           "mediaType": "application/vnd.docker.image.rootfs.diff.tar.gzip",
           "size": 16724,
           "digest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
        }
     ]
  }
  """

// An OCI manifest as BuildKit writes it, with annotations on the manifest itself.
private let ociManifestFixture = """
  {
    "schemaVersion": 2,
    "mediaType": "application/vnd.oci.image.manifest.v1+json",
    "config": {
      "mediaType": "application/vnd.oci.image.config.v1+json",
      "digest": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      "size": 1502
    },
    "layers": [
      {
        "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
        "digest": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        "size": 3623807
      }
    ],
    "annotations": {
      "org.opencontainers.image.created": "2026-11-12T19:33:42Z"
    }
  }
  """

// A config blob of a node image: `Entrypoint` null, as `docker inspect` shows it.
private let imageConfigFixture = """
  {
    "architecture": "amd64",
    "config": {
      "Env": [
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "NODE_VERSION=26.2.0"
      ],
      "Entrypoint": null,
      "Cmd": ["node"],
      "WorkingDir": "/"
    },
    "created": "2026-11-12T19:33:42Z",
    "os": "linux",
    "rootfs": {
      "type": "layers",
      "diff_ids": ["sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"]
    }
  }
  """

private func data(_ text: String) -> Data { Data(text.utf8) }

private func digest(_ character: Character) -> Digest { Digest("sha256:" + String(repeating: character, count: 64))! }

@Test func indexPicksAmd64AndArm64SkippingAttestations() throws {
  let parsed = try ParsedManifest.parse(data(ociIndexFixture), mediaType: MediaType.ociIndex)
  guard case .index(let index) = parsed else {
    Issue.record("expected an index, got \(parsed)")
    return
  }
  #expect(index.manifests.count == 5)
  let amd64 = index.manifest(for: Platform(os: "linux", architecture: "amd64"))
  #expect(amd64?.digest == digest("1"))
  #expect(amd64?.size == 2318)
  #expect(amd64?.annotations?["org.opencontainers.image.version"] == "26.2.0")
  let arm64 = index.manifest(for: Platform(os: "linux", architecture: "arm64"))
  #expect(arm64?.digest == digest("4"))
  #expect(arm64?.platform == Platform(os: "linux", architecture: "arm64", variant: "v8"))
}

@Test func indexWithOnlyAnotherArchitectureHasNoManifestForEitherHost() throws {
  let json = """
    {
      "schemaVersion": 2,
      "mediaType": "application/vnd.oci.image.index.v1+json",
      "manifests": [
        {
          "mediaType": "application/vnd.oci.image.manifest.v1+json",
          "digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
          "size": 1000,
          "platform": {"architecture": "s390x", "os": "linux"}
        }
      ]
    }
    """
  let parsed = try ParsedManifest.parse(data(json), mediaType: MediaType.ociIndex)
  guard case .index(let index) = parsed else {
    Issue.record("expected an index, got \(parsed)")
    return
  }
  #expect(index.manifest(for: Platform(os: "linux", architecture: "amd64")) == nil)
  #expect(index.manifest(for: Platform(os: "linux", architecture: "arm64")) == nil)
}

@Test func arm64PrefersV8OrNoVariantOverOthers() {
  func entry(_ character: Character, variant: String?) -> Descriptor {
    Descriptor(
      mediaType: MediaType.dockerManifest, digest: digest(character), size: 1,
      platform: Platform(os: "linux", architecture: "arm64", variant: variant))
  }
  let arm64 = Platform(os: "linux", architecture: "arm64")
  #expect(ImageIndex(manifests: [entry("1", variant: "v9"), entry("2", variant: "v8")]).manifest(for: arm64)?.digest == digest("2"))
  #expect(ImageIndex(manifests: [entry("1", variant: "v9"), entry("2", variant: nil)]).manifest(for: arm64)?.digest == digest("2"))
  #expect(ImageIndex(manifests: [entry("1", variant: "v9")]).manifest(for: arm64)?.digest == digest("1"))
}

@Test func dockerListParsesAsIndex() throws {
  let json = """
    {
       "schemaVersion": 2,
       "mediaType": "application/vnd.docker.distribution.manifest.list.v2+json",
       "manifests": [
          {
             "mediaType": "application/vnd.docker.distribution.manifest.v2+json",
             "size": 7143,
             "digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
             "platform": {"architecture": "amd64", "os": "linux"}
          }
       ]
    }
    """
  let parsed = try ParsedManifest.parse(data(json), mediaType: MediaType.dockerList)
  guard case .index(let index) = parsed else {
    Issue.record("expected an index, got \(parsed)")
    return
  }
  #expect(index.manifest(for: Platform(os: "linux", architecture: "amd64"))?.digest == digest("1"))
}

@Test func dockerManifestParsesAsImage() throws {
  let parsed = try ParsedManifest.parse(data(dockerManifestFixture), mediaType: MediaType.dockerManifest)
  let expected = ImageManifest(
    config: Descriptor(
      mediaType: "application/vnd.docker.container.image.v1+json", digest: digest("a"), size: 7023),
    layers: [
      Descriptor(mediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip", digest: digest("b"), size: 32654),
      Descriptor(mediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip", digest: digest("c"), size: 16724),
    ])
  #expect(parsed == .image(expected))
}

@Test func ociManifestParsesAsImage() throws {
  let parsed = try ParsedManifest.parse(data(ociManifestFixture), mediaType: MediaType.ociManifest)
  guard case .image(let manifest) = parsed else {
    Issue.record("expected an image manifest, got \(parsed)")
    return
  }
  #expect(manifest.config.digest == digest("d"))
  #expect(manifest.config.mediaType == "application/vnd.oci.image.config.v1+json")
  #expect(manifest.layers.map(\.digest) == [digest("e")])
  #expect(manifest.layers.map(\.size) == [3_623_807])
}

@Test func genericContentTypeFallsBackToTheBodysMediaType() throws {
  let image = try ParsedManifest.parse(data(ociManifestFixture), mediaType: "application/json")
  guard case .image = image else {
    Issue.record("expected an image manifest, got \(image)")
    return
  }
  let index = try ParsedManifest.parse(data(ociIndexFixture), mediaType: "")
  guard case .index = index else {
    Issue.record("expected an index, got \(index)")
    return
  }
  // Parameters after the type do not make it generic.
  let withCharset = try ParsedManifest.parse(
    data(dockerManifestFixture), mediaType: "application/vnd.docker.distribution.manifest.v2+json; charset=utf-8")
  guard case .image = withCharset else {
    Issue.record("expected an image manifest, got \(withCharset)")
    return
  }
}

@Test func unsupportedManifestTypeIsInternal() {
  let schema1 = """
    {"schemaVersion": 1, "name": "library/node", "tag": "old", "fsLayers": []}
    """
  #expect {
    try ParsedManifest.parse(data(schema1), mediaType: "application/vnd.docker.distribution.manifest.v1+prettyjws")
  } throws: { error in
    let error = error as? RefactorError
    return error?.code == .INTERNAL
      && error?.instructions.contains("unsupported manifest type application/vnd.docker.distribution.manifest.v1+prettyjws")
        == true
  }
  let unknownBody = """
    {"schemaVersion": 2, "mediaType": "application/vnd.example.thing+json"}
    """
  #expect {
    try ParsedManifest.parse(data(unknownBody), mediaType: "application/json")
  } throws: { error in
    let error = error as? RefactorError
    return error?.code == .INTERNAL
      && error?.instructions.contains("unsupported manifest type application/vnd.example.thing+json") == true
  }
}

@Test func malformedManifestIsInternal() {
  #expect {
    try ParsedManifest.parse(data(#"{"config": 1}"#), mediaType: MediaType.ociManifest)
  } throws: { error in
    (error as? RefactorError)?.code == .INTERNAL
  }
}

@Test func configWithNullEntrypointAndCmd() throws {
  let config = try JSONDecoder().decode(ImageConfigFile.self, from: data(imageConfigFixture))
  #expect(config.entrypoint == [])
  #expect(config.cmd == ["node"])
  #expect(config.env == ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "NODE_VERSION=26.2.0"])
}

@Test func configWithoutConfigSectionIsEmpty() throws {
  let config = try JSONDecoder().decode(ImageConfigFile.self, from: data(#"{"architecture": "amd64", "os": "linux"}"#))
  #expect(config.entrypoint == [])
  #expect(config.cmd == [])
  #expect(config.env == [])
}

@Test func hostPlatformIsLinux() {
  #expect(Platform.host.os == "linux")
  #expect(["amd64", "arm64"].contains(Platform.host.architecture))
  #expect(Platform.host.variant == nil)
}

@Test func acceptListsAllFourTypes() {
  #expect(
    MediaType.accept
      == "application/vnd.oci.image.manifest.v1+json,application/vnd.oci.image.index.v1+json,"
      + "application/vnd.docker.distribution.manifest.v2+json,application/vnd.docker.distribution.manifest.list.v2+json")
}

@Test func layerMediaTypes() {
  #expect(MediaType.isGzipLayer("application/vnd.oci.image.layer.v1.tar+gzip"))
  #expect(MediaType.isGzipLayer("application/vnd.docker.image.rootfs.diff.tar.gzip"))
  #expect(MediaType.isPlainLayer("application/vnd.oci.image.layer.v1.tar"))
  #expect(MediaType.isZstdLayer("application/vnd.oci.image.layer.v1.tar+zstd"))
  #expect(!MediaType.isGzipLayer("application/vnd.oci.image.layer.v1.tar+zstd"))
  #expect(!MediaType.isPlainLayer("application/vnd.oci.image.layer.v1.tar+gzip"))
  #expect(!MediaType.isZstdLayer("application/vnd.oci.image.layer.v1.tar"))
}

@Test func descriptorRoundTripsWithoutNullFields() throws {
  let descriptor = Descriptor(mediaType: MediaType.ociManifest, digest: digest("1"), size: 42)
  let encoded = try JSONEncoder().encode(descriptor)
  let object = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]
  #expect(object?.keys.sorted() == ["digest", "mediaType", "size"])
  #expect(try JSONDecoder().decode(Descriptor.self, from: encoded) == descriptor)
}
