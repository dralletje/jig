import Dispatch
import Foundation
import Report

#if canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#endif

/// Where a run is, as far as an interruption (SIGINT, SIGTERM, SIGHUP) is concerned. Pure state, so the
/// decisions can be tested without signals.
struct InterruptState: Equatable {
  enum Phase: Equatable {
    /// Anything before or after the fast-forward: an interruption stops the run at once.
    case running
    /// Inside the fast-forward merge: an interruption waits for it.
    case merging
    /// Interrupted: the cleanup runs, and the run must neither start processes nor print.
    case stopping
    /// The result is being printed: an interruption is too late to matter.
    case finished
  }

  enum SignalAction: Equatable {
    case stop
    case wait
    case ignore
  }

  var phase = Phase.running
  /// The first signal that arrived during the merge.
  var pending: Int32?

  mutating func signal(_ sig: Int32) -> SignalAction {
    switch phase {
    case .running:
      phase = .stopping
      return .stop
    case .merging:
      if pending == nil { pending = sig }
      return .wait
    case .stopping, .finished:
      return .ignore
    }
  }

  /// False when an interruption is already being handled: the merge must not start.
  mutating func enterMerge() -> Bool {
    guard phase == .running else { return false }
    phase = .merging
    return true
  }

  /// The signal that arrived during the merge (the run now stops), or nil.
  mutating func leaveMerge() -> Int32? {
    guard phase == .merging else { return nil }
    if let pending {
      phase = .stopping
      return pending
    }
    phase = .running
    return nil
  }

  /// False when an interruption is being handled: its output wins.
  mutating func finish() -> Bool {
    guard phase == .running else { return false }
    phase = .finished
    return true
  }

  var mayStartProcesses: Bool { phase == .running || phase == .merging }
}

/// The signal's name for the instructions.
public func signalName(_ sig: Int32) -> String {
  switch sig {
  case SIGINT: return "SIGINT"
  case SIGTERM: return "SIGTERM"
  case SIGHUP: return "SIGHUP"
  default: return "signal \(sig)"
  }
}

/// How long an interruption waits after SIGTERM before it SIGKILLs what is left of the run's processes.
let termGrace = 2.0

/// Never returns: the thread waits for the cleanup to end the process.
func park() -> Never {
  while true { sleep(1000) }
}

/// The run's processes and cleanups (the sandbox's, the temporary folders'), so an interruption can
/// clean them up, and the one place that decides who prints the result and exits: the run, or the
/// interruption.
///
/// On SIGINT, SIGTERM or SIGHUP outside the merge window: no new process starts (a gated spawn parks
/// its thread), every process group started by `runProcess` gets SIGTERM (so git removes its lock files
/// and its filters can clean up), and SIGKILL when it is still there 2 s later, and is waited for (up
/// to 5 s more); the cleanups run in the order they were added, the interruption's line (naming what
/// the cleanups could not remove) is printed and the binary exits with 128 + the signal number. Inside
/// the merge window the signal waits for it.
///
/// A process group is only signalled while its leader is not reaped (`runProcess` reaps it with
/// `reap(_:)`, under the same lock), so a PID the kernel has given to another process is never signalled.
public final class Lifecycle: @unchecked Sendable {
  public static let shared = Lifecycle()

  private let lock = NSLock()
  private var state = InterruptState()
  private var children: Set<pid_t> = []
  private var cleanups: [@Sendable () -> [String]] = []
  private var landed: String?
  private var reporter: (@Sendable (_ signal: Int32, _ landed: String?, _ leftovers: [String]) -> String)?

  /// Runs `body` (which spawns a process) under the lock and records the PID it returns. While an
  /// interruption is handled, a gated spawn never happens: the calling thread parks.
  func spawn(gated: Bool, _ body: () -> pid_t?) -> pid_t? {
    lock.lock()
    if gated && !state.mayStartProcesses {
      lock.unlock()
      park()
    }
    let pid = body()
    if let pid { children.insert(pid) }
    lock.unlock()
    return pid
  }

  /// Reaps `pid` (which has exited) and forgets it, both under the lock, so an interruption never
  /// signals its group once the PID is free again. Returns the raw wait status.
  func reap(_ pid: pid_t) -> Int32 {
    lock.lock()
    defer { lock.unlock() }
    children.remove(pid)
    var raw: Int32 = 0
    while waitpid(pid, &raw, 0) < 0 && errno == EINTR {}
    return raw
  }

