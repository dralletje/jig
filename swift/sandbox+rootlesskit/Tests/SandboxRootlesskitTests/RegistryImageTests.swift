// Registry images in the rootlesskit sandbox: resolved and unpacked from jig's image store, without
// Docker. A small fake registry (`FakeRegistry`, an `HTTPTransport`) serves one image,
// `localhost:5000/t/hello:1`: an index for this machine's platform, its manifest, a config and one
// gzip layer with `/bin/hello`. Every sandbox here has `docker` set to a path that does not exist.
import Foundation
import OCI
import Report
import Sandbox
import Testing

@testable import SandboxRootlesskit

#if canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#endif

/// A registry in memory: answers by URL, 404 for anything else; `offline` makes every request fail
/// as a network failure does. Counts the requests.
final class FakeRegistry: HTTPTransport, @unchecked Sendable {
  private let lock = NSLock()
  private var replies: [String: HTTPResponse] = [:]
  private var count = 0
  private var down = false

  func on(_ url: String, _ response: HTTPResponse) {
    lock.lock()
    defer { lock.unlock() }
    replies[url] = response
  }

  var offline: Bool {
    get {
      lock.lock()
      defer { lock.unlock() }
      return down
    }
    set {
      lock.lock()
      defer { lock.unlock() }
      down = newValue
    }
  }

  var requests: Int {
    lock.lock()
    defer { lock.unlock() }
    return count
  }

  func send(_ request: HTTPRequest) throws -> HTTPResponse {
    lock.lock()
    defer { lock.unlock() }
    count += 1
    if down { throw TransportError(message: "connection refused") }
    return replies[request.url.absoluteString] ?? HTTPResponse(status: 404)
  }

  func download(_ request: HTTPRequest, to file: URL) throws -> HTTPResponse {
    var response = try send(request)
    try response.body.write(to: file)
    response.body = Data()
    return response
  }
}

/// The image the fake registry serves, and its digests.
struct HelloImage {
  var registry: FakeRegistry
  var index: Digest
  var manifest: Digest
  var reference = "localhost:5000/t/hello:1"
}

/// Runs a host tool to its end (argv only).
@discardableResult
func hostTool(_ tool: String, _ arguments: [String]) throws -> ChildOutput {
  guard let path = Spawner.find(tool) else { throw RegistryTestFailure("\(tool) not found") }
  let run = try Spawner.run(
    path: path, arguments: arguments, environment: ProcessInfo.processInfo.environment.map { "\($0.key)=\($0.value)" })
  guard run.succeeded else { throw RegistryTestFailure("\(tool) \(arguments) failed: \(run.stderrText)") }
  return run
}

struct RegistryTestFailure: Error, CustomStringConvertible {
  var description: String
  init(_ description: String) { self.description = description }
}

/// A fresh folder under the system temp folder.
func registryTestFolder() throws -> URL {
  let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rk-registry-test-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  return dir
}

