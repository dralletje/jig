// Image help end to end: `jig <image> [--help]` and `jig <image> <action> --help`, run from a folder
// that is not a git repo, for every image this repo builds and for one that gives no help (the probe).
import Foundation
import Testing

private let FS = "localhost/jig/fs:local"
private let CODEMOD = "localhost/jig/codemod-react:local"

/// Builds the fs and codemod-react images once (the shared `setup()` builds the binary, typescript,
/// prettier and the probe).
private let builtHelpImages: Result<Void, any Error> = Result {
  try setup()
  let build = try runCommand(
    ["sh", repoRoot.appendingPathComponent("scripts/build-images.sh").path, "fs", "codemod-react"], cwd: repoRoot,
    timeout: 1800)
  guard build.exitCode == 0 else {
    throw TestFailure("build-images.sh fs codemod-react failed (exit \(build.exitCode)):\n\(build.stderrText)")
  }
}

private struct HelpImagesBuilt: SuiteTrait, TestScoping {
  var isRecursive: Bool { false }

  func provideScope(
    for test: Test, testCase: Test.Case?, performing function: @Sendable () async throws -> Void
  ) async throws {
    try builtHelpImages.get()
    try await function()
  }
}

/// Runs the binary with `argv` in `cwd`; its stdout must be exactly one JSON object on one line.
private func jig(_ argv: [String], cwd: URL) throws -> (exitCode: Int32, json: JSON, stdout: String) {
  let finished = try runCommand([try setup()] + argv, cwd: cwd)
  let stdout = finished.stdoutText
  #expect(
    stdout.hasSuffix("\n") && stdout.firstIndex(of: "\n") == stdout.index(before: stdout.endIndex),
    "exit \(finished.exitCode), stdout: \(stdout), stderr: \(finished.stderrText)")
  return (finished.exitCode, try decode(JSON.self, stdout), stdout)
}

/// The names of a help object's actions, in order.
private func actionNames(_ help: JSON) -> [String] {
  guard case .array(let actions)? = help["actions"] else { return [] }
  return actions.compactMap { action in
    if case .string(let name)? = action["name"] { return name }
    return nil
  }
}

/// A help answer jig printed: exit 0, `ok`, the help schema, and the image pinned.
private func expectHelp(_ ran: (exitCode: Int32, json: JSON, stdout: String), image: String) {
  #expect(ran.exitCode == 0, "\(ran.stdout)")
  #expect(ran.json["ok"] == true)
  #expect(ran.json["schema"] == "urn:jig:help:1")
  guard case .string(let pinned)? = ran.json["image"] else {
    Issue.record("no image in \(ran.stdout)")
    return
  }
  let name = String(image.prefix(while: { $0 != ":" }))
  #expect(pinned.hasPrefix(name) && pinned.contains("@sha256:"), "\(pinned)")
}

private func failure(_ ran: (exitCode: Int32, json: JSON, stdout: String)) -> Failure? {
  #expect(ran.exitCode == 1, "\(ran.stdout)")
  #expect(ran.json["ok"] == false)
  #expect(ran.json["schema"] == "urn:jig:output:1")
  guard case .string(let code)? = ran.json["code"], case .string(let instructions)? = ran.json["instructions"] else {
    Issue.record("not a failure: \(ran.stdout)")
    return nil
  }
  return Failure(code: code, instructions: instructions)
}

@Suite("image help (docker)", .serialized, .enabled(if: dockerAvailable, dockerMissing), HelpImagesBuilt())
struct HelpTests {
  let temp = TempDirs()

  @Test("<fs> --help: the six actions, the image pinned", .timeLimit(.minutes(2)))
  func fsHelp() throws {
    let ran = try jig([FS, "--help"], cwd: try temp.make("jig-hcwd-"))
    expectHelp(ran, image: FS)
    #expect(actionNames(ran.json) == ["copy", "move", "remove", "remove-matching", "unwrap", "wrap"])
    #expect(ran.json["notes"] == nil)
  }

  @Test("<fs> alone is the same as --help", .timeLimit(.minutes(2)))
  func fsAlone() throws {
    let cwd = try temp.make("jig-hcwd-")
    let alone = try jig([FS], cwd: cwd)
    let asked = try jig([FS, "--help"], cwd: cwd)
    expectHelp(alone, image: FS)
    #expect(alone.json == asked.json)
  }

  @Test("<fs> move --help: only move, with --from and --to", .timeLimit(.minutes(2)))
  func fsMoveHelp() throws {
    let ran = try jig([FS, "move", "--help"], cwd: try temp.make("jig-hcwd-"))
    expectHelp(ran, image: FS)
    #expect(actionNames(ran.json) == ["move"])
    guard case .array(let flags)? = ran.json["actions"]?[0]?["flags"] else {
      Issue.record("no flags in \(ran.stdout)")
      return
    }
    #expect(flags.map { $0["name"] } == ["--from", "--to"])
  }

