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

// MARK: - The real actions, compared with docker

@Suite(.enabled(if: available, "rootlesskit, docker and the action images are needed"), .serialized)
struct ParityTests {
  let temp = TempDirs()

  @Test func typescriptRenameMatchesDocker() throws {
    let viaDocker = try temp.fixture("simple")
    let viaSandbox = try temp.fixture("simple")
    let args = ["typescript-rename", "--file", "a.ts", "--symbol", "foo", "--to", "bar"]
    let image = try shared.resolve(TS)
    #expect(image.reference == "\(TS)@\(image.id)")
    let docker = try dockerRun(image.id, args, workspace: viaDocker)
    let sandbox = try shared.run(image, arguments: args, workspace: viaSandbox)
    #expect(docker.termination == .exited(0), "docker: \(docker.stderrText)")
    #expect(sandbox.termination == .exited(0), "sandbox: \(String(decoding: sandbox.stderr, as: UTF8.self))")
    #expect(sandbox.stdout == docker.stdout)
    #expect(sandbox.stderr == docker.stderr)
    let tree = try readTree(viaSandbox)
    #expect(tree == (try readTree(viaDocker)))
    #expect(String(decoding: tree["b.ts"] ?? Data(), as: UTF8.self).contains("bar"))
    #expect(tree != (try readTree(repoRoot.appendingPathComponent("packages/test-utils/fixtures/simple"))))
  }

  @Test func prettierFormatMatchesDocker() throws {
    let viaDocker = try temp.fixture("simple")
    let viaSandbox = try temp.fixture("simple")
    for dir in [viaDocker, viaSandbox] { try Data("const   x = {a:1}\n".utf8).write(to: dir.appendingPathComponent("ugly.ts")) }
    let args = ["format", "--files", "ugly.ts"]
    let image = try shared.resolve(PRETTIER)
    let docker = try dockerRun(image.id, args, workspace: viaDocker)
    let sandbox = try shared.run(image, arguments: args, workspace: viaSandbox)
    #expect(docker.termination == .exited(0), "docker: \(docker.stderrText)")
    #expect(sandbox.termination == .exited(0))
    #expect(sandbox.stdout == docker.stdout)
    #expect(try readTree(viaSandbox) == (try readTree(viaDocker)))
    #expect(String(decoding: try Data(contentsOf: viaSandbox.appendingPathComponent("ugly.ts")), as: UTF8.self) == "const x = { a: 1 };\n")
  }

  @Test func filesInTheWorkspaceBelongToTheHostUser() throws {
    let ws = try temp.fixture("simple")
    let image = try shared.resolve(TS)
    let result = try shared.run(
      image, arguments: ["typescript-rename-files", "--files", "**", "--case", "kebab"], workspace: ws)
    _ = result
    let answers = try probe(["create:/workspace/made-inside", "create:/workspace/sub-made"], workspace: ws)
    #expect(answers["create:/workspace/made-inside"] == "OK")
    #expect(owners(ws) == ["\(getuid()):\(getgid())"])
  }

  @Test func exitStatusSignalAndBytesPassThrough() throws {
    let temp = TempDirs()
    let image = try shared.resolve(TS)
    let ws = try temp.make()
    let exited = try shared.run(image, command: ["sh", "-c", "printf 'a\\0b'; printf e >&2; exit 7"], workspace: ws)
    #expect(exited.termination == .exited(7))
    #expect(exited.stdout == Data([0x61, 0, 0x62]))
    #expect(exited.stderr == Data("e".utf8))
    let killed = try shared.run(image, command: ["sh", "-c", "kill -TERM $$"], workspace: ws)
    #expect(killed.termination == .signaled(SIGTERM))
    let missing = #expect(throws: RefactorError.self) {
      try shared.run(image, command: ["no-such-program"], workspace: ws)
    }
    #expect(missing?.instructions.contains("no-such-program: No such file or directory") == true)
  }

  @Test func unknownImageIsImageNotFound() throws {
    let error = #expect(throws: RefactorError.self) { try shared.resolve("localhost/jig/no-such-image:local") }
    #expect(error?.code == .IMAGE_NOT_FOUND)
  }

  @Test func damagedCacheEntryIsRebuiltFromDocker() throws {
    let temp = TempDirs()
    var options = RootlesskitSandbox.Options()
    options.cacheRoot = try temp.make()
    let sandbox = RootlesskitSandbox(options: options)
    let image = try sandbox.resolve(PRETTIER)
    let ws = try temp.make()
    #expect(try sandbox.run(image, command: ["true"], workspace: ws).termination == .exited(0))
    let cache = try sandbox.cache()
    let entry = try #require(cache.load(imageID: image.id))
    try Data("damaged".utf8).write(to: entry.directory.appendingPathComponent("marker"))
    #expect(cache.load(imageID: image.id) == nil)
    #expect(try sandbox.run(image, command: ["true"], workspace: ws).termination == .exited(0))
    #expect(cache.load(imageID: image.id) != nil)
    #expect(try FileManager.default.contentsOfDirectory(atPath: options.cacheRoot!.path) == [entry.directory.lastPathComponent])
    // A replay of the pinned reference needs no docker once the folder is cached.
    var noDocker = options
    noDocker.docker = "/nonexistent/docker"
    #expect(try RootlesskitSandbox(options: noDocker).resolve(image.reference) == image)
  }
}

