import Dispatch
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

/// `cleanup()` during a first-run image export, with a fake docker whose `docker create` hangs and whose
/// `docker rm` fails: what the cleanup could not remove is in `leftovers`, never claimed gone.
@Suite(.serialized) struct CleanupTests {
  let dir: URL

  init() throws {
    dir = FileManager.default.temporaryDirectory.appendingPathComponent("rk-cleanup-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir.appendingPathComponent("workspace"), withIntermediateDirectories: true)
  }

  /// A sandbox whose docker is a script: `image inspect` answers for `ID`, `create` notes the container
  /// name and hangs (with `holdPipes`, a process in a session of its own keeps its output pipes open),
  /// `rm` fails, `ps` lists every container.
  func sandbox(holdPipes: Bool, reapWait: Double = 5) throws -> RootlesskitSandbox {
    let script = """
      #!/bin/sh
      case "$1" in
        image) printf '[{"Id":"\(ID)","Config":{"Entrypoint":["tool"]}}]' ;;
        create)
          echo "$3" > '\(dir.path)/created.tmp'
          if [ \(holdPipes ? 1 : 0) = 1 ]; then setsid sleep 60 & echo $! > '\(dir.path)/sleeper'; fi
          mv '\(dir.path)/created.tmp' '\(dir.path)/created'
          exec sleep 600 ;;
        rm) echo "Error response from daemon: boom" >&2; exit 1 ;;
        ps) echo abc123 ;;
        version) echo 1 ;;
        *) exit 1 ;;
      esac

      """
    let docker = dir.appendingPathComponent("docker")
    try Data(script.utf8).write(to: docker)
    chmod(docker.path, 0o755)
    var options = RootlesskitSandbox.Options()
    options.rootlesskit = "/bin/true"
    options.docker = docker.path
    options.cacheRoot = dir.appendingPathComponent("cache")
    options.temporaryRoot = dir
    options.reapWait = reapWait
    return RootlesskitSandbox(options: options)
  }

  /// Starts a run on a thread of its own and waits until its `docker create` runs; returns the
  /// container's name and a semaphore signalled when the run returned.
  func startExport(_ sandbox: RootlesskitSandbox) throws -> (String, DispatchSemaphore) {
    let done = DispatchSemaphore(value: 0)
    let workspace = dir.appendingPathComponent("workspace")
    Thread.detachNewThread {
      _ = try? sandbox.run(PinnedImage(id: ID, reference: "localhost/x@\(ID)"), arguments: [], workspace: workspace)
      done.signal()
    }
    let created = dir.appendingPathComponent("created")
    for _ in 0..<400 where !FileManager.default.fileExists(atPath: created.path) { usleep(25_000) }
    let name = try String(contentsOf: created, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
    #expect(name.hasPrefix("jig-export-"))
    return (name, done)
  }

  @Test(.timeLimit(.minutes(1))) func anExportContainerThatCannotBeRemovedIsALeftover() throws {
    defer { RootfsCache.forceRemove(dir) }
    let sandbox = try sandbox(holdPipes: false)
    let (name, done) = try startExport(sandbox)
    sandbox.cleanup()
    #expect(sandbox.leftovers.contains("the container \(name) (remove it: docker rm -f \(name))"), "\(sandbox.leftovers)")
    #expect(done.wait(timeout: .now() + 20) == .success, "the run did not return")
    sandbox.cleanup()  // idempotent: what was left stays reported
    #expect(sandbox.leftovers.contains("the container \(name) (remove it: docker rm -f \(name))"))
  }

  @Test(.timeLimit(.minutes(1))) func processesNotReapedInTimeAreALeftover() throws {
    defer { RootfsCache.forceRemove(dir) }
    let sandbox = try sandbox(holdPipes: true, reapWait: 1)
    let (_, done) = try startExport(sandbox)
    defer {
      if let pid = try? String(contentsOf: dir.appendingPathComponent("sleeper"), encoding: .utf8)
        .trimmingCharacters(in: .whitespacesAndNewlines), let pid = pid_t(pid)
      {
        kill(pid, SIGKILL)
      }
    }
    sandbox.cleanup()
    #expect(
      sandbox.leftovers.contains { $0.hasPrefix("processes of the rootlesskit sandbox that had not ended 1 s after SIGKILL") },
      "\(sandbox.leftovers)")
    #expect(done.wait(timeout: .now() + 30) == .success, "the run did not return")
  }
}
