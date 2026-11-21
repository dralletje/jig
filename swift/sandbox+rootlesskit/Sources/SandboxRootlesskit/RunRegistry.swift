import ChildProcess
import Foundation
import Report

#if canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#endif

/// Everything the sandbox has started and not yet finished, so `cleanup()` can end it: process groups,
/// lifeline pipes, export containers and temporary folders. After `stop()` nothing new starts.
final class RunRegistry: @unchecked Sendable {
  private let lock = NSLock()
  private var stopped = false
  /// Launchers (rootlesskit), started and reaped by this package.
  private var groups: Set<pid_t> = []
  /// Docker and tar, started and reaped by `runProcess`.
  private var helpers: Set<pid_t> = []
  private var lifelines: [Int: Int32] = [:]
  private var nextLifeline = 0
  private var containers: Set<String> = []
  private var temporary: Set<String> = []

  static let interrupted = RefactorError(.INTERNAL, "the sandbox was cleaned up (interrupted); the run did not finish")

  var isStopped: Bool {
    lock.lock()
    defer { lock.unlock() }
    return stopped
  }

  /// Runs `body` (which starts a process) under the lock and records its process group, unless the
  /// registry was stopped: then nothing starts (except `gated: false`, the cleanup's own `docker rm`).
  func spawn(gated: Bool = true, _ body: () throws -> StartedChild) throws -> StartedChild {
    lock.lock()
    defer { lock.unlock() }
    if gated && stopped { throw Self.interrupted }
    let child = try body()
    groups.insert(child.pid)
    return child
  }

  /// Reaps `pid`, a launcher `spawn` recorded (it has exited; `Spawner.collect` left it a zombie), and
  /// forgets it, both under the lock: `signalGroups` never signals its group once the PID is free again.
  /// Returns the raw wait status.
  func reap(_ pid: pid_t) -> Int32 {
    lock.lock()
    defer { lock.unlock() }
    groups.remove(pid)
    return Spawner.waitAndReap(pid)
  }

  /// Sends `sig` to the process group of every launcher not reaped yet (under the lock, so none is
  /// reaped meanwhile). Returns how many were signalled.
  @discardableResult
  func signalGroups(_ sig: Int32) -> Int {
    lock.lock()
    defer { lock.unlock() }
    for group in groups { kill(-group, sig) }
    return groups.count
  }

  /// The process groups (launchers, docker, tar) not reaped yet.
  var live: [pid_t] {
    lock.lock()
    defer { lock.unlock() }
    return (Array(groups) + Array(helpers)).sorted()
  }

  var liveGroups: Int { live.count }

  /// Runs a helper process (docker, tar) to its end with `swift/process`'s `runProcess`, its group
  /// tracked so `cleanup()` can kill it (through `Lifecycle`, which never signals a reaped group).
  /// `environment` nil inherits ours. Throws `ExecutableNotFound` when there is no such command.
  func runTracked(_ executable: String, _ arguments: [String], environment: [String: String]?, gated: Bool = true)
    throws -> ProcessOutput
  {
    lock.lock()
    let refused = gated && stopped
    lock.unlock()
    if refused { throw Self.interrupted }
    var started: pid_t = 0
    defer {
      if started != 0 {
        lock.lock()
        helpers.remove(started)
        lock.unlock()
      }
    }
    return try runProcess(executable, arguments, environment: environment, gated: gated) { pid in
      started = pid
      self.lock.lock()
      defer { self.lock.unlock() }
      // `cleanup()` ran between the check above and the spawn: this one must not outlive it.
      if gated && self.stopped { kill(-pid, SIGKILL) } else { self.helpers.insert(pid) }
    }
  }

  /// Only inside `spawn`'s body, which holds the lock: a lifeline is then either closed by `stop()` or
  /// by its run, never both.
  func addLifelineLocked(_ fd: Int32) -> Int {
    nextLifeline += 1
    lifelines[nextLifeline] = fd
    return nextLifeline
  }

  /// Closes the lifeline unless `stop()` already did.
  func closeLifeline(_ token: Int) {
    lock.lock()
    let fd = lifelines.removeValue(forKey: token)
    lock.unlock()
    if let fd { close(fd) }
  }

  func addContainer(_ name: String) throws {
    lock.lock()
    defer { lock.unlock() }
    if stopped { throw Self.interrupted }
    containers.insert(name)
  }

  func removeContainer(_ name: String) {
    lock.lock()
    containers.remove(name)
    lock.unlock()
  }

  func addTemporary(_ path: String) throws {
    lock.lock()
    defer { lock.unlock() }
    if stopped { throw Self.interrupted }
    temporary.insert(path)
  }

  func removeTemporary(_ path: String) {
    lock.lock()
    temporary.remove(path)
    lock.unlock()
  }

  struct Snapshot {
    var groups: [pid_t]
    var helpers: [pid_t]
    var lifelines: [Int32]
    var containers: [String]
    var temporary: [String]
  }

  /// Stops new work and hands over what is running. Lifelines and containers are taken out (the
  /// caller ends them); groups stay until their run reaps them; temporary folders stay registered.
  func stop() -> Snapshot {
    lock.lock()
    defer { lock.unlock() }
    stopped = true
    let snapshot = Snapshot(
      groups: Array(groups), helpers: Array(helpers), lifelines: Array(lifelines.values), containers: Array(containers), temporary: Array(temporary))
    lifelines.removeAll()
    containers.removeAll()
    return snapshot
  }

  func takeTemporary() -> [String] {
    lock.lock()
    defer { lock.unlock() }
    let all = Array(temporary)
    temporary.removeAll()
    return all
  }
}
