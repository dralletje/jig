// Registry images with the docker sandbox. The registry is a fake transport serving a `docker save` of
// the test-only image `localhost/jig/probe:local` (built by the swift/cli integration tests), unpacked
// into a folder: its first `index.json` entry is the tag `localhost:5000/t/probe:1`, and every manifest
// and blob is served by digest from `blobs/sha256/`. The store is a fresh temporary folder.
import ChildProcess
import Foundation
import OCI
import Report
import Sandbox
import Testing

@testable import SandboxDocker

/// The image served as `localhost:5000/t/probe:1`.
let probeImage = "localhost/jig/probe:local"

/// Docker answers and has `probeImage`.
let probePossible: Bool = {
  guard let version = try? runProcess("docker", ["version", "--format", "{{.Server.Version}}"]), version.succeeded
  else { return false }
  guard let inspect = try? runProcess("docker", ["image", "inspect", "--format", "{{.Id}}", probeImage]),
    inspect.succeeded
  else { return false }
  return true
}()

/// A registry at `http://localhost:5000` that serves the OCI layout `layout` for the repository `t/probe`:
/// the tag `1` is `tag` (with `tagType`), anything by digest comes from `blobs/sha256/`.
final class LayoutTransport: HTTPTransport, @unchecked Sendable {
  let layout: URL
  let tag: Digest
  let tagType: String

  init(layout: URL, tag: Digest, tagType: String) {
    self.layout = layout
    self.tag = tag
    self.tagType = tagType
  }

  /// The blob file and the media type a manifest request for `url` answers with, or nil (404).
  private func lookup(_ url: URL) -> (file: URL, mediaType: String)? {
    let path = url.path
    let prefix = "/v2/t/probe/"
    guard path.hasPrefix(prefix) else { return nil }
    let rest = path.dropFirst(prefix.count)
    let parts = rest.split(separator: "/", maxSplits: 1).map(String.init)
    guard parts.count == 2 else { return nil }
    var digest = Digest(parts[1])
    if parts[0] == "manifests" && parts[1] == "1" { digest = tag }
    guard let digest else { return nil }
    let file = layout.appendingPathComponent("blobs/sha256").appendingPathComponent(digest.hex)
    guard FileManager.default.fileExists(atPath: file.path) else { return nil }
    var mediaType = "application/octet-stream"
    if parts[0] == "manifests" {
      struct Body: Decodable { var mediaType: String? }
      let body = (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode(Body.self, from: $0) }
      mediaType = digest == tag ? tagType : (body?.mediaType ?? MediaType.ociManifest)
    }
    return (file, mediaType)
  }

  func send(_ request: HTTPRequest) throws -> HTTPResponse {
    guard let (file, mediaType) = lookup(request.url) else { return HTTPResponse(status: 404) }
    let data = try Data(contentsOf: file)
    return HTTPResponse(
      status: 200,
      headers: ["content-type": mediaType, "docker-content-digest": SHA256Hasher.digest(data).description],
      body: data)
  }

  func download(_ request: HTTPRequest, to file: URL) throws -> HTTPResponse {
    guard let (source, _) = lookup(request.url) else { return HTTPResponse(status: 404) }
    try? FileManager.default.removeItem(at: file)
    try FileManager.default.copyItem(at: source, to: file)
    return HTTPResponse(status: 200)
  }
}

/// A new empty folder under the system's temporary folder.
func temporaryFolder(_ prefix: String) throws -> URL {
  let folder = FileManager.default.temporaryDirectory.appendingPathComponent(
    prefix + UUID().uuidString.lowercased())
  try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
  return folder
}

