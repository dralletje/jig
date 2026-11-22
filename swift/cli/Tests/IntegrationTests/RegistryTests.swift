// Registry images end to end: a `registry:2` container on `localhost:<port>` holds the jig images, pushed
// over its HTTP API from `docker save` (Helpers.swift), and `jig` and `jig verify` run them with both
// sandboxes: first download (pinned by the index digest), a cached run with the registry stopped, no
// cache and no registry, a tag moved to another image, a repository never pushed, and a `localhost/`
// image as before. Every run of jig gets an XDG_CACHE_HOME of its own test, so its store starts empty.
import Foundation
import Testing

#if canImport(Glibc)
  import Glibc
#endif

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// The scenarios, for one sandbox. Each starts its own registry and removes it when it ends.
struct RegistryScenarios {
  var sandbox: String
  var temp: TempDirs

  /// Our environment with a fresh, empty XDG_CACHE_HOME for jig.
  func freshCache() throws -> [String: String] {
    environment(pathFirst: nil, ["XDG_CACHE_HOME": try temp.make("jig-cache-").path])
  }

  /// `localhost:<port>/jig/typescript:test`, pushed with an extra platform; returns the reference
  /// and the index digest the tag points to.
  func pushTypescript(_ registry: TestRegistry) throws -> (reference: String, pinned: String) {
    let pinned = try pushToTestRegistry(TS, as: "jig/typescript:test", registry: registry, extraPlatform: true)
    return ("\(registry.host)/jig/typescript:test", pinned)
  }

  /// The rename with this sandbox on a fresh copy of the simple fixture.
  func rename(_ image: String, _ env: [String: String]) throws -> (repo: URL, result: Success) {
    let dir = try temp.repo()
    let result = try runImage(repo: dir, image: image, args: RENAME, sandbox: sandbox, environment: env)
    return (dir, result)
  }

  /// `jig verify` of `commit` in `dir` with this sandbox; expects it to pass as identical.
  func expectVerified(_ dir: URL, _ commit: String, _ env: [String: String]) throws {
    let verified = try verify(["--repo", dir.path, "--sandbox", sandbox, commit], environment: env)
    #expect(verified.exitCode == 0, "\(verified.stdout)\n\(verified.stderr)")
    #expect(verified.output.ok)
    let commits = try verified.commits()
    #expect(commits.count == 1)
    #expect(commits.first?.commit == commit)
    #expect(commits.first?.verdict == "identical", "\(verified.stdout)\n\(verified.stderr)")
  }

  /// jig run with this sandbox, expected to fail; returns the failure.
  func failing(_ dir: URL, _ image: String, _ env: [String: String]) throws -> Failure {
    let ran = try run(["--repo", dir.path, "--sandbox", sandbox, image] + RENAME, environment: env)
    guard let failure = ran.output.failure else {
      throw TestFailure("expected failure, got \(ran.stdout)\n\(ran.stderr)")
    }
    return failure
  }

  // 1
  func firstRunPinsTheIndexDigest() throws {
    let registry = try startTestRegistry()
    defer { registry.remove() }
    let (reference, pinned) = try pushTypescript(registry)
    let env = try freshCache()

    let (dir, result) = try rename(reference, env)
    #expect(result.image == "\(reference)@\(pinned)")
    #expect(result.notes == nil)
    #expect(result.commit == (try headCommit(dir)))
    #expect(result.subject == "refactor(typescript rename): foo → bar in a.ts")
    let body = try git(dir, ["log", "-1", "--format=%B"])
    #expect(parseRefactorCommand(body) == RefactorCommand(image: "\(reference)@\(pinned)", args: RENAME))
    #expect(try readTree(dir)["a.ts"]?.contains("export function bar()") == true)
    #expect(try status(dir) == "")
  }

  // 2
  func verifyOfTheFirstRunPasses() throws {
    let registry = try startTestRegistry()
    defer { registry.remove() }
    let (reference, _) = try pushTypescript(registry)
    let env = try freshCache()

    let (dir, result) = try rename(reference, env)
    try expectVerified(dir, result.commit, env)
  }

  // 3
  func registryStoppedUsesTheCachedTag() throws {
    let registry = try startTestRegistry()
    defer { registry.remove() }
    let (reference, pinned) = try pushTypescript(registry)
    let env = try freshCache()
    let (first, firstResult) = try rename(reference, env)

    try registry.stop()
    let (_, second) = try rename(reference, env)
    #expect(second.image == "\(reference)@\(pinned)")
    let notes = try #require(second.notes)
    #expect(notes.count == 1)
    #expect(notes.first?.contains("could not be reached") == true, "\(notes)")
    try expectVerified(first, firstResult.commit, env)
  }