/// A static program that prints `hello <its arguments>` and `$GREETING`, without a shell; nil
/// without `cc`.
let helloProgram: Data? = {
  guard Spawner.find("cc") != nil, let dir = try? registryTestFolder() else { return nil }
  defer { RootfsCache.forceRemove(dir) }
  let source = dir.appendingPathComponent("hello.c")
  let program = dir.appendingPathComponent("hello")
  let text = #"""
    #include <stdio.h>
    #include <stdlib.h>
    int main(int argc, char **argv) {
      printf("hello");
      for (int i = 1; i < argc; i++) printf(" %s", argv[i]);
      const char *greeting = getenv("GREETING");
      printf("\n%s\n", greeting ? greeting : "(no GREETING)");
      return 0;
    }
    """#
  guard (try? Data(text.utf8).write(to: source)) != nil,
    (try? hostTool("cc", ["-static", "-O1", "-o", program.path, source.path])) != nil
  else { return nil }
  return try? Data(contentsOf: program)
}()

/// A fake registry serving `localhost:5000/t/hello:1` with `program` as `/bin/hello`.
func helloImage(program: Data) throws -> HelloImage {
  let dir = try registryTestFolder()
  defer { RootfsCache.forceRemove(dir) }
  try FileManager.default.createDirectory(at: dir.appendingPathComponent("files/bin"), withIntermediateDirectories: true)
  let hello = dir.appendingPathComponent("files/bin/hello")
  try program.write(to: hello)
  chmod(hello.path, 0o755)
  let layerFile = dir.appendingPathComponent("layer.tar.gz")
  try hostTool("tar", ["-c", "-z", "-f", layerFile.path, "-C", dir.appendingPathComponent("files").path, "bin"])
  let layer = try Data(contentsOf: layerFile)

  let platform = Platform.host
  let config = Data(
    #"{"architecture":"\#(platform.architecture)","os":"linux","config":{"Entrypoint":["/bin/hello"],"Cmd":["world"],"Env":["PATH=/bin","GREETING=from the config"]},"rootfs":{"type":"layers","diff_ids":[]}}"#
      .utf8)
  let configDigest = SHA256Hasher.digest(config)
  let layerDigest = SHA256Hasher.digest(layer)
  let manifest = Data(
    #"{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"mediaType":"application/vnd.oci.image.config.v1+json","digest":"\#(configDigest)","size":\#(config.count)},"layers":[{"mediaType":"application/vnd.oci.image.layer.v1.tar+gzip","digest":"\#(layerDigest)","size":\#(layer.count)}]}"#
      .utf8)
  let manifestDigest = SHA256Hasher.digest(manifest)
  let index = Data(
    #"{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"\#(manifestDigest)","size":\#(manifest.count),"platform":{"os":"linux","architecture":"\#(platform.architecture)"}}]}"#
      .utf8)
  let indexDigest = SHA256Hasher.digest(index)

  let registry = FakeRegistry()
  let base = "http://localhost:5000/v2/t/hello"
  let indexType = "application/vnd.oci.image.index.v1+json"
  let manifestType = "application/vnd.oci.image.manifest.v1+json"
  registry.on(
    "\(base)/manifests/1",
    HTTPResponse(
      status: 200, headers: ["content-type": indexType, "docker-content-digest": indexDigest.description], body: index))
  registry.on(
    "\(base)/manifests/\(indexDigest)",
    HTTPResponse(status: 200, headers: ["content-type": indexType], body: index))
  registry.on(
    "\(base)/manifests/\(manifestDigest)",
    HTTPResponse(status: 200, headers: ["content-type": manifestType], body: manifest))
  registry.on("\(base)/blobs/\(configDigest)", HTTPResponse(status: 200, body: config))
  registry.on("\(base)/blobs/\(layerDigest)", HTTPResponse(status: 200, body: layer))
  return HelloImage(registry: registry, index: indexDigest, manifest: manifestDigest)
}

/// A sandbox on `folder` (image store and image folder cache) and `registry`, with no Docker.
func registrySandbox(_ folder: URL, _ registry: FakeRegistry) -> RootlesskitSandbox {
  var options = RootlesskitSandbox.Options()
  options.docker = "/nonexistent/docker"
  options.cacheRoot = folder.appendingPathComponent("rootfs")
  options.ociRoot = folder.appendingPathComponent("oci")
  options.registry = RegistryClient(transport: registry)
  return RootlesskitSandbox(options: options)
}

@Suite struct RegistryImageTests {
  @Test func resolvePinsTheManifestAndRecordsTheIndexDigest() throws {
    let image = try helloImage(program: Data("not run here".utf8))
    let folder = try registryTestFolder()
    defer { RootfsCache.forceRemove(folder) }
    let pinned = try registrySandbox(folder, image.registry).resolve(image.reference)
    #expect(pinned.id == image.manifest.description)
    #expect(pinned.reference == "\(image.reference)@\(image.index)")
    #expect(pinned.note == nil)
  }

  @Test func imageFolderIsUnpackedFromTheStoreWithTheImagesConfig() throws {
    let image = try helloImage(program: Data("not run here".utf8))
    let folder = try registryTestFolder()
    defer { RootfsCache.forceRemove(folder) }
    let sandbox = registrySandbox(folder, image.registry)
    let pinned = try sandbox.resolve(image.reference)
    let requests = image.registry.requests

    let entry = try sandbox.imageFolder(pinned)
    // Everything came from the store: no second registry call.
    #expect(image.registry.requests == requests)
    #expect(entry.directory.lastPathComponent == image.manifest.hex)
    #expect(try Data(contentsOf: entry.rootfs.appendingPathComponent("bin/hello")) == Data("not run here".utf8))
    #expect(
      entry.config
        == ImageConfig(entrypoint: ["/bin/hello"], cmd: ["world"], env: ["PATH=/bin", "GREETING=from the config"]))
    let cached = try sandbox.cache().load(imageID: pinned.id)
    #expect(cached?.directory.path == entry.directory.path)
  }

  @Test func aPinnedImageItDidNotResolveIsTakenFromTheStoreOffline() throws {
    let image = try helloImage(program: Data("not run here".utf8))
    let folder = try registryTestFolder()
    defer { RootfsCache.forceRemove(folder) }
    let pinned = try registrySandbox(folder, image.registry).resolve(image.reference)

    image.registry.offline = true
    let other = registrySandbox(folder, image.registry)
    let entry = try other.imageFolder(pinned)
    #expect(FileManager.default.fileExists(atPath: entry.rootfs.appendingPathComponent("bin/hello").path))
    // The replay resolves the same way, from the store.
    #expect(try other.resolve(pinned.reference) == pinned)
  }

  @Test func aPinnedImageWhoseManifestIsNotItsIDIsRefused() throws {
    let image = try helloImage(program: Data("not run here".utf8))
    let folder = try registryTestFolder()
    defer { RootfsCache.forceRemove(folder) }
    let pinned = try registrySandbox(folder, image.registry).resolve(image.reference)
    let wrong = PinnedImage(id: "sha256:" + String(repeating: "cd", count: 32), reference: pinned.reference)
    let error = #expect(throws: RefactorError.self) {
      try registrySandbox(folder, image.registry).imageFolder(wrong)
    }
    #expect(error?.code == .IMAGE_NOT_FOUND)
  }

  @Test func aRepositoryTheRegistryDoesNotHaveIsImageNotFound() throws {
    let image = try helloImage(program: Data("not run here".utf8))
    let folder = try registryTestFolder()
    defer { RootfsCache.forceRemove(folder) }
    let error = #expect(throws: RefactorError.self) {
      try registrySandbox(folder, image.registry).resolve("localhost:5000/t/other:1")
    }
    #expect(error?.code == .IMAGE_NOT_FOUND)
  }

  @Test func aLocalImageStillGoesThroughDocker() throws {
    let image = try helloImage(program: Data("not run here".utf8))
    let folder = try registryTestFolder()
    defer { RootfsCache.forceRemove(folder) }
    let error = #expect(throws: RefactorError.self) {
      try registrySandbox(folder, image.registry).resolve("localhost/t/hello:1")
    }
    #expect(error?.instructions.contains("/nonexistent/docker was not found") == true, "\(String(describing: error))")
    #expect(image.registry.requests == 0)
  }

  @Test(
    .enabled(if: RootlesskitSandbox.unavailableReason() == nil, "rootlesskit is needed"),
    .enabled(if: helloProgram != nil, "cc is needed to build the test program"))
  func runsWithoutDocker() throws {
    let image = try helloImage(program: try #require(helloProgram))
    let folder = try registryTestFolder()
    defer { RootfsCache.forceRemove(folder) }
    let workspace = folder.appendingPathComponent("ws")
    try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
    let sandbox = registrySandbox(folder, image.registry)
    let pinned = try sandbox.resolve(image.reference)

    let byConfig = try sandbox.run(pinned, arguments: [], workspace: workspace)
    #expect(byConfig.termination == .exited(0), "\(String(decoding: byConfig.stderr, as: UTF8.self))")
    #expect(String(decoding: byConfig.stdout, as: UTF8.self) == "hello world\nfrom the config\n")
    let withArguments = try sandbox.run(pinned, arguments: ["a", "b"], workspace: workspace)
    #expect(String(decoding: withArguments.stdout, as: UTF8.self) == "hello a b\nfrom the config\n")
  }
}
