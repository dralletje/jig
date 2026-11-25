import RefactorCLI
import ChildProcess
import Foundation
import Report

#if canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(Darwin)
  import Darwin
#endif

// The rootlesskit sandbox's hidden modes (launcher, in-sandbox init) run before this, from a C constructor.

// A child that closes its stdin early must not kill us with SIGPIPE; the write just fails.
signal(SIGPIPE, SIG_IGN)
// SIGINT, SIGTERM and SIGHUP kill the run's processes, run the sandbox's cleanup (the container, the
// rootlesskit sandbox) and remove the temporary folders, print an INTERNAL
// failure and exit with 128 + the signal number (130, 143, 129).
installInterruptHandlers(report: interruptedJSON)

/// Prints exactly one JSON object on stdout and exits 0 on success (a run that committed, a verify that
/// is ok, an image's help), 1 otherwise. Three exceptions print text: `jig --help` (the usage),
/// `jig --version` (`jig <version>`), and an image's help when stdout is a terminal.
do {
  let command = try parseCommand(Array(CommandLine.arguments.dropFirst()))
  let kind: SandboxKind
  switch command {
  case .run(let cli): kind = cli.sandbox
  case .verify(let args): kind = args.sandbox
  case .help(let args): kind = args.sandbox
  case .usage: finishRun(usage, status: 0)
  case .version: finishRun("jig \(version)", status: 0)
  }
  setInterruptedSandbox(kind)
  let sandbox = try makeSandbox(kind)
  Lifecycle.shared.addCleanup(reporting: {
    sandbox.cleanup()
    return sandbox.leftovers
  })
  let cwd = FileManager.default.currentDirectoryPath
  switch command {
  case .run(let cli):
    let result = try runImage(
      repo: cli.repo ?? cwd, image: cli.image, args: cli.args, message: cli.message, sandbox: sandbox)
    finishRun(result.json, status: 0)
  case .verify(let args):
    let results = try verifyCommits(repo: args.repo ?? cwd, target: args.target, sandbox: sandbox)
    let printed = verifyJSON(results)
    finishRun(printed.json, status: printed.ok ? 0 : 1)
  case .help(let args):
    let answer = try imageHelp(image: args.image, action: args.action, sandbox: sandbox)
    if isatty(STDOUT_FILENO) != 0 {
      finishRun(helpText(image: answer.image, notes: answer.notes, help: answer.help, action: args.action), status: 0)
    }
    finishRun(helpJSON(image: answer.image, notes: answer.notes, help: answer.help), status: 0)
  case .usage:
    finishRun(usage, status: 0)
  case .version:
    finishRun("jig \(version)", status: 0)
  }
} catch {
  finishRun(errorJSON(RefactorError.from(error)), status: 1)
}
