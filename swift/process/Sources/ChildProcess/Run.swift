import Dispatch
import Foundation
import Report

#if canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#endif

extension Termination {
  /// A raw `waitpid` status.
  public init(waitStatus raw: Int32) {
    self = raw & 0x7f == 0 ? .exited((raw >> 8) & 0xff) : .signaled(raw & 0x7f)
  }
}

/// What a finished process left: how it ended and everything it wrote.
public struct ProcessOutput: Sendable {
  public var termination: Termination
  public var stdout: Data
  public var stderr: Data

  public init(termination: Termination, stdout: Data, stderr: Data) {
    self.termination = termination
    self.stdout = stdout
    self.stderr = stderr
  }

  public var succeeded: Bool { termination.succeeded }
  public var stdoutText: String { String(decoding: stdout, as: UTF8.self) }
  public var stderrText: String { String(decoding: stderr, as: UTF8.self) }
}

/// An external command that ended badly where that is unexpected. Reported as `INTERNAL` (with
/// instructions) unless the caller turns it into one of our codes.
public struct CommandFailed: Error, CustomStringConvertible, RefactorErrorConvertible {
  public var command: [String]
  public var termination: Termination
  public var stderr: String

  public init(command: [String], termination: Termination, stderr: String) {
    self.command = command
    self.termination = termination
    self.stderr = stderr
  }

  public var description: String {
    "\(command.joined(separator: " ")) failed (\(termination)): \(stderr.trimmingCharacters(in: .whitespacesAndNewlines))"
  }

  /// `INTERNAL`, with what to check next for the command that failed (git, docker, tar, or any other).
  public var refactorError: RefactorError {
    let tool = command.first.map { ($0 as NSString).lastPathComponent } ?? ""
    let next =
      switch tool {
      case "git":
        "Check that git works in this repository (git status, git fsck; also hooks, filters and config it "
          + "runs), fix what it reports, then run again."
      case "docker": "Check that docker works for you (docker info), fix what it reports, then run again."
      case "tar":
        "Check that tar works (tar --version) and that there is free disk space for what it unpacks, fix what it "
          + "reports, then run again."
      default: "Check that \(tool.isEmpty ? "the command" : tool) works for you, fix what it reports, then run again."
      }
    return RefactorError(code: .INTERNAL, instructions: "\(self). \(next)")
  }
}

/// An executable is not on `PATH` (or not at the path given). git is the binary's own need; each sandbox
/// turns this into its own instructions for the tools it uses (docker, rootlesskit, tar, …).
public struct ExecutableNotFound: Error, CustomStringConvertible, RefactorErrorConvertible {
  public var name: String

  public init(name: String) { self.name = name }

  public var description: String { "\(name) was not found on PATH" }

  public var refactorError: RefactorError {
    let next =
      name == "git"
      ? "jig needs git on PATH: install git or fix PATH, then run again."
      : "Install it or fix PATH, then run again."
    return RefactorError(code: .INTERNAL, instructions: "\(self). \(next)")
  }
}

/// Output read by a drain thread. A straggler may still be writing when the run gives up waiting on the
/// pipes, so the thread appends and the run reads under a lock.
private final class DataBox: @unchecked Sendable {
  private let lock = NSLock()
  private var buffer = Data()

  func append(_ bytes: ArraySlice<UInt8>) {
    lock.lock()
    buffer.append(contentsOf: bytes)
    lock.unlock()
  }

  /// What was read so far.
  var data: Data {
    lock.lock()
    defer { lock.unlock() }
    return buffer
  }
}

/// `name` itself when it is a path (holds a `/`), else the first executable `name` on `PATH`.
public func findExecutable(_ name: String) throws -> String {
  if name.contains("/") {
    guard FileManager.default.isExecutableFile(atPath: name) else { throw ExecutableNotFound(name: name) }
    return name
  }
  let path = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/local/bin:/usr/bin:/bin"
  for dir in path.split(separator: ":") where !dir.isEmpty {
    let candidate = URL(fileURLWithPath: String(dir)).appendingPathComponent(name).path
    if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
  }
  throw ExecutableNotFound(name: name)
}

/// Reads `fd` to its end on a thread of its own, then closes it.
private func drain(_ fd: Int32, into box: DataBox, _ group: DispatchGroup) {
  group.enter()
  Thread.detachNewThread {
    var buffer = [UInt8](repeating: 0, count: 65536)
    while true {
      let n = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
      if n > 0 {
        box.append(buffer[0..<n])
      } else if n < 0 && errno == EINTR {
        continue
      } else {
        break
      }
    }
    close(fd)
    group.leave()
  }
}

/// Writes `data` to `fd` on a thread of its own, then closes it. A child that stops reading early only
/// makes the write fail (SIGPIPE is ignored).
private func feed(_ fd: Int32, _ data: Data) {
  Thread.detachNewThread {
    // A child that exits without reading must not kill us with SIGPIPE (in a test runner, say, which
    // does not ignore it): blocked in this thread, the write fails with EPIPE instead.
    var block = sigset_t()
    sigemptyset(&block)
    sigaddset(&block, SIGPIPE)
    pthread_sigmask(SIG_BLOCK, &block, nil)
    data.withUnsafeBytes { raw in
      var offset = 0
      while offset < raw.count {
        let n = write(fd, raw.baseAddress! + offset, raw.count - offset)
        if n > 0 {
          offset += n
        } else if n < 0 && errno == EINTR {
          continue
        } else {
          break
        }
      }
    }
    close(fd)
  }
}

