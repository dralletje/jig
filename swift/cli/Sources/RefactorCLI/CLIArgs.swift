import Report

public let usage = """
  usage: jig [--repo <path>] [--message <text>] [--sandbox docker|rootlesskit] <image> [args...]
         jig verify [--repo <path>] [--sandbox docker|rootlesskit] <commit-or-range>
         jig [--sandbox docker|rootlesskit] <image> [--help]
         jig [--sandbox docker|rootlesskit] <image> <action> --help
         jig --version
  The <image> --help forms show what an image can do: its actions, or one action's flags (no repo needed).
  <image> is a registry reference (ghcr.io/acme/tool:1.0, node:26), which jig downloads, or
  localhost/<name>, an image in this machine's Docker.
  """

/// What the command line asks for: a run of an image (the default form), `verify` (first argument), an
/// image's help (`<image>`, `<image> --help`, `<image> <action> --help`), jig's usage (`--help` alone) or
/// jig's version (`--version` alone).
public enum Command: Equatable, Sendable {
  case run(CLIArgs)
  case verify(VerifyArgs)
  case help(HelpArgs)
  case usage
  case version
}

/// `jig [--repo <path>] [--sandbox docker|rootlesskit] <image> [<action>] --help`, or `<image>` alone.
/// `--repo` is accepted and ignored: help needs no repo.
public struct HelpArgs: Equatable, Sendable {
  public var sandbox: SandboxKind
  public var image: String
  /// The action whose flags to show; nil shows every action.
  public var action: String?

  public init(sandbox: SandboxKind, image: String, action: String?) {
    self.sandbox = sandbox
    self.image = image
    self.action = action
  }
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

/// `verify` as the first argument selects verify; `--help` alone is jig's usage. Anything else is the run
/// form, parsed as before, and a help call when the image's arguments are exactly `[]`, `["--help"]` or
/// `[<action>, "--help"]` (so `move --to --help` stays a run, with `--help` as a value).
public func parseCommand(_ argv: [String]) throws -> Command {
  if argv.first == "verify" {
    return .verify(try VerifyArgs.parse(Array(argv.dropFirst())))
  }
  if argv == ["--help"] {
    return .usage
  }
  if argv == ["--version"] {
    return .version
  }
  let cli = try CLIArgs.parse(argv)
  let action: String?
  if cli.args.isEmpty || cli.args == ["--help"] {
    action = nil
  } else if cli.args.count == 2, cli.args[1] == "--help" {
    action = cli.args[0]
  } else {
    // A run's first image argument is the action its commit subject names, `<kind>(<image> <action>): `.
    if let problem = actionProblem(cli.args[0]) {
      throw RefactorError(
        code: .INVALID_ARGS,
        instructions: "The first argument after the image must be an action name, not starting with - and without whitespace: \(problem). "
          + "jig <image> lists the image's actions. \(usage)")
    }
    return .run(cli)
  }
  if cli.message != nil {
    throw RefactorError(
      code: .INVALID_ARGS,
      instructions: "--message has no meaning when asking an image for help: leave it out. \(usage)")
  }
  return .help(HelpArgs(sandbox: cli.sandbox, image: cli.image, action: action))
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