// MARK: - Escape tests: each must fail, with the failure named

@Suite(.enabled(if: available, "rootlesskit, docker and the action images are needed"))
struct EscapeTests {
  @Test func identityIsUnprivileged() throws {
    let a = try probe(["status", "mounts", "hostname", "pids"])
    let status = a["status"] ?? ""
    #expect(status.contains("Uid: 1000 1000 1000 1000"))
    #expect(status.contains("Gid: 1000 1000 1000 1000"))
    for cap in ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"] {
      #expect(status.contains("\(cap): 0000000000000000"), "\(cap) in \(status)")
    }
    #expect(status.contains("NoNewPrivs: 1"))
    #expect(status.contains("Seccomp: 2"))
    // No host path is mounted anywhere: exactly the sandbox's own mounts.
    #expect(
      a["mounts"] == "/ /proc /proc/sys /proc/sysrq-trigger /tmp /dev /dev/null /dev/zero /dev/urandom /dev/random /dev/shm /workspace")
    #expect(a["hostname"] == "jig")
    // Only the sandbox's reaper (1) and the probe (2) are visible.
    #expect(a["pids"] == "1 2")
  }

  @Test func cannotReadHostFiles() throws {
    let home = try #require(ProcessInfo.processInfo.environment["HOME"])
    let marker = URL(fileURLWithPath: home).appendingPathComponent(".jig-escape-marker-\(UUID().uuidString)")
    try Data("host secret".utf8).write(to: marker)
    defer { try? FileManager.default.removeItem(at: marker) }
    let checks = [
      "read:\(marker.path)", "read:/proc/1/root\(marker.path)", "read:/proc/2/root\(marker.path)",
      "read:/workspace/../../../..\(marker.path)", "read:/proc/self/cwd/../..\(marker.path)",
      "read:\(testCacheRoot.path)", "read:/proc/1/root/etc/hostname",
    ]
    let a = try probe(checks)
    for check in checks.prefix(6) where !check.hasPrefix("read:/proc/1/") {
      #expect(a[check] == "ENOENT", "\(check): \(a[check] ?? "-")")
    }
    // PID 1 is the sandbox's own reaper (its root is the sandbox root anyway); its /proc entries are
    // not even open to the action.
    #expect(a["read:/proc/1/root\(marker.path)"] == "EACCES")
    #expect(a["read:/proc/1/root/etc/hostname"] == "EACCES")
    #expect(!a.values.contains { $0.contains("host secret") })
  }

  @Test func cannotWriteOutsideTheWorkspaceOrIntoTheImage() throws {
    let home = try #require(ProcessInfo.processInfo.environment["HOME"])
    let hostTarget = "\(home)/.jig-escape-\(UUID().uuidString)"
    let checks = [
      "write:/escape", "write:/app/escape", "write:/app/package.json", "write:/etc/passwd", "write:/etc/bash.bashrc",
      "chmod:/app", "unlink:/app/package.json", "chmod:/etc/shadow", "write:/etc/shadow", "write:\(hostTarget)", "write:/dev/escape", "write:/proc/sys/kernel/hostname",
      "write:/tmp/fine", "write:/workspace/fine",
    ]
    let a = try probe(checks)
    // Every image file belongs to the action's uid inside (the image folder is the host user's), so
    // permissions do not protect them: the read-only mount does, and it holds for each of these.
    for check in checks.prefix(9) { #expect(a[check] == "EROFS", "\(check): \(a[check] ?? "-")") }
    #expect(a["write:\(hostTarget)"] == "ENOENT")
    #expect(a["write:/dev/escape"] == "EROFS")
    // Owned by the host's root, which has no uid in the sandbox (and the mount is read-only too).
    #expect(a["write:/proc/sys/kernel/hostname"] == "EACCES")
    #expect(a["write:/tmp/fine"] == "OK")
    #expect(a["write:/workspace/fine"] == "OK")
    #expect(!FileManager.default.fileExists(atPath: hostTarget))
    // The image folder on the host is untouched.
    let entry = try #require(try shared.cache().load(imageID: try shared.resolve(TS).id))
    #expect(!FileManager.default.fileExists(atPath: entry.rootfs.appendingPathComponent("escape").path))
    #expect(!FileManager.default.fileExists(atPath: entry.rootfs.appendingPathComponent("app/escape").path))
  }

  @Test func cannotRemountTheImageReadWrite() throws {
    let a = try probe([
      "remount-root-rw", "remount-root-rw-plain", "umount-root", "umount-workspace", "write:/after-remount",
    ])
    #expect(a["remount-root-rw"] == "EPERM")
    #expect(a["remount-root-rw-plain"] == "EPERM")
    #expect(a["umount-root"] == "EPERM")
    #expect(a["umount-workspace"] == "EPERM")
    #expect(a["write:/after-remount"] == "EROFS")
  }

  @Test func cannotChrootOrPivotRoot() throws {
    let a = try probe(["chroot", "chroot-escape", "pivot-root"])
    #expect(a["chroot"] == "EPERM")
    #expect(a["chroot-escape"] == "EPERM")
    #expect(a["pivot-root"] == "EPERM")
  }

  @Test func hasNoNetwork() throws {
    // A listener on every host address: the sandbox reaches none of them.
    let fd = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
    defer { close(fd) }
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = 0
    addr.sin_addr.s_addr = 0
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, len) } }
    listen(fd, 4)
    _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) } }
    let port = Int(UInt16(bigEndian: addr.sin_port))
    let hostIP = try #require(firstHostIPv4())
    let docker = (ProcessInfo.processInfo.environment["XDG_RUNTIME_DIR"] ?? "/run/user/\(getuid())") + "/docker.sock"
    let checks = [
      "connect:127.0.0.1:\(port)", "connect:\(hostIP):\(port)", "connect:1.1.1.1:443", "connect:10.0.2.2:\(port)",
      "connect-unix:\(docker)", "connect-unix:/var/run/docker.sock", "unshare-net",
    ]
    let a = try probe(checks)
    #expect(a["connect:127.0.0.1:\(port)"] == "ECONNREFUSED")  // the sandbox's own loopback
    #expect(a["connect:\(hostIP):\(port)"] == "ENETUNREACH")
    #expect(a["connect:1.1.1.1:443"] == "ENETUNREACH")
    #expect(a["connect:10.0.2.2:\(port)"] == "ENETUNREACH")
    #expect(a["connect-unix:\(docker)"] == "ENOENT")
    #expect(a["connect-unix:/var/run/docker.sock"] == "ENOENT")
    #expect(a["unshare-net"] == "EPERM")
  }

  @Test func cannotCreateAUserNamespace() throws {
    let a = try probe(["unshare-user", "clone-user", "clone3-user", "setns-user", "unshare-mount"])
    #expect(a["unshare-user"] == "EPERM")
    #expect(a["clone-user"] == "EPERM")
    #expect(a["clone3-user"] == "ENOSYS")
    #expect(a["setns-user"] == "EPERM")
    #expect(a["unshare-mount"] == "EPERM")
  }

  @Test func cannotMountAnything() throws {
    let a = try probe(["mount-tmpfs", "mount-proc", "bind-root", "fsopen", "open-tree"])
    for check in ["mount-tmpfs", "mount-proc", "bind-root", "fsopen", "open-tree"] {
      #expect(a[check] == "EPERM", "\(check): \(a[check] ?? "-")")
    }
  }

  @Test func otherPrivilegedCallsFail() throws {
    let a = try probe(["ptrace-init", "setuid0", "open-by-handle", "bpf", "keyctl", "kill-init"])
    for check in ["ptrace-init", "open-by-handle", "bpf", "keyctl"] {
      #expect(a[check] == "EPERM", "\(check): \(a[check] ?? "-")")
    }
    // uid 0 does not exist in the sandbox's user namespace (only 1000 is mapped).
    #expect(a["setuid0"] == "EINVAL")
    // Signals to the sandbox's PID 1 from inside are dropped (it has no handler): kill returns OK
    // but the probe is still there to print the line, and the run ends normally.
    #expect(a["kill-init"] == "OK")
  }

  @Test func nativeAIOAndIOUringAreNotAvailable() throws {
    let checks = ["io-setup", "io-submit", "io-getevents", "io-pgetevents", "io-cancel", "io-destroy", "io-uring-setup"]
    // On the host the same probe reaches the kernel's AIO (io_setup succeeds; the others get past the
    // syscall table and fail on their bogus arguments), so ENOSYS inside is the filter's doing.
    let outside = try host(try probeBinary.get().path, checks)
    #expect(outside.stdoutText.contains("io-setup: OK\n"), "\(outside.stdoutText)")
    #expect(!outside.stdoutText.contains("io-submit: ENOSYS"), "\(outside.stdoutText)")
    let inside = try probe(checks)
    for check in checks {
      #expect(inside[check] == "ENOSYS", "\(check): \(inside[check] ?? "-")")
    }
  }
}