  // 4
  func registryStoppedWithoutCacheIsRegistryUnavailable() throws {
    let registry = try startTestRegistry()
    defer { registry.remove() }
    let (reference, _) = try pushTypescript(registry)
    try registry.stop()
    let env = try freshCache()

    let dir = try temp.repo()
    let before = try headCommit(dir)
    let failure = try failing(dir, reference, env)
    #expect(failure.code == "REGISTRY_UNAVAILABLE", "\(failure.instructions)")
    #expect(try headCommit(dir) == before)
    #expect(try status(dir) == "")
  }

  // 5
  func movedTagPinsTheNewDigest() throws {
    let registry = try startTestRegistry()
    defer { registry.remove() }
    let (reference, pinned) = try pushTypescript(registry)
    let env = try freshCache()
    let (first, firstResult) = try rename(reference, env)

    let moved = try pushToTestRegistry(PRETTIER, as: "jig/typescript:test", registry: registry, extraPlatform: true)
    #expect(moved != pinned)
    let dir = try temp.repo()
    try commitFile(dir, "ugly.ts", "const   x = {a:1}\n")
    let formatted = try runImage(
      repo: dir, image: reference, args: ["format", "--files", "ugly.ts"], sandbox: sandbox, environment: env)
    #expect(formatted.image == "\(reference)@\(moved)")
    #expect(formatted.notes == nil)
    #expect(formatted.filesChanged == ["ugly.ts"])
    // The first commit pinned the old digest: verify replays exactly that image, from the store.
    try expectVerified(first, firstResult.commit, env)
  }

  // 6
  func neverPushedIsImageNotFound() throws {
    let registry = try startTestRegistry()
    defer { registry.remove() }
    let env = try freshCache()

    let dir = try temp.repo()
    let before = try headCommit(dir)
    let failure = try failing(dir, "\(registry.host)/never/pushed:1", env)
    #expect(failure.code == "IMAGE_NOT_FOUND", "\(failure.instructions)")
    #expect(failure.instructions.contains("localhost/"), "\(failure.instructions)")
    #expect(try headCommit(dir) == before)
    #expect(try status(dir) == "")
  }

  // 7
  func localImageAsBefore() throws {
    let env = try freshCache()
    let (dir, result) = try rename(TS, env)
    let pinned = try Regex(#"^localhost/jig/typescript:local@sha256:[0-9a-f]{64}$"#)
    #expect(result.image.wholeMatch(of: pinned) != nil, "\(result.image)")
    #expect(result.notes == nil)
    #expect(parseRefactorCommand(try git(dir, ["log", "-1", "--format=%B"]))?.image == result.image)
    try expectVerified(dir, result.commit, env)
  }
}

@Suite("registry images (docker)", .serialized, .enabled(if: dockerAvailable, dockerMissing), .builtOnce)
struct RegistryDockerTests {
  let scenarios = RegistryScenarios(sandbox: "docker", temp: TempDirs())

  @Test("first run of a registry tag commits, pinned by the index digest, without notes", .timeLimit(.minutes(5)))
  func firstRun() throws { try scenarios.firstRunPinsTheIndexDigest() }

  @Test("verify of a registry-image commit passes", .timeLimit(.minutes(5)))
  func verifyFirstRun() throws { try scenarios.verifyOfTheFirstRunPasses() }

  @Test("registry stopped: the tag runs from the store with a note; verify still passes", .timeLimit(.minutes(5)))
  func registryStopped() throws { try scenarios.registryStoppedUsesTheCachedTag() }

  @Test("registry stopped and an empty store: REGISTRY_UNAVAILABLE", .timeLimit(.minutes(5)))
  func registryStoppedEmptyStore() throws { try scenarios.registryStoppedWithoutCacheIsRegistryUnavailable() }

  @Test("a moved tag pins the new digest; the old commit still verifies", .timeLimit(.minutes(8)))
  func movedTag() throws { try scenarios.movedTagPinsTheNewDigest() }

  @Test("a repository never pushed is IMAGE_NOT_FOUND mentioning localhost/", .timeLimit(.minutes(3)))
  func neverPushed() throws { try scenarios.neverPushedIsImageNotFound() }

  @Test("a localhost/ image runs from local Docker as before", .timeLimit(.minutes(3)))
  func localImage() throws { try scenarios.localImageAsBefore() }
}

@Suite("registry images (rootlesskit)", .serialized, .enabled(if: rootlesskitAvailable, rootlesskitMissing), .builtOnce)
struct RegistryRootlesskitTests {
  let scenarios = RegistryScenarios(sandbox: "rootlesskit", temp: TempDirs())

  @Test("first run of a registry tag commits, pinned by the index digest, without notes", .timeLimit(.minutes(5)))
  func firstRun() throws { try scenarios.firstRunPinsTheIndexDigest() }

  @Test("verify of a registry-image commit passes", .timeLimit(.minutes(5)))
  func verifyFirstRun() throws { try scenarios.verifyOfTheFirstRunPasses() }

  @Test("registry stopped: the tag runs from the store with a note; verify still passes", .timeLimit(.minutes(5)))
  func registryStopped() throws { try scenarios.registryStoppedUsesTheCachedTag() }

