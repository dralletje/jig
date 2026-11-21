import Foundation
import Report
import Sandbox
import Testing

@testable import SandboxRootlesskit

#if canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#endif

let ID = "sha256:" + String(repeating: "ab", count: 32)

@Suite struct ArgumentTests {
  @Test func rootlesskitArguments() {
    let args = RootlesskitSandbox.rootlesskitArguments(
      stateDir: "/run/x/rootlesskit", helper: "/bin/self", statusFile: "/run/x/status", rootfs: "/cache/r",
      workspace: "/ws", uid: 1000, gid: 1001, hostname: "h", environment: ["PATH=/bin", "A=b c"],
      command: ["node", "--flag", "-x", ""])
    #expect(
      args == [
        "--net=none", "--disable-host-loopback", "--pidns", "--utsns", "--ipcns", "--cgroupns",
        "--propagation=rprivate", "--state-dir", "/run/x/rootlesskit", "--",
        "/bin/self", "__jig-sandbox-init-v1", "/run/x/status", "/cache/r", "/ws", "1000", "1001", "h",
        "2", "PATH=/bin", "A=b c", "4", "node", "--flag", "-x", "",
      ])
  }

  @Test func launchArguments() {
    #expect(
      RootlesskitSandbox.launchArguments(parentPID: 42, rootlesskit: "/usr/bin/rootlesskit", arguments: ["--pidns"])
        == ["__jig-sandbox-launch-v1", "42", "/usr/bin/rootlesskit", "--pidns"])
  }

  @Test func commandFollowsDockerRules() {
    let config = ImageConfig(entrypoint: ["node", "/app/bin.ts"], cmd: ["--help"], env: [])
    #expect(config.command(arguments: ["rename", "a"]) == ["node", "/app/bin.ts", "rename", "a"])
    #expect(config.command(arguments: []) == ["node", "/app/bin.ts", "--help"])
    #expect(ImageConfig(entrypoint: [], cmd: ["sh"], env: []).command(arguments: ["ls"]) == ["ls"])
  }

  @Test func environmentIsTheImagesOnly() {
    let config = ImageConfig(entrypoint: [], cmd: [], env: ["PATH=/usr/bin", "NODE_VERSION=26"])
    #expect(config.environment(hostname: "box") == ["PATH=/usr/bin", "NODE_VERSION=26", "HOSTNAME=box", "HOME=/root"])
    let own = ImageConfig(entrypoint: [], cmd: [], env: ["HOME=/home/x"])
    #expect(own.environment(hostname: "b").contains("HOME=/home/x"))
    #expect(own.environment(hostname: "b").contains { $0.hasPrefix("PATH=") })
    #expect(!own.environment(hostname: "b").contains("HOME=/root"))
  }

  @Test func statusParsing() {
    #expect(RootlesskitSandbox.parseStatus("exit 0\n") == .finished(.exited(0)))
    #expect(RootlesskitSandbox.parseStatus("signal 9\n") == .finished(.signaled(9)))
    #expect(RootlesskitSandbox.parseStatus("error exec node: No such file\nexit 126\n") == .failed("exec node: No such file"))
    #expect(RootlesskitSandbox.parseStatus("") == nil)
    #expect(RootlesskitSandbox.parseStatus("exit 300") == nil)
    #expect(RootlesskitSandbox.parseStatus("exit x") == nil)
    #expect(RootlesskitSandbox.parseStatus("garbage") == nil)
  }

  @Test func pinnedReferences() {
    #expect(PinnedImage.split("img:tag@\(ID)")! == ("img:tag", ID))
    #expect(PinnedImage.split("img:tag") == nil)
    #expect(PinnedImage.split("@\(ID)") == nil)
    #expect(PinnedImage.split("img@sha256:AB") == nil)
    #expect(isImageID(ID))
    #expect(!isImageID("sha256:../../etc"))
  }

  @Test func inspectParsing() throws {
    let json = #"[{"Id":"\#(ID)","Config":{"Env":["PATH=/bin"],"Entrypoint":["node","/a.ts"],"Cmd":null}}]"#
    let parsed = try DockerImages.parseInspect(Data(json.utf8))
    #expect(parsed.id == ID)
    #expect(parsed.config == ImageConfig(entrypoint: ["node", "/a.ts"], cmd: [], env: ["PATH=/bin"]))
    #expect(throws: RefactorError.self) { try DockerImages.parseInspect(Data("[]".utf8)) }
    #expect(throws: RefactorError.self) { try DockerImages.parseInspect(Data(#"[{"Id":"nope"}]"#.utf8)) }
  }

  @Test func terminationDecoding() {
    #expect(Spawner.termination(0) == .exited(0))
    #expect(Spawner.termination(3 << 8) == .exited(3))
    #expect(Spawner.termination(9) == .signaled(9))
  }
}