func firstHostIPv4() -> String? {
  var list: UnsafeMutablePointer<ifaddrs>?
  guard getifaddrs(&list) == 0 else { return nil }
  defer { freeifaddrs(list) }
  var cursor = list
  while let entry = cursor {
    defer { cursor = entry.pointee.ifa_next }
    guard let sa = entry.pointee.ifa_addr, sa.pointee.sa_family == sa_family_t(AF_INET) else { continue }
    var addr = sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr }
    var buf = [CChar](repeating: 0, count: 64)
    inet_ntop(AF_INET, &addr, &buf, 64)
    let ip = String(decoding: buf.prefix(while: { $0 != 0 }).map { UInt8(bitPattern: $0) }, as: UTF8.self)
    if !ip.hasPrefix("127.") { return ip }
  }
  return nil
}

// MARK: - SIGKILL and cleanup leave nothing

@Suite(.enabled(if: available, "rootlesskit, docker and the action images are needed"), .serialized)
struct KillTests {
  /// Starts `rootlesskit-sandbox-run` with the probe: a background `sleep <orphan>` that cleared its
  /// parent-death signal and left the session, then the action itself becomes `sleep <main>`.
  func startTool(_ temp: TempDirs) throws -> (child: StartedChild, main: String, orphan: String) {
    let ws = try temp.probeWorkspace()
    let main = String(Int.random(in: 200_000...899_999))
    let orphan = String(Int.random(in: 200_000...899_999))
    let child = try Spawner.start(
      path: try runTool().path,
      arguments: ["--cache", testCacheRoot.path, "--command", ws.path, TS, "/workspace/probe", "spawn-orphan:\(orphan)", "exec-sleep:\(main)"],
      environment: ProcessInfo.processInfo.environment.map { "\($0.key)=\($0.value)" }, stdinFd: nil)
    let started = waitUntil(30) {
      let all = hostProcesses()
      return all.contains { $0.argv == ["sleep", main] } && all.contains { $0.argv == ["sleep", orphan] }
    }
    if !started {
      kill(-child.pid, SIGKILL)
      let out = Spawner.collect(child)
      throw TestFailure("the sandbox did not start: \(out.stderrText)")
    }
    return (child, main, orphan)
  }