/// How long to wait for the output pipes to close after the process exited, before the rest of its
/// process group (whatever still holds the pipes) is killed.
private let pipeGrace = 5.0

/// Runs `executable` with `arguments` (never through a shell) in a process group of its own and waits
/// for it. `environment` is the child's whole environment; nil inherits ours. The child starts with the
/// default action for SIGINT, SIGTERM, SIGHUP and SIGPIPE (we ignore them ourselves).
///
/// While the binary is being interrupted no new process starts (the call blocks until the process
/// exits), except one with `gated: false`: a cleanup's own command (`DockerSandbox`'s `docker rm -f`).
/// The process group is known to `Lifecycle`, which kills it on interruption.
///
/// `onStart` gets the child's PID (its process group) right after it started, while `Lifecycle`'s lock
/// is held: it must be quick and must not call into `Lifecycle`. A caller that wants to stop the process
/// itself (a sandbox's `cleanup()`) signals it with `Lifecycle.shared.signalGroup(_:_:)`, which never
/// hits the group once the PID has been reaped.
public func runProcess(
  _ executable: String, _ arguments: [String], cwd: URL? = nil, environment: [String: String]? = nil,
  stdin: Data? = nil, gated: Bool = true, onStart: ((pid_t) -> Void)? = nil
) throws -> ProcessOutput {
  let path = try findExecutable(executable)
  let env = (environment ?? ProcessInfo.processInfo.environment).map { "\($0.key)=\($0.value)" }

  var actions = posix_spawn_file_actions_t()
  posix_spawn_file_actions_init(&actions)
  defer { posix_spawn_file_actions_destroy(&actions) }
  var attributes = posix_spawnattr_t()
  posix_spawnattr_init(&attributes)
  defer { posix_spawnattr_destroy(&attributes) }
  posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK))
  posix_spawnattr_setpgroup(&attributes, 0)  // a new group, whose ID is the child's PID
  var defaults = sigset_t()
  sigemptyset(&defaults)
  for sig in [SIGINT, SIGTERM, SIGHUP, SIGPIPE] { sigaddset(&defaults, sig) }
  posix_spawnattr_setsigdefault(&attributes, &defaults)
  var mask = sigset_t()
  sigemptyset(&mask)
  posix_spawnattr_setsigmask(&attributes, &mask)

  let cArgs: [UnsafeMutablePointer<CChar>?] = ([path] + arguments).map { strdup($0) } + [nil]
  let cEnv: [UnsafeMutablePointer<CChar>?] = env.map { strdup($0) } + [nil]
  defer {
    for p in cArgs { free(p) }
    for p in cEnv { free(p) }
  }

  var outFds: [Int32] = [-1, -1]
  var errFds: [Int32] = [-1, -1]
  var inFds: [Int32] = [-1, -1]
  var spawnError: Int32 = 0
  // Pipes are close-on-exec and made and handed to the child under Lifecycle's lock, so a process
  // spawned at the same time by another thread (the cleanup) never inherits them.
  let spawned: pid_t? = Lifecycle.shared.spawn(gated: gated) {
    guard pipe(&outFds) == 0, pipe(&errFds) == 0, pipe(&inFds) == 0 else {
      spawnError = errno
      for fd in outFds + errFds + inFds where fd >= 0 { close(fd) }
      return nil
    }
    for fd in outFds + errFds + inFds { _ = fcntl(fd, F_SETFD, FD_CLOEXEC) }
    posix_spawn_file_actions_adddup2(&actions, inFds[0], 0)
    posix_spawn_file_actions_adddup2(&actions, outFds[1], 1)
    posix_spawn_file_actions_adddup2(&actions, errFds[1], 2)
    if let cwd { posix_spawn_file_actions_addchdir_np(&actions, cwd.path) }
    var pid: pid_t = 0
    spawnError = posix_spawn(&pid, path, &actions, &attributes, cArgs, cEnv)
    close(inFds[0])
    close(outFds[1])
    close(errFds[1])
    guard spawnError == 0 else {
      close(inFds[1])
      close(outFds[0])
      close(errFds[0])
      return nil
    }
    onStart?(pid)
    return pid
  }
  guard let pid = spawned else {
    throw CommandFailed(
      command: [executable] + arguments, termination: .exited(127),
      stderr: "could not start: \(String(cString: strerror(spawnError)))")
  }

  // Read both pipes and write stdin at the same time, so a full pipe never blocks the child.
  let pipes = DispatchGroup()
  let out = DataBox()
  let err = DataBox()
  drain(outFds[0], into: out, pipes)
  drain(errFds[0], into: err, pipes)
  feed(inFds[1], stdin ?? Data())

  // Wait for the exit without reaping: while the child is a zombie its PID (the group's ID) cannot be
  // reused, so signalling the group (here, or from `Lifecycle` on an interruption) never hits another.
  waitForExitWithoutReaping(pid)

  // Something the child left in its group may still hold the pipes: kill it rather than wait forever.
  if pipes.wait(timeout: .now() + pipeGrace) == .timedOut {
    kill(-pid, SIGKILL)
    _ = pipes.wait(timeout: .now() + pipeGrace)
  }
  let raw = Lifecycle.shared.reap(pid)
  return ProcessOutput(termination: Termination(waitStatus: raw), stdout: out.data, stderr: err.data)
}

/// Blocks until `pid` has exited, leaving it a zombie (`WNOWAIT`).
private func waitForExitWithoutReaping(_ pid: pid_t) {
  var info = siginfo_t()
  while waitid(P_PID, id_t(pid), &info, WEXITED | WNOWAIT) < 0 && errno == EINTR {}
}
