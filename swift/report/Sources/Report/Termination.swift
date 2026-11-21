/// How a process ended: with an exit code, or killed by a signal. The report names it when an image
/// fails ("exit code 3", "killed by signal 9"); `ChildProcess` decodes it from a wait status.
public enum Termination: Equatable, Sendable, CustomStringConvertible {
  case exited(Int32)
  case signaled(Int32)

  public var succeeded: Bool { self == .exited(0) }

  /// `exit code N` or `killed by signal N`.
  public var description: String {
    switch self {
    case .exited(let code): return "exit code \(code)"
    case .signaled(let signal): return "killed by signal \(signal)"
    }
  }
}
