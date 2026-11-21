import Foundation
import Testing

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

@testable import OCI

let ghcrManifestURL = "https://ghcr.io/v2/acme/tool/manifests/1.0"
let sampleManifest = Data(
  #"{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"mediaType":"application/vnd.oci.image.config.v1+json","digest":"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","size":2},"layers":[]}"#
    .utf8)

func temporaryBlobFile() -> URL {
  FileManager.default.temporaryDirectory.appendingPathComponent("oci-blob-\(UUID().uuidString)")
}

func registryError(_ body: () throws -> Void) -> RegistryError? {
  do {
    try body()
    return nil
  } catch let error as RegistryError {
    return error
  } catch {
    Issue.record("not a RegistryError: \(error)")
    return nil
  }
}

@Test func anonymousTokenFlowAgainstGhcr() throws {
  let fake = FakeTransport()
  fake.on(
    ghcrManifestURL, .unauthorized(realm: "https://ghcr.io/token", service: "ghcr.io"),
    .manifest(sampleManifest, mediaType: MediaType.ociManifest))
  fake.on("https://ghcr.io/token", .token("abc"))
  let client = RegistryClient(transport: fake)
  let reference = try ImageReference.parse("ghcr.io/acme/tool:1.0")

  let manifest = try client.manifest(reference, "1.0")
  #expect(manifest.digest == SHA256Hasher.digest(sampleManifest))
  #expect(manifest.mediaType == MediaType.ociManifest)
  #expect(manifest.data == sampleManifest)

  let requests = fake.requests
  #expect(requests.count == 3)
  #expect(requests[0].request.url.absoluteString == ghcrManifestURL)
  #expect(requests[0].request.headers["Authorization"] == nil)
  #expect(requests[0].request.headers["Accept"] == MediaType.accept)
  let tokenURL = try #require(URLComponents(url: requests[1].request.url, resolvingAgainstBaseURL: false))
  #expect(tokenURL.host == "ghcr.io")
  #expect(tokenURL.path == "/token")
  #expect(tokenURL.queryItems?.first(where: { $0.name == "service" })?.value == "ghcr.io")
  #expect(tokenURL.queryItems?.first(where: { $0.name == "scope" })?.value == "repository:acme/tool:pull")
  #expect(requests[1].request.headers["Authorization"] == nil)
  #expect(requests[2].request.url.absoluteString == ghcrManifestURL)
  #expect(requests[2].request.headers["Authorization"] == "Bearer abc")

  // The token is kept: the next request carries it at once.
  _ = try client.manifest(reference, "1.0")
  #expect(fake.requests.count == 4)
  #expect(fake.requests[3].request.headers["Authorization"] == "Bearer abc")
}