  func everythingGone(tool: pid_t, main: String, orphan: String) -> Bool {
    let gone = waitUntil(10) {
      let all = hostProcesses()
      return !all.contains { $0.argv == ["sleep", main] || $0.argv == ["sleep", orphan] }
        && !all.contains { p in p.argv.contains { $0.contains("/rcrk-\(tool)-") } }
    }
    // A failed test must not hang on the tool's output: end it (its PDEATHSIG chain cleans up).
    if !gone { kill(tool, SIGKILL) }
    return gone
  }

  @Test func sigkillOfTheBinaryLeavesNothing() throws {
    let temp = TempDirs()
    let (child, main, orphan) = try startTool(temp)
    kill(child.pid, SIGKILL)
    let out = Spawner.collect(child)
    #expect(out.termination == .signaled(SIGKILL))
    #expect(everythingGone(tool: child.pid, main: main, orphan: orphan))
  }

  @Test func sigkillOfRootlesskitLeavesNothing() throws {
    let temp = TempDirs()
    let (child, main, orphan) = try startTool(temp)
    let rootlesskit = try #require(hostProcesses().first { $0.ppid == child.pid && $0.argv.first == "/usr/bin/rootlesskit" })
    kill(rootlesskit.pid, SIGKILL)
    #expect(everythingGone(tool: child.pid, main: main, orphan: orphan))
    let out = Spawner.collect(child)
    #expect(out.termination == .exited(125))
    #expect(out.stderrText.contains("rootlesskit ended"), "\(out.stderrText)")
  }