@Suite struct CacheTests {
  let root: URL

  init() throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent("rk-cache-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  }

  /// A stand-in for docker: writes a tiny image, with a read-only folder and an image that tries to
  /// turn its mount points into a file and a symlink.
  func fakeBuild(_ calls: Counter) -> (URL, URL) throws -> ImageConfig {
    { rootfs, scratch in
      calls.value += 1
      #expect(FileManager.default.fileExists(atPath: scratch.path))
      try FileManager.default.createDirectory(at: rootfs.appendingPathComponent("bin/ro"), withIntermediateDirectories: true)
      try Data("x".utf8).write(to: rootfs.appendingPathComponent("bin/ro/tool"))
      chmod(rootfs.appendingPathComponent("bin/ro").path, 0o555)
      try Data().write(to: rootfs.appendingPathComponent("tmp"))
      try FileManager.default.createSymbolicLink(atPath: rootfs.appendingPathComponent("workspace").path, withDestinationPath: "/home")
      return ImageConfig(entrypoint: ["tool"], cmd: [], env: ["PATH=/bin"])
    }
  }

  final class Counter: @unchecked Sendable { var value = 0 }

  @Test func defaultRoot() {
    #expect(RootfsCache.defaultRoot(environment: ["XDG_CACHE_HOME": "/x", "HOME": "/h"])?.path == "/x/jig/rootfs")
    #expect(RootfsCache.defaultRoot(environment: ["XDG_CACHE_HOME": "rel", "HOME": "/h"])?.path == "/h/.cache/jig/rootfs")
    #expect(RootfsCache.defaultRoot(environment: ["HOME": "/h"])?.path == "/h/.cache/jig/rootfs")
    #expect(RootfsCache.defaultRoot(environment: [:]) == nil)
  }

  @Test func buildsOnceAtomicallyWithMarker() throws {
    defer { RootfsCache.forceRemove(root) }
    let cache = RootfsCache(root: root)
    let calls = Counter()
    let entry = try cache.ensure(imageID: ID, build: fakeBuild(calls))
    #expect(entry.directory.lastPathComponent == String(repeating: "ab", count: 32))
    #expect(try String(contentsOf: entry.directory.appendingPathComponent("marker"), encoding: .utf8) == "jig rootfs v1\n\(ID)\n")
    #expect(entry.config.entrypoint == ["tool"])
    for point in RootfsCache.mountPoints { #expect(isRealDirectory(entry.rootfs.appendingPathComponent(point).path)) }
    // No build folders are left next to the entry.
    #expect(try FileManager.default.contentsOfDirectory(atPath: root.path) == [entry.directory.lastPathComponent])
    _ = try cache.ensure(imageID: ID, build: fakeBuild(calls))
    #expect(calls.value == 1)
  }

  @Test(arguments: ["marker-missing", "marker-wrong", "config-bad", "rootfs-missing", "mountpoint-symlink"])
  func damagedEntryIsRebuilt(damage: String) throws {
    defer { RootfsCache.forceRemove(root) }
    let cache = RootfsCache(root: root)
    let calls = Counter()
    let entry = try cache.ensure(imageID: ID, build: fakeBuild(calls))
    switch damage {
    case "marker-missing": try FileManager.default.removeItem(at: entry.directory.appendingPathComponent("marker"))
    case "marker-wrong":
      try Data("jig rootfs v1\nsha256:\(String(repeating: "cd", count: 32))\n".utf8)
        .write(to: entry.directory.appendingPathComponent("marker"))
    case "config-bad": try Data("{".utf8).write(to: entry.directory.appendingPathComponent("config.json"))
    case "rootfs-missing": RootfsCache.forceRemove(entry.rootfs)
    default:
      try FileManager.default.removeItem(at: entry.rootfs.appendingPathComponent("proc"))
      try FileManager.default.createSymbolicLink(atPath: entry.rootfs.appendingPathComponent("proc").path, withDestinationPath: "/")
    }
    #expect(cache.load(imageID: ID) == nil)
    let rebuilt = try cache.ensure(imageID: ID, build: fakeBuild(calls))
    #expect(calls.value == 2)
    #expect(cache.load(imageID: ID) == rebuilt)
  }

  @Test func failedBuildLeavesNothing() throws {
    defer { RootfsCache.forceRemove(root) }
    let cache = RootfsCache(root: root)
    struct Boom: Error {}
    #expect(throws: Boom.self) {
      try cache.ensure(imageID: ID) { rootfs, _ in
        try FileManager.default.createDirectory(at: rootfs.appendingPathComponent("half"), withIntermediateDirectories: true)
        chmod(rootfs.appendingPathComponent("half").path, 0o500)
        throw Boom()
      }
    }
    #expect(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
    #expect(cache.load(imageID: ID) == nil)
  }

  @Test func staleBuildFoldersAreSwept() throws {
    defer { RootfsCache.forceRemove(root) }
    // PID 2^22 + 1 is above pid_max's default ceiling on this kernel: never alive.
    let stale = root.appendingPathComponent(".tmp-4194305-abc")
    let live = root.appendingPathComponent(".tmp-\(getpid())-abc")
    let trash = root.appendingPathComponent(".trash-1-abc")
    for dir in [stale, live, trash] { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
    let twoHoursAgo = Date(timeIntervalSinceNow: -7200)
    for dir in [stale, live] {
      try FileManager.default.setAttributes([.modificationDate: twoHoursAgo], ofItemAtPath: dir.path)
    }
    RootfsCache(root: root).sweepStale()
    #expect(try FileManager.default.contentsOfDirectory(atPath: root.path) == [live.lastPathComponent])
  }

  @Test func freshBuildFoldersOfUnseenProcessesStay() throws {
    defer { RootfsCache.forceRemove(root) }
    // A pid this process cannot see, but a recent folder: maybe a build in another PID namespace.
    let fresh = root.appendingPathComponent(".tmp-4194305-abc")
    try FileManager.default.createDirectory(at: fresh, withIntermediateDirectories: true)
    RootfsCache(root: root).sweepStale()
    #expect(try FileManager.default.contentsOfDirectory(atPath: root.path) == [fresh.lastPathComponent])
  }

  @Test func rejectsNonIDs() {
    let cache = RootfsCache(root: root)
    #expect(cache.load(imageID: "sha256:../../x") == nil)
    #expect(throws: RefactorError.self) { try cache.ensure(imageID: "../x") { _, _ in ImageConfig(entrypoint: [], cmd: [], env: []) } }
    RootfsCache.forceRemove(root)
  }
}

@Suite struct RegistryTests {
  @Test func stopRefusesNewWorkAndIsIdempotent() throws {
    let registry = RunRegistry()
    let snapshot = registry.stop()
    #expect(snapshot.groups.isEmpty)
    #expect(throws: RefactorError.self) { try registry.addContainer("x") }
    #expect(throws: RefactorError.self) {
      try registry.runTracked("/bin/true", [], environment: [:])
    }
    _ = registry.stop()
    #expect(registry.isStopped)
  }

  @Test func cleanupWithoutRunsIsHarmless() {
    let sandbox = RootlesskitSandbox()
    sandbox.cleanup()
    sandbox.cleanup()
    #expect(throws: RefactorError.self) {
      try sandbox.run(PinnedImage(id: ID, reference: "x@\(ID)"), arguments: [], workspace: URL(fileURLWithPath: "/tmp"))
    }
  }

