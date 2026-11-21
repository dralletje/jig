import Report

public let usage = """
  usage: jig [--repo <path>] [--message <text>] [--sandbox docker|rootlesskit] <image> [args...]
         jig verify [--repo <path>] [--sandbox docker|rootlesskit] <commit-or-range>
  <image> is a registry reference (ghcr.io/acme/tool:1.0, node:26), which jig downloads, or
  localhost/<name>, an image in this machine's Docker.
  """

/// What the command line asks for: a run of an image (the default form) or `verify` (first argument).
public enum Command: Equatable, Sendable {
  case run(CLIArgs)
  case verify(VerifyArgs)
}

/// `jig verify [--repo <path>] [--sandbox docker|rootlesskit] <commit-or-range>`.
/// The options may come before or after the target.
public struct VerifyArgs: Equatable, Sendable {
  /// Nil means the current directory.
  public var repo: String?
  public var sandbox: SandboxKind
  /// One commit, or a range (anything with `..`).
  public var target: String

  public init(repo: String?, sandbox: SandboxKind, target: String) {
    self.repo = repo
    self.sandbox = sandbox
    self.target = target
  }

  static func parse(_ argv: [String]) throws -> VerifyArgs {
    var repo: String?
    var sandbox = SandboxKind.docker
    var targets: [String] = []
    var i = 0
    while i < argv.count {
      let arg = argv[i]
      guard arg.hasPrefix("--") else {
        targets.append(arg)
        i += 1
        continue
      }
      guard arg == "--repo" || arg == "--sandbox" else {
        throw RefactorError(code: .INVALID_ARGS, instructions: "Unknown option \(arg) for verify. \(usage)")
      }
      guard i + 1 < argv.count else {
        throw RefactorError(code: .INVALID_ARGS, instructions: "\(arg) needs a value. \(usage)")
      }
      let value = argv[i + 1]
      switch arg {
      case "--repo": repo = value
      default:
        guard let kind = SandboxKind(rawValue: value) else {
          throw RefactorError(
            code: .INVALID_ARGS, instructions: "Unknown sandbox \(value): use docker or rootlesskit. \(usage)")
        }
        sandbox = kind
      }
      i += 2
    }
    guard targets.count == 1, let target = targets.first else {
      throw RefactorError(
        code: .INVALID_ARGS,
        instructions: "verify needs exactly one <commit-or-range>, got \(targets.count). \(usage)")
    }
    return VerifyArgs(repo: repo, sandbox: sandbox, target: target)
  }
}

/// `verify` as the first argument selects verify; anything else is the run form, parsed as before.
public func parseCommand(_ argv: [String]) throws -> Command {
  if argv.first == "verify" {
    return .verify(try VerifyArgs.parse(Array(argv.dropFirst())))
  }
  return .run(try CLIArgs.parse(argv))
}

/// Where the image runs (`--sandbox`).
public enum SandboxKind: String, CaseIterable, Equatable, Sendable {
  /// `docker run` (`DockerSandbox`); the default.
  case docker
  /// The same images as direct children of the binary, with rootlesskit and namespaces, without a daemon
  /// (`RootlesskitSandbox`).
  case rootlesskit

  /// What a run of this sandbox leaves running until its cleanup: named in the interruption's line.
  var runningThing: String {
    switch self {
    case .docker: return "container"
    case .rootlesskit: return "sandbox"
    }
  }
}

/// `jig [--repo <path>] [--message <text>] [--sandbox docker|rootlesskit] <image> [args...]`.
/// Only the options before the image are ours; everything after it goes to the image verbatim, even
/// values starting with `--`.
public struct CLIArgs: Equatable, Sendable {
  /// Nil means the current directory.
  public var repo: String?
  public var message: String?
  public var sandbox: SandboxKind
  public var image: String
  public var args: [String]

  public static func parse(_ argv: [String]) throws -> CLIArgs {
    var repo: String?
    var message: String?
    var sandbox = SandboxKind.docker
    var i = 0
    while i < argv.count, argv[i].hasPrefix("--") {
      let flag = argv[i]
      guard flag == "--repo" || flag == "--message" || flag == "--sandbox" else {
        throw RefactorError(code: .INVALID_ARGS, instructions: "Unknown option \(flag). \(usage)")
      }
      guard i + 1 < argv.count else {
        throw RefactorError(code: .INVALID_ARGS, instructions: "\(flag) needs a value. \(usage)")
      }
      let value = argv[i + 1]
      switch flag {
      case "--repo": repo = value
      case "--message": message = value
      default:
        guard let kind = SandboxKind(rawValue: value) else {
          throw RefactorError(
            code: .INVALID_ARGS, instructions: "Unknown sandbox \(value): use docker or rootlesskit. \(usage)")
        }
        sandbox = kind
      }
      i += 2
    }
    guard i < argv.count else {
      throw RefactorError(code: .INVALID_ARGS, instructions: "Missing <image>. \(usage)")
    }
    return CLIArgs(repo: repo, message: message, sandbox: sandbox, image: argv[i], args: Array(argv[(i + 1)...]))
  }
}
