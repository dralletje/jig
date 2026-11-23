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

  @Test("<fs> --help: the help, the image pinned", .timeLimit(.minutes(2)))
  func fsHelp() throws {
    let ran = try jig([FS, "--help"], cwd: try temp.make("jig-hcwd-"))
    expectHelp(ran, image: FS)
    #expect(ran.json["notes"] == nil)
  }

  @Test("<fs> --help lists the flags each action accepts", .timeLimit(.minutes(10)))
  func fsHelpMatchesActions() throws {
    // A run of every action that works on the fs fixture: its flags are the ones the help must list.
    let working: [String: [String]] = [
      "copy": ["--from", "src/old", "--to", "src/new"],
      "move": ["--from", "src/old", "--to", "src/new"],
      "remove": ["--paths", "src/old"],
      "remove-matching": ["--files", "src/old/*.txt"],
      "unwrap": ["--folder", "src/old"],
      "wrap": ["--paths", "src/old", "--into", "src/box"],
    ]
    let ran = try jig([FS, "--help"], cwd: try temp.make("jig-hcwd-"))
    expectHelp(ran, image: FS)
    guard case .array(let actions)? = ran.json["actions"] else {
      Issue.record("no actions in \(ran.stdout)")
      return
    }
    #expect(Set(actionNames(ran.json)) == Set(working.keys))
    for action in actions {
      guard case .string(let name)? = action["name"], let args = working[name],
        case .array(let flags)? = action["flags"]
      else { continue }
      let listed: [String] = flags.compactMap { flag in
        if case .string(let flagName)? = flag["name"] { return flagName }
        return nil
      }
      let given = stride(from: 0, to: args.count, by: 2).map { args[$0] }
      #expect(Set(listed) == Set(given), "\(name)")
      _ = try runImage(repo: try temp.fixture("fs"), image: FS, args: [name] + args)
      let dir = try temp.fixture("fs")
      #expect(try failImage(repo: dir, image: FS, args: [name] + args + ["--not-a-flag", "x"]).code == "INVALID_ARGS", "\(name)")
      for flag in flags {
        guard case .string(let flagName)? = flag["name"], let at = args.firstIndex(of: flagName) else { continue }
        let without = Array(args[..<at]) + Array(args[(at + 2)...])
        let refused = (try? failImage(repo: dir, image: FS, args: [name] + without))?.code == "INVALID_ARGS"
        #expect(refused == (flag["required"] == true), "\(name) without \(flagName)")
      }
    }
  }

  @Test("<fs> alone is the same as --help", .timeLimit(.minutes(2)))
  func fsAlone() throws {
    let cwd = try temp.make("jig-hcwd-")
    let alone = try jig([FS], cwd: cwd)
    let asked = try jig([FS, "--help"], cwd: cwd)
    expectHelp(alone, image: FS)
    #expect(alone.json == asked.json)
  }

  @Test("<fs> move --help: only move", .timeLimit(.minutes(2)))
  func fsMoveHelp() throws {
    let ran = try jig([FS, "move", "--help"], cwd: try temp.make("jig-hcwd-"))
    expectHelp(ran, image: FS)
    #expect(actionNames(ran.json) == ["move"])
  }

  @Test("<fs> nope --help is UNKNOWN_ACTION", .timeLimit(.minutes(2)))
  func fsUnknownAction() throws {
    let ran = try jig([FS, "nope", "--help"], cwd: try temp.make("jig-hcwd-"))
    let err = failure(ran)
    #expect(err?.code == "UNKNOWN_ACTION")
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
    arguments: [TS, PRETTIER, CODEMOD])
  func otherImages(image: String) throws {
    let ran = try jig([image, "--help"], cwd: try temp.make("jig-hcwd-"))
    expectHelp(ran, image: image)
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