@Test func tokenServiceMayAnswerWithAccessToken() throws {
  let fake = FakeTransport()
  fake.on(
    ghcrManifestURL, .unauthorized(realm: "https://ghcr.io/token", service: "ghcr.io"),
    .manifest(sampleManifest, mediaType: MediaType.ociManifest))
  fake.on("https://ghcr.io/token", .ok(Data(#"{"access_token":"xyz"}"#.utf8)))
  _ = try RegistryClient(transport: fake).manifest(try ImageReference.parse("ghcr.io/acme/tool:1.0"), "1.0")
  #expect(fake.requests.last?.request.headers["Authorization"] == "Bearer xyz")
}

@Test func dockerHubUsesRegistry1() throws {
  let fake = FakeTransport()
  fake.on(
    "https://registry-1.docker.io/v2/library/node/manifests/26",
    .manifest(sampleManifest, mediaType: MediaType.ociManifest))
  _ = try RegistryClient(transport: fake).manifest(try ImageReference.parse("node:26"), "26")
  #expect(fake.urls == ["https://registry-1.docker.io/v2/library/node/manifests/26"])
}

@Test func localRegistryUsesPlainHTTP() throws {
  let fake = FakeTransport()
  fake.on("http://localhost:5000/v2/x/y/manifests/latest", .manifest(sampleManifest, mediaType: MediaType.ociManifest))
  _ = try RegistryClient(transport: fake).manifest(try ImageReference.parse("localhost:5000/x/y"), "latest")
  #expect(fake.urls == ["http://localhost:5000/v2/x/y/manifests/latest"])
}

@Test func mediaTypeParametersAreDropped() throws {
  let fake = FakeTransport()
  fake.on(ghcrManifestURL, .ok(sampleManifest, headers: ["content-type": "application/json; charset=utf-8"]))
  let manifest = try RegistryClient(transport: fake).manifest(try ImageReference.parse("ghcr.io/acme/tool:1.0"), "1.0")
  #expect(manifest.mediaType == "application/json")
}

@Test func missingManifestIsNotFound() throws {
  let fake = FakeTransport()
  fake.on(ghcrManifestURL, .status(404))
  let error = registryError {
    _ = try RegistryClient(transport: fake).manifest(try ImageReference.parse("ghcr.io/acme/tool:1.0"), "1.0")
  }
  guard case .notFound = error else {
    Issue.record("expected notFound, got \(String(describing: error))")
    return
  }
}

@Test func unauthorizedAfterTheTokenIsNotFound() throws {
  let fake = FakeTransport()
  fake.on(ghcrManifestURL, .unauthorized(realm: "https://ghcr.io/token", service: "ghcr.io"))
  fake.on("https://ghcr.io/token", .token("abc"))
  let error = registryError {
    _ = try RegistryClient(transport: fake).manifest(try ImageReference.parse("ghcr.io/acme/tool:1.0"), "1.0")
  }
  guard case .notFound = error else {
    Issue.record("expected notFound, got \(String(describing: error))")
    return
  }
  // Asked once, got a token, asked once more: no loop.
  #expect(fake.requests.count == 3)
}

@Test func forbiddenIsNotFound() throws {
  let fake = FakeTransport()
  fake.on(ghcrManifestURL, .status(403))
  let error = registryError {
    _ = try RegistryClient(transport: fake).manifest(try ImageReference.parse("ghcr.io/acme/tool:1.0"), "1.0")
  }
  guard case .notFound = error else {
    Issue.record("expected notFound, got \(String(describing: error))")
    return
  }
}

@Test(arguments: [FakeReply.status(503), FakeReply.status(500), FakeReply.status(429), FakeReply.failure("timed out")])
func unreachableRegistryIsUnavailable(reply: FakeReply) throws {
  let fake = FakeTransport()
  fake.on(ghcrManifestURL, reply)
  let error = registryError {
    _ = try RegistryClient(transport: fake).manifest(try ImageReference.parse("ghcr.io/acme/tool:1.0"), "1.0")
  }
  guard case .unavailable = error else {
    Issue.record("expected unavailable, got \(String(describing: error))")
    return
  }
}

/// Only the network, 5xx and 429 mean "unreachable"; any other status is the registry refusing, which
/// must not look like an outage (that would fall back to a cached tag).
@Test(arguments: [400, 405, 418, 304])
func unexpectedStatusIsRefusedNotUnavailable(status: Int) throws {
  let fake = FakeTransport()
  fake.on(ghcrManifestURL, .status(status))
  let error = registryError {
    _ = try RegistryClient(transport: fake).manifest(try ImageReference.parse("ghcr.io/acme/tool:1.0"), "1.0")
  }
  #expect(error == .refused("unexpected HTTP \(status) for manifest 1.0"))
}

@Test func tokenAnswerWithoutATokenIsRefusedNotUnavailable() throws {
  let fake = FakeTransport()
  fake.on(ghcrManifestURL, .unauthorized(realm: "https://ghcr.io/token", service: "ghcr.io"))
  fake.on("https://ghcr.io/token", .ok(Data(#"{"nothing":"here"}"#.utf8)))
  let error = registryError {
    _ = try RegistryClient(transport: fake).manifest(try ImageReference.parse("ghcr.io/acme/tool:1.0"), "1.0")
  }
  #expect(error == .refused("the token service sent no token"))
}

@Test func unreachableTokenServiceIsUnavailable() throws {
  let fake = FakeTransport()
  fake.on(ghcrManifestURL, .unauthorized(realm: "https://ghcr.io/token", service: "ghcr.io"))
  fake.on("https://ghcr.io/token", .failure("connection refused"))
  let error = registryError {
    _ = try RegistryClient(transport: fake).manifest(try ImageReference.parse("ghcr.io/acme/tool:1.0"), "1.0")
  }
  #expect(error == .unavailable("connection refused"))
}

@Test func tagManifestWithWrongContentDigestIsAMismatch() throws {
  let fake = FakeTransport()
  let wrong = Digest("sha256:" + referenceHex)!
  fake.on(
    ghcrManifestURL,
    .ok(sampleManifest, headers: ["content-type": MediaType.ociManifest, "docker-content-digest": wrong.description]))
  let error = registryError {
    _ = try RegistryClient(transport: fake).manifest(try ImageReference.parse("ghcr.io/acme/tool:1.0"), "1.0")
  }
  #expect(error == .digestMismatch(expected: wrong, actual: SHA256Hasher.digest(sampleManifest)))
}

@Test func manifestByDigestMustHashToIt() throws {
  let fake = FakeTransport()
  let asked = Digest("sha256:" + referenceHex)!
  // No Docker-Content-Digest: the body alone must match what was asked for.
  fake.on("https://ghcr.io/v2/acme/tool/manifests/\(asked)", .ok(sampleManifest))
  let error = registryError {
    _ = try RegistryClient(transport: fake).manifest(try ImageReference.parse("ghcr.io/acme/tool:1.0"), asked.description)
  }
  #expect(error == .digestMismatch(expected: asked, actual: SHA256Hasher.digest(sampleManifest)))

  let right = SHA256Hasher.digest(sampleManifest)
  fake.on("https://ghcr.io/v2/acme/tool/manifests/\(right)", .ok(sampleManifest))
  let manifest = try RegistryClient(transport: fake).manifest(
    try ImageReference.parse("ghcr.io/acme/tool:1.0"), right.description)
  #expect(manifest.digest == right)
}

@Test func blobDownloadsAfterTheTokenFlow() throws {
  let fake = FakeTransport()
  let blob = Data("layer bytes".utf8)
  let digest = SHA256Hasher.digest(blob)
  let blobURL = "https://ghcr.io/v2/acme/tool/blobs/\(digest)"
  // The 401's body is longer than the blob: the size bounds only the blob itself.
  fake.on(
    blobURL,
    .status(
      401, headers: ["www-authenticate": #"Bearer realm="https://ghcr.io/token",service="ghcr.io""#],
      body: Data(#"{"errors":[{"code":"UNAUTHORIZED","message":"authentication required"}]}"#.utf8)),
    .ok(blob))
  fake.on("https://ghcr.io/token", .token("abc"))
  let file = temporaryBlobFile()
  defer { try? FileManager.default.removeItem(at: file) }

  try RegistryClient(transport: fake).downloadBlob(
    try ImageReference.parse("ghcr.io/acme/tool:1.0"), digest, size: Int64(blob.count), to: file)
  #expect(try Data(contentsOf: file) == blob)
  let blobRequests = fake.requests.filter { $0.request.url.absoluteString == blobURL }
  #expect(blobRequests.count == 2)
  #expect(blobRequests.allSatisfy { $0.download })
  #expect(blobRequests.allSatisfy { $0.limit == Int64(blob.count) })
  #expect(blobRequests[1].request.headers["Authorization"] == "Bearer abc")
}

@Test func blobLargerThanItsSizeIsRefusedAndDeleted() throws {
  let fake = FakeTransport()
  let blob = Data("layer bytes".utf8)
  let digest = SHA256Hasher.digest(blob)
  fake.on("https://ghcr.io/v2/acme/tool/blobs/\(digest)", .ok(blob))
  let file = temporaryBlobFile()
  defer { try? FileManager.default.removeItem(at: file) }

  let error = registryError {
    try RegistryClient(transport: fake).downloadBlob(
      try ImageReference.parse("ghcr.io/acme/tool:1.0"), digest, size: 5, to: file)
  }
  #expect(error == .refused("blob \(digest) is larger than the 5 bytes its descriptor gives"))
  #expect(!FileManager.default.fileExists(atPath: file.path))
}

@Test func blobShorterThanItsSizeIsRefusedAndDeleted() throws {
  let fake = FakeTransport()
  let blob = Data("layer bytes".utf8)
  let digest = SHA256Hasher.digest(blob)
  fake.on("https://ghcr.io/v2/acme/tool/blobs/\(digest)", .ok(blob))
  let file = temporaryBlobFile()
  defer { try? FileManager.default.removeItem(at: file) }

  let error = registryError {
    try RegistryClient(transport: fake).downloadBlob(
      try ImageReference.parse("ghcr.io/acme/tool:1.0"), digest, size: 100, to: file)
  }
  #expect(error == .refused("blob \(digest) is 11 bytes, not the 100 bytes its descriptor gives"))
  #expect(!FileManager.default.fileExists(atPath: file.path))
}

@Test func blobWithANegativeSizeIsRefusedWithoutARequest() throws {
  let fake = FakeTransport()
  let digest = Digest("sha256:" + referenceHex)!
  let file = temporaryBlobFile()
  defer { try? FileManager.default.removeItem(at: file) }

  let error = registryError {
    try RegistryClient(transport: fake).downloadBlob(
      try ImageReference.parse("ghcr.io/acme/tool:1.0"), digest, size: -1, to: file)
  }
  #expect(error == .refused("blob \(digest) has a negative size (-1) in its descriptor"))
  #expect(fake.requests.isEmpty)
}

@Test func manifestOverFourMebibytesIsRefused() throws {
  let fake = FakeTransport()
  fake.on(ghcrManifestURL, .ok(Data(count: (4 << 20) + 1), headers: ["content-type": MediaType.ociManifest]))
  let error = registryError {
    _ = try RegistryClient(transport: fake).manifest(try ImageReference.parse("ghcr.io/acme/tool:1.0"), "1.0")
  }
  #expect(error == .refused("manifest 1.0 is larger than 4194304 bytes"))
  #expect(fake.requests.map(\.limit) == [4 << 20])
}

@Test func tokenAnswerOverFourMebibytesIsRefused() throws {
  let fake = FakeTransport()
  fake.on(ghcrManifestURL, .unauthorized(realm: "https://ghcr.io/token", service: "ghcr.io"))
  fake.on("https://ghcr.io/token", .ok(Data(count: (4 << 20) + 1)))
  let error = registryError {
    _ = try RegistryClient(transport: fake).manifest(try ImageReference.parse("ghcr.io/acme/tool:1.0"), "1.0")
  }
  #expect(error == .refused("the token service's answer is larger than 4194304 bytes"))
  #expect(fake.requests.map(\.limit) == [4 << 20, 4 << 20])
}

@Test func blobWithWrongBytesIsAMismatchAndDeleted() throws {
  let fake = FakeTransport()
  let digest = Digest("sha256:" + referenceHex)!
  let sent = Data("not what was asked".utf8)
  fake.on("https://ghcr.io/v2/acme/tool/blobs/\(digest)", .ok(sent))
  let file = temporaryBlobFile()
  defer { try? FileManager.default.removeItem(at: file) }

  let error = registryError {
    try RegistryClient(transport: fake).downloadBlob(
      try ImageReference.parse("ghcr.io/acme/tool:1.0"), digest, size: Int64(sent.count), to: file)
  }
  #expect(error == .digestMismatch(expected: digest, actual: SHA256Hasher.digest(sent)))
  #expect(!FileManager.default.fileExists(atPath: file.path))
}

@Test func missingBlobIsNotFoundAndDeleted() throws {
  let fake = FakeTransport()
  let digest = Digest("sha256:" + referenceHex)!
  fake.on("https://ghcr.io/v2/acme/tool/blobs/\(digest)", .status(404, body: Data("BLOB_UNKNOWN".utf8)))
  let file = temporaryBlobFile()
  defer { try? FileManager.default.removeItem(at: file) }

  // The error body is longer than the blob's size: still not found, not too large.
  let error = registryError {
    try RegistryClient(transport: fake).downloadBlob(
      try ImageReference.parse("ghcr.io/acme/tool:1.0"), digest, size: 5, to: file)
  }
  guard case .notFound = error else {
    Issue.record("expected notFound, got \(String(describing: error))")
    return
  }
  #expect(!FileManager.default.fileExists(atPath: file.path))
}

/// Review Focus 4: a large blob goes to disk through `download`, never through `send`.
@Test func largeBlobIsDownloadedNeverSent() throws {
  let source = temporaryBlobFile()
  defer { try? FileManager.default.removeItem(at: source) }
  var hasher = SHA256Hasher()
  #expect(FileManager.default.createFile(atPath: source.path, contents: nil))
  let writer = try FileHandle(forWritingTo: source)
  let chunk = Data((0..<(1 << 20)).map { UInt8(truncatingIfNeeded: $0 &* 31) })
  for _ in 0..<64 {
    try writer.write(contentsOf: chunk)
    hasher.update(chunk)
  }
  try writer.close()
  let digest = hasher.finalize()

  let fake = FakeTransport()
  fake.on("https://ghcr.io/v2/acme/tool/blobs/\(digest)", .okFile(source))
  let file = temporaryBlobFile()
  defer { try? FileManager.default.removeItem(at: file) }

  try RegistryClient(transport: fake).downloadBlob(
    try ImageReference.parse("ghcr.io/acme/tool:1.0"), digest, size: 64 << 20, to: file)
  #expect(try FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int == 64 << 20)
  #expect(fake.requests.count == 1)
  #expect(fake.requests.allSatisfy { $0.download })
}

func redirect(_ from: String, to: String, authorization: String? = "Bearer abc") -> URLRequest? {
  var next = URLRequest(url: URL(string: to)!)
  next.setValue(authorization, forHTTPHeaderField: "Authorization")
  return followedRedirect(next, from: URL(string: from)!)
}

@Test func redirectToTheSameHostKeepsTheToken() throws {
  let next = try #require(redirect("https://ghcr.io/v2/a/blobs/x", to: "https://ghcr.io/v2/b/blobs/x"))
  #expect(next.value(forHTTPHeaderField: "Authorization") == "Bearer abc")
}

@Test func redirectToAnotherHostDropsTheToken() throws {
  let next = try #require(redirect("https://ghcr.io/v2/a/blobs/x", to: "https://pkg-containers.githubusercontent.com/x"))
  #expect(next.url?.absoluteString == "https://pkg-containers.githubusercontent.com/x")
  #expect(next.value(forHTTPHeaderField: "Authorization") == nil)
}

@Test func redirectFromHTTPSToPlainHTTPIsRefused() {
  #expect(redirect("https://ghcr.io/v2/a/blobs/x", to: "http://ghcr.io/v2/a/blobs/x") == nil)
  #expect(redirect("https://ghcr.io/v2/a/blobs/x", to: "http://storage.example/x", authorization: nil) == nil)
  #expect(redirect("https://ghcr.io/v2/a/blobs/x", to: "HTTP://storage.example/x") == nil)
}

@Test func redirectFromPlainHTTPMayStayPlain() throws {
  let next = try #require(redirect("http://localhost:5000/v2/a/blobs/x", to: "http://localhost:5000/v2/b/blobs/x"))
  #expect(next.value(forHTTPHeaderField: "Authorization") == "Bearer abc")
}

@Test func redirectChangingSchemeOrPortDropsTheToken() throws {
  let upgraded = try #require(redirect("http://localhost:5000/v2/a/blobs/x", to: "https://localhost:5000/v2/a/blobs/x"))
  #expect(upgraded.value(forHTTPHeaderField: "Authorization") == nil)
  let otherPort = try #require(redirect("http://localhost:5000/v2/a/blobs/x", to: "http://localhost:5001/v2/a/blobs/x"))
  #expect(otherPort.value(forHTTPHeaderField: "Authorization") == nil)
}

@Test func redirectWithoutAURLIsRefused() {
  var next = URLRequest(url: URL(string: "https://ghcr.io/x")!)
  next.url = nil
  #expect(followedRedirect(next, from: URL(string: "https://ghcr.io/v2/a/blobs/x")!) == nil)
}

@Test func challengeParametersKeepCommasInQuotes() {
  let parameters = challengeParameters(
    #"realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:a/b:pull,push""#)
  #expect(parameters["realm"] == "https://auth.docker.io/token")
  #expect(parameters["service"] == "registry.docker.io")
  #expect(parameters["scope"] == "repository:a/b:pull,push")
}

@Test func fakeRepliesInSequenceThenRepeatTheLast() throws {
  let fake = FakeTransport()
  fake.on("https://x/a", .status(200), .status(503))
  #expect(try fake.send(HTTPRequest(url: URL(string: "https://x/a")!)).status == 200)
  #expect(try fake.send(HTTPRequest(url: URL(string: "https://x/a")!)).status == 503)
  #expect(try fake.send(HTTPRequest(url: URL(string: "https://x/a")!)).status == 503)
  #expect(try fake.send(HTTPRequest(url: URL(string: "https://x/b")!)).status == 404)
}

/// Against the real ghcr.io, anonymously: a manifest by tag, then its config blob (which ghcr.io
/// redirects to its storage host). Opt-in: JIG_LIVE_REGISTRY=1.
@Test(.enabled(if: ProcessInfo.processInfo.environment["JIG_LIVE_REGISTRY"] == "1"))
func liveGhcrManifestAndBlob() throws {
  let client = RegistryClient()
  let reference = try ImageReference.parse("ghcr.io/linuxcontainers/alpine:latest")
  let fetched = try client.manifest(reference, "latest")
  var parsed = try ParsedManifest.parse(fetched.data, mediaType: fetched.mediaType)
  if case .index(let index) = parsed {
    let entry = try #require(index.manifest(for: Platform(os: "linux", architecture: "amd64", variant: nil)))
    let platformManifest = try client.manifest(reference, entry.digest.description)
    #expect(platformManifest.digest == entry.digest)
    parsed = try ParsedManifest.parse(platformManifest.data, mediaType: platformManifest.mediaType)
  }
  guard case .image(let image) = parsed else {
    Issue.record("expected an image manifest")
    return
  }
  let file = temporaryBlobFile()
  defer { try? FileManager.default.removeItem(at: file) }
  try client.downloadBlob(reference, image.config.digest, size: image.config.size, to: file)
  #expect(try SHA256Hasher.digest(fileAt: file) == image.config.digest)
}