  @Test func sigkillOfTheSandboxInitLeavesNothing() throws {
    let temp = TempDirs()
    let (child, main, orphan) = try startTool(temp)
    // This run's inits only (other tests run sandboxes concurrently): their status file is in this
    // tool's run folder.
    let inits = hostProcesses().filter {
      $0.argv.count > 2 && $0.argv[1] == "__jig-sandbox-init-v1" && $0.argv[2].contains("/rcrk-\(child.pid)-")
    }
    #expect(inits.count == 2)
    // The reaper (PID 1 of the action's namespace) is the init whose parent is the other init.
    let reaper = try #require(inits.first { p in inits.contains { $0.pid == p.ppid } })
    kill(reaper.pid, SIGKILL)
    #expect(everythingGone(tool: child.pid, main: main, orphan: orphan))
    let out = Spawner.collect(child)
    #expect(out.termination == .exited(125))
    #expect(out.stderrText.contains("without a status"), "\(out.stderrText)")
  }

  @Test func sigkillOfTheActionEndsTheRunAndItsOrphans() throws {
    let temp = TempDirs()
    let (child, main, orphan) = try startTool(temp)
    let action = try #require(hostProcesses().first { $0.argv == ["sleep", main] })
    kill(action.pid, SIGKILL)
    let out = Spawner.collect(child)
    #expect(out.termination == .exited(128 + SIGKILL))
    #expect(everythingGone(tool: child.pid, main: main, orphan: orphan))
  }

  @Test func cleanupKillsTheRunAndRemovesItsFolder() throws {
    let temp = TempDirs()
    var options = RootlesskitSandbox.Options()
    options.cacheRoot = testCacheRoot
    let runRoot = try temp.make()
    options.temporaryRoot = runRoot
    let sandbox = RootlesskitSandbox(options: options)
    let image = try sandbox.resolve(TS)
    let ws = try temp.probeWorkspace()
    let main = String(Int.random(in: 200_000...899_999))
    let orphan = String(Int.random(in: 200_000...899_999))
    final class Box: @unchecked Sendable { var result: Result<SandboxRun, Error>? }
    let box = Box()
    let done = DispatchSemaphore(value: 0)
    Thread.detachNewThread {
      box.result = Result { try sandbox.run(image, command: ["/workspace/probe", "spawn-orphan:\(orphan)", "exec-sleep:\(main)"], workspace: ws) }
      done.signal()
    }
    let started = waitUntil(30) { hostProcesses().contains { $0.argv == ["sleep", main] } || box.result != nil }
    #expect(started && box.result == nil, "run ended early: \(String(describing: box.result))")
    let runFolders = { (try? FileManager.default.contentsOfDirectory(atPath: runRoot.path)) ?? [] }
    #expect(runFolders().count >= 1)
    sandbox.cleanup()
    sandbox.cleanup()  // idempotent
    #expect(!hostProcesses().contains { $0.argv == ["sleep", main] || $0.argv == ["sleep", orphan] })
    #expect(done.wait(timeout: .now() + 10) == .success)
    #expect(throws: RefactorError.self) { try box.result?.get() }
    #expect(throws: RefactorError.self) { try sandbox.run(image, command: ["true"], workspace: ws) }
    #expect(waitUntil(5) { runFolders().isEmpty })
  }
}