  @Test("registry stopped and an empty store: REGISTRY_UNAVAILABLE", .timeLimit(.minutes(5)))
  func registryStoppedEmptyStore() throws { try scenarios.registryStoppedWithoutCacheIsRegistryUnavailable() }

  @Test("a moved tag pins the new digest; the old commit still verifies", .timeLimit(.minutes(8)))
  func movedTag() throws { try scenarios.movedTagPinsTheNewDigest() }

  @Test("a repository never pushed is IMAGE_NOT_FOUND mentioning localhost/", .timeLimit(.minutes(3)))
  func neverPushed() throws { try scenarios.neverPushedIsImageNotFound() }

  @Test("a localhost/ image runs from local Docker as before", .timeLimit(.minutes(3)))
  func localImage() throws { try scenarios.localImageAsBefore() }
}

/// The helpers themselves: what they push is what the registry serves, byte for byte. Needs only Docker.
@Suite("test registry helpers", .serialized, .enabled(if: dockerAvailable, dockerMissing))
struct TestRegistryHelperTests {
  @Test("a pushed image with an extra platform is served as pushed, and the registry stops, starts and is removed", .timeLimit(.minutes(5)))
  func pushedAsServed() throws {
    let registry = try startTestRegistry()
    defer { registry.remove() }
    let index = "application/vnd.oci.image.index.v1+json"
    let manifest = "application/vnd.oci.image.manifest.v1+json"
    let accept = [index, manifest, "application/vnd.docker.distribution.manifest.v2+json"].joined(separator: ", ")

    let pinned = try pushToTestRegistry(TS, as: "jig/typescript:local", registry: registry, extraPlatform: true)
    let byTag = try http(
      "GET", registry.base.appendingPathComponent("v2/jig/typescript/manifests/local"), headers: ["Accept": accept])
    #expect(byTag.status == 200, "\(byTag.text)")
    #expect(try sha256Digest(byTag.body) == pinned)
    #expect(byTag.header("Docker-Content-Digest") == pinned)
    #expect(byTag.header("Content-Type") == index)

    let entries = try #require(
      (try JSONSerialization.jsonObject(with: byTag.body) as? [String: Any])?["manifests"] as? [[String: Any]])
    #expect(entries.count == 2)
    let architectures = entries.compactMap { ($0["platform"] as? [String: Any])?["architecture"] as? String }
    #expect(architectures == [hostArchitecture, otherArchitecture])
    let hostDigest = try #require(entries.first?["digest"] as? String)
    #expect(entries.last?["digest"] as? String != hostDigest)

    let platform = try http(
      "GET", registry.base.appendingPathComponent("v2/jig/typescript/manifests/\(hostDigest)"), headers: ["Accept": accept])
    #expect(platform.status == 200, "\(platform.text)")
    #expect(try sha256Digest(platform.body) == hostDigest)
    #expect(entries.first?["size"] as? Int == platform.body.count)
    let platformObject = try #require(try JSONSerialization.jsonObject(with: platform.body) as? [String: Any])
    let layers = try #require(platformObject["layers"] as? [[String: Any]])
    #expect(!layers.isEmpty)
    let layer = try #require(layers.last?["digest"] as? String)
    let blob = try http("GET", registry.base.appendingPathComponent("v2/jig/typescript/blobs/\(layer)"))
    #expect(blob.status == 200)
    #expect(try sha256Digest(blob.body) == layer)
    #expect(layers.last?["size"] as? Int == blob.body.count)
    let config = try #require((platformObject["config"] as? [String: Any])?["digest"] as? String)
    let configBlob = try http("GET", registry.base.appendingPathComponent("v2/jig/typescript/blobs/\(config)"))
    #expect(try sha256Digest(configBlob.body) == config)

    // Without the extra platform the tag is the manifest itself.
    let plain = try pushToTestRegistry(PRETTIER, as: "jig/prettier:plain", registry: registry)
    let plainByTag = try http(
      "GET", registry.base.appendingPathComponent("v2/jig/prettier/manifests/plain"), headers: ["Accept": accept])
    #expect(plainByTag.status == 200, "\(plainByTag.text)")
    #expect(try sha256Digest(plainByTag.body) == plain)
    #expect(plainByTag.header("Content-Type") == manifest)

    // Stopped, it does not answer; started again, it serves the same content.
    try registry.stop()
    #expect((try? http("GET", registry.base.appendingPathComponent("v2/"), timeout: 5))?.status != 200)
    try registry.start()
    let again = try http(
      "GET", registry.base.appendingPathComponent("v2/jig/typescript/manifests/local"), headers: ["Accept": accept])
    #expect(try sha256Digest(again.body) == pinned)

    registry.remove()
    let listed = try runCommand(["docker", "ps", "-aq", "--filter", "name=^/\(registry.container)$"])
    #expect(listed.stdoutText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
  }
}