  @Test("<fs> nope --help is UNKNOWN_ACTION and lists the actions", .timeLimit(.minutes(2)))
  func fsUnknownAction() throws {
    let ran = try jig([FS, "nope", "--help"], cwd: try temp.make("jig-hcwd-"))
    let err = failure(ran)
    #expect(err?.code == "UNKNOWN_ACTION")
    #expect(
      err?.instructions == "Unknown action \"nope\". This image has: copy, move, remove, remove-matching, unwrap, wrap.")
  }

  @Test("--message with a help call is INVALID_ARGS; --repo is ignored", .timeLimit(.minutes(2)))
  func options() throws {
    let cwd = try temp.make("jig-hcwd-")
    let err = failure(try jig(["--message", "m", FS, "--help"], cwd: cwd))
    #expect(err?.code == "INVALID_ARGS")
    let ignored = try jig(["--repo", "/nonexistent", FS, "--help"], cwd: cwd)
    expectHelp(ignored, image: FS)
  }

  @Test("an image without help (the probe) is IMAGE_FAILED: it gives no help", .timeLimit(.minutes(2)))
  func probeGivesNoHelp() throws {
    // The probe reads its first argument as a mode: `--help` is an unknown one, a failed UNKNOWN_ACTION report.
    let err = failure(try jig([PROBE, "--help"], cwd: try temp.make("jig-hcwd-")))
    #expect(err?.code == "IMAGE_FAILED")
    #expect(err?.instructions.contains("gives no help") == true, "\(err?.instructions ?? "")")
    #expect(err?.instructions.contains("unknown: --help") == true, "\(err?.instructions ?? "")")
  }

  @Test(
    "every other image answers --help", .timeLimit(.minutes(3)),
    arguments: [(TS, 19), (PRETTIER, 1), (CODEMOD, 1)])
  func otherImages(image: String, actions: Int) throws {
    let ran = try jig([image, "--help"], cwd: try temp.make("jig-hcwd-"))
    expectHelp(ran, image: image)
    #expect(actionNames(ran.json).count == actions)
  }

  @Test("<codemod> codemod --help: each --transform choice has a description and its kind", .timeLimit(.minutes(2)))
  func codemodChoices() throws {
    let ran = try jig([CODEMOD, "codemod", "--help"], cwd: try temp.make("jig-hcwd-"))
    expectHelp(ran, image: CODEMOD)
    guard case .array(let flags)? = ran.json["actions"]?[0]?["flags"],
      let transform = flags.first(where: { $0["name"] == "--transform" }),
      case .array(let choices)? = transform["choices"]
    else {
      Issue.record("no --transform choices in \(ran.stdout)")
      return
    }
    #expect(choices.count == 14)
    #expect(choices.first { $0["name"] == "create-element-to-jsx" }?["kind"] == "sweep")
    #expect(choices.first { $0["name"] == "rename-unsafe-lifecycles" }?["kind"] == "rewrite")
    for choice in choices {
      guard case .string(let description)? = choice["description"] else {
        Issue.record("a choice without description: \(choice)")
        continue
      }
      #expect(!description.isEmpty)
    }
    #expect(ran.json["actions"]?[0]?["kinds"] == .array(["sweep", "rewrite"]))
  }

  @Test("jig --help prints the usage", .timeLimit(.minutes(1)))
  func usage() throws {
    let finished = try runCommand([try setup(), "--help"], cwd: try temp.make("jig-hcwd-"))
    #expect(finished.exitCode == 0)
    #expect(finished.stdoutText.contains("usage: jig"))
    #expect(finished.stdoutText.contains("<image> <action> --help"))
  }

  @Test("help leaves no temporary folder behind", .timeLimit(.minutes(2)))
  func noLeftovers() throws {
    // A TMPDIR of its own, so other suites running meanwhile do not show up in it.
    let tmp = try temp.make("jig-htmp-")
    var environment = ProcessInfo.processInfo.environment
    environment["TMPDIR"] = tmp.path
    let finished = try runCommand([try setup(), FS, "--help"], cwd: try temp.make("jig-hcwd-"), environment: environment)
    #expect(finished.exitCode == 0, "\(finished.stdoutText)\n\(finished.stderrText)")
    #expect(try fm.contentsOfDirectory(atPath: tmp.path) == [])
  }
}

@Suite("image help (rootlesskit)", .serialized, .enabled(if: rootlesskitAvailable, rootlesskitMissing), HelpImagesBuilt())
struct RootlesskitHelpTests {
  let temp = TempDirs()

  @Test("--sandbox rootlesskit gives the same actions as docker", .timeLimit(.minutes(3)))
  func sameAsDocker() throws {
    let cwd = try temp.make("jig-hcwd-")
    let docker = try jig([FS, "--help"], cwd: cwd)
    let rootlesskit = try jig(["--sandbox", "rootlesskit", FS, "--help"], cwd: cwd)
    expectHelp(rootlesskit, image: FS)
    #expect(rootlesskit.json["actions"] == docker.json["actions"])
  }
}