  @Test func collectLeavesTheChildAZombieUntilItIsReaped() throws {
    let child = try Spawner.start(path: "/bin/sh", arguments: ["-c", "exit 7"], environment: [], stdinFd: nil)
    var state = ""
    let out = Spawner.collect(child) { pid in
      // `pid (comm) S ...`: the state after the last `)`.
      let stat = (try? String(contentsOfFile: "/proc/\(pid)/stat", encoding: .utf8)) ?? ""
      state = stat.split(separator: ")").last.map { String($0.dropFirst().prefix(1)) } ?? ""
      return Spawner.waitAndReap(pid)
    }
    #expect(state == "Z", "the child was reaped before its reap ran (state \(state))")
    #expect(out.termination == .exited(7))
  }

  @Test func aReapedLauncherIsNeverSignalled() throws {
    let registry = RunRegistry()
    let child = try registry.spawn {
      try Spawner.start(path: "/bin/sh", arguments: ["-c", "exit 0"], environment: [], stdinFd: nil)
    }
    #expect(registry.liveGroups == 1)
    _ = Spawner.collect(child, reap: registry.reap)
    #expect(registry.liveGroups == 0)
    #expect(registry.signalGroups(SIGKILL) == 0)
  }

  @Test func childProcessCapturesBytesAndStatus() throws {
    let out = try Spawner.run(path: "/bin/sh", arguments: ["-c", "printf 'a\\0b'; printf err >&2; exit 3"], environment: [])
    #expect(out.termination == .exited(3))
    #expect(out.stdout == Data([0x61, 0, 0x62]))
    #expect(out.stderrText == "err")
    let killed = try Spawner.run(path: "/bin/sh", arguments: ["-c", "kill -9 $$"], environment: [])
    #expect(killed.termination == .signaled(9))
  }
}