  /// Sends `sig` to the process group of `pid`, a process `runProcess` started, if it has not been reaped
  /// yet (under the lock, so a PID the kernel has given to another process is never signalled). Returns
  /// whether it was signalled.
  @discardableResult
  public func signalGroup(_ pid: pid_t, _ sig: Int32) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard children.contains(pid) else { return false }
    kill(-pid, sig)
    return true
  }

  /// Runs `body` unless an interruption is being handled; then the thread parks, as a gated spawn does.
  /// For making something that a cleanup removes: the interruption's cleanup runs before `body` or after
  /// it, never during it.
  public func gated<T>(_ body: () throws -> T) rethrows -> T {
    lock.lock()
    if !state.mayStartProcesses {
      lock.unlock()
      park()
    }
    defer { lock.unlock() }
    return try body()
  }

  /// Runs `body` unless an interruption is being handled: then its cleanup owns the work, and `body`
  /// must not race it (removing a folder the sandbox may still be writing into, say). An interruption
  /// that arrives meanwhile waits for `body`.
  public func unlessInterrupted(_ body: () -> Void) {
    lock.lock()
    defer { lock.unlock() }
    if state.phase != .stopping { body() }
  }

  /// Adds `body` to what an interruption runs once the run's processes are gone, after the cleanups
  /// added before it. It runs on the signal queue while the run's thread may be anywhere, so it must be
  /// idempotent and must not wait for that thread. Gated processes do not start any more by then: a
  /// cleanup runs its own commands with `runProcess(..., gated: false)`.
  public func addCleanup(_ body: @escaping @Sendable () -> Void) {
    addCleanup(reporting: {
      body()
      return []
    })
  }

  /// The same, for a cleanup that returns what it could not remove, each as a phrase that says how to
  /// remove it by hand ("the container X (remove it: docker rm -f X)"); the interruption's line names them.
  public func addCleanup(reporting body: @escaping @Sendable () -> [String]) {
    lock.lock()
    cleanups.append(body)
    lock.unlock()
  }

  /// Whether an interruption is being handled (its cleanup runs, or is about to).
  public var isInterrupted: Bool {
    lock.lock()
    defer { lock.unlock() }
    return state.phase == .stopping
  }

  /// Runs the fast-forward with interruptions held back: one that arrives during it is handled after
  /// it, reporting the commit when `landed()` says it is in place.
  public func mergeWindow<T>(commit: String, landed didLand: () -> Bool, _ body: () throws -> T) throws -> T {
    lock.lock()
    guard state.enterMerge() else {
      lock.unlock()
      park()
    }
    lock.unlock()
    let result = Result { try body() }
    let landedNow = didLand()
    lock.lock()
    if landedNow { landed = commit }
    let pending = state.leaveMerge()
    lock.unlock()
    if let pending { stop(pending) }
    return try result.get()
  }

  /// A signal arrived (on the signal queue).
  func interrupt(_ sig: Int32) {
    lock.lock()
    let action = state.signal(sig)
    lock.unlock()
    if action == .stop { stop(sig) }
  }

  func setReporter(_ report: @escaping @Sendable (_ signal: Int32, _ landed: String?, _ leftovers: [String]) -> String) {
    lock.lock()
    reporter = report
    lock.unlock()
  }

  /// Prints the run's result and exits, unless an interruption is being handled: then its output wins.
  func finish(_ line: String, status: Int32) -> Never {
    lock.lock()
    guard state.finish() else {
      lock.unlock()
      park()
    }
    lock.unlock()
    emit(line)
    exit(status)
  }

  /// Sends `sig` to every process group whose leader is not reaped yet (under the lock, so none is
  /// reaped meanwhile).
  private func signalChildren(_ sig: Int32) {
    lock.lock()
    for pid in children { kill(-pid, sig) }
    lock.unlock()
  }

  /// Waits until every child is reaped, or `seconds` pass; true when they are all gone.
  private func waitForChildren(seconds: Double) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while true {
      lock.lock()
      let alive = !children.isEmpty
      lock.unlock()
      if !alive { return true }
      if Date() >= deadline { return false }
      usleep(20_000)
    }
  }

  /// Stops the run's processes (SIGTERM, a grace, SIGKILL), runs the cleanups, prints the interruption's
  /// line and exits with 128 + the signal number. The state is already `.stopping`.
  private func stop(_ sig: Int32) -> Never {
    lock.lock()
    let steps = cleanups
    let commit = landed
    let report = reporter
    lock.unlock()

    // The processes must be gone before the cleanups run: a docker client could still start its
    // container after it was removed.
    signalChildren(SIGTERM)
    if !waitForChildren(seconds: termGrace) {
      signalChildren(SIGKILL)
      _ = waitForChildren(seconds: 5)
    }
    var leftovers: [String] = []
    for step in steps { leftovers += step() }

    let line =
      report?(sig, commit, leftovers)
      ?? errorJSON(RefactorError(code: .INTERNAL, instructions: "interrupted by \(signalName(sig))"))
    emit(line)
    _exit(128 + sig)
  }
}

/// One line on stdout, written at once (no buffering shared with another thread).
private func emit(_ line: String) {
  let data = Array((line + "\n").utf8)
  var offset = 0
  while offset < data.count {
    let n = data[offset...].withUnsafeBytes { write(1, $0.baseAddress, $0.count) }
    if n > 0 {
      offset += n
    } else if n < 0 && errno == EINTR {
      continue
    } else {
      break
    }
  }
}

private let signalQueue = DispatchQueue(label: "jig.signals")
nonisolated(unsafe) private var signalSources: [any DispatchSourceSignal] = []

/// Handles SIGINT, SIGTERM and SIGHUP on a queue of their own: the run is cleaned up (see `Lifecycle`)
/// and `report(signal, landed, leftovers)` gives the one line to print (`landed` is the commit when the
/// signal arrived during the merge window and the commit landed; `leftovers` what the cleanups could not
/// remove, empty when everything is gone). Call once, before the run starts.
public func installInterruptHandlers(
  report: @escaping @Sendable (_ signal: Int32, _ landed: String?, _ leftovers: [String]) -> String
) {
  Lifecycle.shared.setReporter(report)
  for sig in [SIGINT, SIGTERM, SIGHUP] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: signalQueue)
    source.setEventHandler { Lifecycle.shared.interrupt(sig) }
    source.resume()
    signalSources.append(source)
  }
}

/// Prints `line` (the one JSON object) and exits with `status`, unless an interruption is being
/// handled, which prints its own and exits.
public func finishRun(_ line: String, status: Int32) -> Never {
  Lifecycle.shared.finish(line, status: status)
}
