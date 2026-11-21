import CSandboxInit
import ChildProcess
import Foundation
import Report

#if canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#endif

/// What a finished child left.
struct ChildOutput: Sendable {
  var termination: Termination
  var stdout: Data
  var stderr: Data
  var stderrText: String { String(decoding: stderr, as: UTF8.self) }
  var stdoutText: String { String(decoding: stdout, as: UTF8.self) }
  var succeeded: Bool { termination == .exited(0) }
}

/// A child process that has been started: its PID is also its process group.
struct StartedChild: Sendable {
  var pid: pid_t
  var stdoutFd: Int32
  var stderrFd: Int32
}

/// How the sandbox's launcher is started. Docker and tar go through `swift/process`'s `runProcess`; the
/// launcher cannot, because its stdin must be the read end of a pipe the caller keeps the write end of
/// (the lifeline), and its PID must be in the run registry before anything else can happen. Argv only,
/// never a shell; a process group of its own; the whole environment given explicitly; stdin either
/// /dev/null or the lifeline. All pipe ends on our side are close-on-exec, so a process spawned
/// concurrently never inherits them.
enum Spawner {
  struct SpawnError: Error, CustomStringConvertible {
    var description: String
  }

  /// Starts `path` with `arguments`. `stdinFd` (nil: /dev/null) becomes the child's stdin.
  static func start(path: String, arguments: [String], environment: [String], stdinFd: Int32?) throws -> StartedChild {
    var outPipe: [Int32] = [-1, -1]
    var errPipe: [Int32] = [-1, -1]
    guard rc_pipe_cloexec(&outPipe) == 0 else { throw SpawnError(description: "pipe: \(String(cString: strerror(errno)))") }
    guard rc_pipe_cloexec(&errPipe) == 0 else {
      close(outPipe[0])
      close(outPipe[1])
      throw SpawnError(description: "pipe: \(String(cString: strerror(errno)))")
    }

    var actions = posix_spawn_file_actions_t()
    posix_spawn_file_actions_init(&actions)
    defer { posix_spawn_file_actions_destroy(&actions) }
    if let stdinFd {
      posix_spawn_file_actions_adddup2(&actions, stdinFd, 0)
    } else {
      posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
    }
    posix_spawn_file_actions_adddup2(&actions, outPipe[1], 1)
    posix_spawn_file_actions_adddup2(&actions, errPipe[1], 2)

    var attributes = posix_spawnattr_t()
    posix_spawnattr_init(&attributes)
    defer { posix_spawnattr_destroy(&attributes) }
    posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK))
    posix_spawnattr_setpgroup(&attributes, 0)
    var defaults = sigset_t()
    sigemptyset(&defaults)
    for sig in [SIGINT, SIGTERM, SIGHUP, SIGPIPE, SIGCHLD] { sigaddset(&defaults, sig) }
    posix_spawnattr_setsigdefault(&attributes, &defaults)
    var mask = sigset_t()
    sigemptyset(&mask)
    posix_spawnattr_setsigmask(&attributes, &mask)

    let cArgs: [UnsafeMutablePointer<CChar>?] = ([path] + arguments).map { strdup($0) } + [nil]
    let cEnv: [UnsafeMutablePointer<CChar>?] = environment.map { strdup($0) } + [nil]
    defer {
      for p in cArgs { free(p) }
      for p in cEnv { free(p) }
    }
    var pid: pid_t = 0
    let rc = posix_spawn(&pid, path, &actions, &attributes, cArgs, cEnv)
    close(outPipe[1])
    close(errPipe[1])
    guard rc == 0 else {
      close(outPipe[0])
      close(errPipe[0])
      throw SpawnError(description: "could not start \(path): \(String(cString: strerror(rc)))")
    }
    return StartedChild(pid: pid, stdoutFd: outPipe[0], stderrFd: errPipe[0])
  }

  /// Reads both pipes to their end, then has `reap` reap the child and returns its raw wait status. Until
  /// then the child is only waited for with `WNOWAIT`: once it exited it stays a zombie, so its PID (its
  /// process group's ID) cannot be reused while anyone may still signal the group. A caller that signals
  /// the group from another thread (`cleanup()`) reaps under the same lock it signals under
  /// (`RunRegistry.reap`). Once the child itself exited, whatever still holds the pipes gets `grace`
  /// seconds, then its process group is killed.
  static func collect(_ child: StartedChild, grace: Double = 5, reap: (pid_t) -> Int32 = waitAndReap) -> ChildOutput {
    var out = Data()
    var err = Data()
    var fds: [Int32] = [child.stdoutFd, child.stderrFd]
    var exited = false
    var deadline: Date?
    var buffer = [UInt8](repeating: 0, count: 65536)
    while fds.contains(where: { $0 >= 0 }) {
      var pollFds = fds.map { pollfd(fd: $0, events: Int16(POLLIN), revents: 0) }
      let r = poll(&pollFds, nfds_t(pollFds.count), 100)
      if r < 0 && errno != EINTR { break }
      for i in 0..<pollFds.count where pollFds[i].fd >= 0 && pollFds[i].revents != 0 {
        let n = buffer.withUnsafeMutableBytes { read(pollFds[i].fd, $0.baseAddress, $0.count) }
        if n > 0 {
          if i == 0 { out.append(contentsOf: buffer[0..<n]) } else { err.append(contentsOf: buffer[0..<n]) }
        } else if n == 0 || (errno != EINTR && errno != EAGAIN) {
          close(fds[i])
          fds[i] = -1
        }
      }
      if !exited {
        // An error (no such child) cannot turn into an exit later: stop waiting for one.
        if rc_child_exited(child.pid, 0) != 0 {
          exited = true
          deadline = Date().addingTimeInterval(grace)
        }
      } else if let deadline, Date() > deadline {
        // Still unreaped: the group ID is still this child's.
        kill(-child.pid, SIGKILL)
        for fd in fds where fd >= 0 { close(fd) }
        fds = [-1, -1]
      }
    }
    if !exited { _ = rc_child_exited(child.pid, 1) }
    return ChildOutput(termination: termination(reap(child.pid)), stdout: out, stderr: err)
  }

  /// Reaps `pid` (which has exited) and returns its raw wait status.
  static func waitAndReap(_ pid: pid_t) -> Int32 {
    var status: Int32 = 0
    while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
    return status
  }

  /// Runs to the end: `start`, then `collect`.
  static func run(path: String, arguments: [String], environment: [String], onStart: (pid_t) -> Void = { _ in })
    throws -> ChildOutput
  {
    let child = try start(path: path, arguments: arguments, environment: environment, stdinFd: nil)
    onStart(child.pid)
    return collect(child)
  }

  static func termination(_ status: Int32) -> Termination { Termination(waitStatus: status) }

  /// `name` itself when it holds a slash, else the first executable `name` on PATH.
  static func find(_ name: String) -> String? { try? findExecutable(name) }
}