/// The files in `folder` (none when it does not exist).
func filesIn(_ folder: URL) -> [String] {
  (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
}

/// `probeImage` saved and unpacked as an OCI layout in `root/layout`; the tag's digest and media type.
func probeLayout(in root: URL) throws -> (layout: URL, tag: Digest, tagType: String) {
  let saved = root.appendingPathComponent("saved.tar")
  try #require(try runProcess("docker", ["save", probeImage, "-o", saved.path]).succeeded)
  let layout = root.appendingPathComponent("layout")
  try FileManager.default.createDirectory(at: layout, withIntermediateDirectories: true)
  try #require(try runProcess("tar", ["-xf", saved.path, "-C", layout.path]).succeeded)
  struct Entry: Decodable {
    var mediaType: String
    var digest: String
  }
  struct Index: Decodable { var manifests: [Entry] }
  let index = try JSONDecoder().decode(Index.self, from: Data(contentsOf: layout.appendingPathComponent("index.json")))
  let top = try #require(index.manifests.first)
  let tag = try #require(Digest(top.digest))
  return (layout, tag, top.mediaType)
}

/// The tests that load into Docker, one at a time: they share the probe image's Docker name.
@Suite(.serialized) struct DockerRegistryImageTests {
  @Test(.enabled(if: probePossible, "needs Docker and the image \(probeImage)"), .timeLimit(.minutes(5)))
  func registryImageIsLoadedOnceAndRuns() throws {
    let root = try temporaryFolder("jig-docker-registry-")
    defer { try? FileManager.default.removeItem(at: root) }

    // The probe image as an OCI layout.
    let (layout, tag, tagType) = try probeLayout(in: root)

    let storeRoot = root.appendingPathComponent("store")
    let transport = LayoutTransport(layout: layout, tag: tag, tagType: tagType)
    let puller = ImagePuller(store: OCIStore(root: storeRoot), client: RegistryClient(transport: transport))
    let sandbox = DockerSandbox(puller: puller)
    let reference = "localhost:5000/t/probe:1"

    let first = try sandbox.resolve(reference)
    #expect(first.reference == "\(reference)@\(tag)")
    #expect(first.note == nil)
    let manifest = try #require(Digest(first.id))
    let name = dockerName(for: manifest)
    defer { _ = try? runProcess("docker", ["rmi", "--force", name]) }

    // Docker forgets it: the next resolve loads it again, the one after that does not.
    try #require(try runProcess("docker", ["rmi", "--force", name]).succeeded)
    let loadsBefore = sandbox.loads
    let second = try sandbox.resolve(reference)
    #expect(second == first)
    #expect(sandbox.loads == loadsBefore + 1)
    #expect(try runProcess("docker", ["image", "inspect", "--format", "{{.Id}}", name]).succeeded)
    #expect(filesIn(storeRoot.appendingPathComponent("tmp")).isEmpty)
    let third = try sandbox.resolve(reference)
    #expect(third == first)
    #expect(sandbox.loads == loadsBefore + 1)

    // It runs, by its Docker image ID.
    let workspace = root.appendingPathComponent("workspace")
    try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
    let ran = try sandbox.run(first, arguments: ["check", "x"], workspace: workspace)
    #expect(ran.termination == .exited(0), "\(String(decoding: ran.stderr, as: UTF8.self))")
    let seen = try String(contentsOf: workspace.appendingPathComponent("probe.json"), encoding: .utf8)
    #expect(seen.contains(#""network":false"#), "\(seen)")
    #expect(seen.contains(#""args":["x"]"#), "\(seen)")

    // A sandbox that did not resolve it resolves it again from its reference, from the store alone.
    let other = DockerSandbox(
      puller: ImagePuller(
        store: OCIStore(root: storeRoot),
        client: RegistryClient(transport: LayoutTransport(layout: root.appendingPathComponent("none"), tag: tag, tagType: tagType))))
    let pinned = PinnedImage(id: first.id, reference: first.reference)
    let again = try other.run(pinned, arguments: ["check"], workspace: workspace)
    #expect(again.termination == .exited(0), "\(String(decoding: again.stderr, as: UTF8.self))")
    #expect(other.loads == 0)
  }

  /// Another image tagged with the internal name is not trusted: resolve loads the right one over it,
  /// and a run after the name was moved again still runs the image that was checked.
  @Test(.enabled(if: probePossible, "needs Docker and the image \(probeImage)"), .timeLimit(.minutes(5)))
  func anotherImageUnderTheInternalNameIsReplaced() throws {
    let root = try temporaryFolder("jig-docker-impostor-")
    defer { try? FileManager.default.removeItem(at: root) }
    let (layout, tag, tagType) = try probeLayout(in: root)
    let storeRoot = root.appendingPathComponent("store")
    let transport = LayoutTransport(layout: layout, tag: tag, tagType: tagType)
    let reference = "localhost:5000/t/probe:1"

    // Another image: one file, no command, imported from a tar (no network needed).
    let content = root.appendingPathComponent("impostor")
    try FileManager.default.createDirectory(at: content, withIntermediateDirectories: true)
    try Data("not the probe".utf8).write(to: content.appendingPathComponent("impostor.txt"))
    let impostorTar = root.appendingPathComponent("impostor.tar")
    try #require(try runProcess("tar", ["-cf", impostorTar.path, "-C", content.path, "."]).succeeded)
    let impostor = "jig-test-impostor-\(UUID().uuidString.lowercased()):x"
    try #require(try runProcess("docker", ["import", impostorTar.path, impostor]).succeeded)
    defer { _ = try? runProcess("docker", ["rmi", "--force", impostor]) }
    let impostorId = try runProcess("docker", ["image", "inspect", "--format", "{{.Id}}", impostor]).stdoutText
      .trimmingCharacters(in: .whitespacesAndNewlines)

    // The internal name of the probe's manifest, from a first resolve; then the impostor takes it.
    let sandbox = DockerSandbox(
      puller: ImagePuller(store: OCIStore(root: storeRoot), client: RegistryClient(transport: transport)))
    let first = try sandbox.resolve(reference)
    let name = dockerName(for: try #require(Digest(first.id)))
    defer { _ = try? runProcess("docker", ["rmi", "--force", name]) }
    try #require(try runProcess("docker", ["tag", impostor, name]).succeeded)

    // A new sandbox finds the impostor under the name, loads the probe over it and runs the probe.
    let fresh = DockerSandbox(
      puller: ImagePuller(store: OCIStore(root: storeRoot), client: RegistryClient(transport: transport)))
    let resolved = try fresh.resolve(reference)
    #expect(resolved == first)
    #expect(fresh.loads == 1)
    let nameId = try runProcess("docker", ["image", "inspect", "--format", "{{.Id}}", name]).stdoutText
      .trimmingCharacters(in: .whitespacesAndNewlines)
    #expect(nameId != impostorId)
    let workspace = root.appendingPathComponent("workspace")
    try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
    let ran = try fresh.run(resolved, arguments: ["check", "x"], workspace: workspace)
    #expect(ran.termination == .exited(0), "\(String(decoding: ran.stderr, as: UTF8.self))")
    let seen = try String(contentsOf: workspace.appendingPathComponent("probe.json"), encoding: .utf8)
    #expect(seen.contains(#""args":["x"]"#), "\(seen)")

    // The name moves to the impostor between resolve and run: the run still runs the checked image.
    try FileManager.default.removeItem(at: workspace.appendingPathComponent("probe.json"))
    try #require(try runProcess("docker", ["tag", impostor, name]).succeeded)
    let again = try fresh.run(resolved, arguments: ["check", "y"], workspace: workspace)
    #expect(again.termination == .exited(0), "\(String(decoding: again.stderr, as: UTF8.self))")
    let seenAgain = try String(contentsOf: workspace.appendingPathComponent("probe.json"), encoding: .utf8)
    #expect(seenAgain.contains(#""args":["y"]"#), "\(seenAgain)")
    #expect(fresh.loads == 1)
  }
}

@Test func registryImageWithoutStoreFolderIsInternal() throws {
  let sandbox = DockerSandbox(puller: nil, environment: [:])
  do {
    _ = try sandbox.resolve("localhost:5000/t/probe:1")
    Issue.record("expected an error")
  } catch let error as RefactorError {
    #expect(error.code == .INTERNAL)
    #expect(error.instructions.contains("XDG_CACHE_HOME"))
    #expect(error.instructions.contains("HOME"))
  }
}

@Test func cleanupDeletesTheArchiveOfAnInterruptedLoad() throws {
  let root = try temporaryFolder("jig-docker-archive-")
  defer { try? FileManager.default.removeItem(at: root) }
  let store = OCIStore(root: root)
  let file = try store.temporaryFile()
  let sandbox = DockerSandbox(puller: nil, environment: [:])
  sandbox.archive = file
  sandbox.cleanup()
  #expect(!FileManager.default.fileExists(atPath: file.path))
  #expect(sandbox.leftovers.isEmpty)
  // Idempotent.
  sandbox.cleanup()
  #expect(sandbox.leftovers.isEmpty)
}
