import Testing

@testable import RefactorCLI
import Report

#if canImport(Glibc)
  import Glibc
#endif

@Test func cliOptionsBeforeImageAreOurs() throws {
  let parsed = try CLIArgs.parse(["--repo", "r", "--message", "m", "img", "a", "--repo", "x", "--sandbox", "y"])
  #expect(parsed.repo == "r")
  #expect(parsed.message == "m")
  #expect(parsed.sandbox == .docker)
  #expect(parsed.image == "img")
  #expect(parsed.args == ["a", "--repo", "x", "--sandbox", "y"])
  #expect(try CLIArgs.parse(["--sandbox", "docker", "img"]).sandbox == .docker)
  #expect(try CLIArgs.parse(["--sandbox", "rootlesskit", "--repo", "r", "img"]).sandbox == .rootlesskit)
}

@Test func cliImageAlone() throws {
  let parsed = try CLIArgs.parse(["img"])
  #expect(parsed.repo == nil)
  #expect(parsed.message == nil)
  #expect(parsed.sandbox == .docker)
  #expect(parsed.image == "img")
  #expect(parsed.args == [])
}

@Test(arguments: [
  [], ["--repo"], ["--message"], ["--repo", "r"], ["--bogus", "x", "img"], ["--sandbox"], ["--sandbox", "img"],
  ["--sandbox", "podman", "img"],
])
func cliInvalid(argv: [String]) {
  #expect {
    try CLIArgs.parse(argv)
  } throws: { error in
    (error as? RefactorError)?.code == .INVALID_ARGS
  }
}

@Test func verifyParsesOptionsInAnyOrder() throws {
  #expect(
    try parseCommand(["verify", "--sandbox", "rootlesskit", "HEAD~1"])
      == .verify(VerifyArgs(repo: nil, sandbox: .rootlesskit, target: "HEAD~1")))
  #expect(
    try parseCommand(["verify", "a..b", "--repo", "r"])
      == .verify(VerifyArgs(repo: "r", sandbox: .docker, target: "a..b")))
}

@Test(arguments: [["verify"], ["verify", "a", "b"], ["verify", "--repo", "r"]])
func verifyNeedsExactlyOneTarget(argv: [String]) {
  #expect {
    try parseCommand(argv)
  } throws: { error in
    (error as? RefactorError)?.code == .INVALID_ARGS
  }
}

@Test func verifyRejectsMessage() {
  #expect {
    try parseCommand(["verify", "--message", "m", "HEAD"])
  } throws: { error in
    (error as? RefactorError)?.code == .INVALID_ARGS
  }
}

@Test(arguments: [
  ["verify", "HEAD", "--sandbox"], ["verify", "--sandbox", "podman", "HEAD"], ["verify", "--bogus", "x", "HEAD"],
])
func verifyInvalidOptions(argv: [String]) {
  #expect {
    try parseCommand(argv)
  } throws: { error in
    (error as? RefactorError)?.code == .INVALID_ARGS
  }
}

@Test(arguments: [["verify", "--on", "HEAD~1", "HEAD"], ["verify", "--on", "x", "a..b"], ["verify", "HEAD", "--on"]])
func verifyHasNoOn(argv: [String]) {
  #expect {
    try parseCommand(argv)
  } throws: { error in
    guard let error = error as? RefactorError else { return false }
    return error.code == .INVALID_ARGS && error.instructions.hasPrefix("Unknown option --on for verify. ")
  }
}

@Test func runStillParses() throws {
  #expect(
    try parseCommand(["--repo", "r", "img", "x", "--y"])
      == .run(CLIArgs(repo: "r", message: nil, sandbox: .docker, image: "img", args: ["x", "--y"])))
}

@Test(arguments: [
  ["img", "", "--x"], ["img", "a b"], ["img", "a\tb", "--to", "x"], ["--repo", "r", "img", " "], ["img", "--x"],
  ["img", "--files", "x"], ["img", "-x", "y"], ["img", "--repo", "r", "move"],
])
func aRunWhoseFirstArgumentIsNotAnActionIsRefused(argv: [String]) {
  #expect {
    try parseCommand(argv)
  } throws: { error in
    guard let error = error as? RefactorError else { return false }
    return error.code == .INVALID_ARGS
      && error.instructions.hasPrefix("The first argument after the image must be an action name, not starting with - and without whitespace: ")
  }
}

@Test func aDashFirstActionHintsAtTheLikelyMistakes() {
  #expect {
    try parseCommand(["img", "--files", "x"])
  } throws: { error in
    guard let error = error as? RefactorError else { return false }
    return error.code == .INVALID_ARGS
      && error.instructions.contains(#"the action "--files" starts with -"#)
      && error.instructions.contains("the action is missing")
      && error.instructions.contains("(--repo, --message, --sandbox) was put after the image instead of before it")
  }
}

@Test func helpCalls() throws {
  #expect(try parseCommand(["img"]) == .help(HelpArgs(sandbox: .docker, image: "img", action: nil)))
  #expect(try parseCommand(["img", "--help"]) == .help(HelpArgs(sandbox: .docker, image: "img", action: nil)))
  #expect(try parseCommand(["img", "move", "--help"]) == .help(HelpArgs(sandbox: .docker, image: "img", action: "move")))
  #expect(try parseCommand(["--repo", "x", "img", "--help"]) == .help(HelpArgs(sandbox: .docker, image: "img", action: nil)))
  #expect(
    try parseCommand(["--sandbox", "rootlesskit", "img"]) == .help(HelpArgs(sandbox: .rootlesskit, image: "img", action: nil)))
}

@Test func notHelpCalls() throws {
  #expect(
    try parseCommand(["img", "move", "--to", "--help"])
      == .run(CLIArgs(repo: nil, message: nil, sandbox: .docker, image: "img", args: ["move", "--to", "--help"])))
  #expect(
    try parseCommand(["img", "move", "--help", "x"])
      == .run(CLIArgs(repo: nil, message: nil, sandbox: .docker, image: "img", args: ["move", "--help", "x"])))
  #expect(
    try parseCommand(["img", "move"])
      == .run(CLIArgs(repo: nil, message: nil, sandbox: .docker, image: "img", args: ["move"])))
}

@Test func helpRejectsMessage() {
  #expect {
    try parseCommand(["--message", "m", "img", "--help"])
  } throws: { error in
    guard let error = error as? RefactorError else { return false }
    return error.code == .INVALID_ARGS && error.instructions.contains("--message")
  }
}

@Test func jigHelpIsUsage() throws {
  #expect(try parseCommand(["--help"]) == .usage)
  #expect {
    try parseCommand([])
  } throws: { error in
    (error as? RefactorError)?.code == .INVALID_ARGS
  }
}

@Test func usageNamesImageHelp() {
  #expect(usage.contains("jig [--sandbox docker|rootlesskit] <image> [--help]"))
  #expect(usage.contains("jig [--sandbox docker|rootlesskit] <image> <action> --help"))
}

@Test func usageNamesVerify() {
  #expect(
    usage.contains(
      "jig verify [--repo <path>] [--sandbox docker|rootlesskit] <commit-or-range>"))
  #expect(!usage.contains("--on"))
}

@Test func everySandboxIsBuiltIn() throws {
  _ = try makeSandbox(.docker)
  if access("/usr/bin/rootlesskit", X_OK) == 0 { _ = try makeSandbox(.rootlesskit) }
}

@Test func aMissingRootlesskitSaysWhatToInstall() throws {
  #expect {
    try makeSandbox(.rootlesskit, rootlesskit: "/nonexistent/rootlesskit")
  } throws: { error in
    guard let error = error as? RefactorError else { return false }
    return error.code == .INTERNAL && error.instructions.contains("apt install rootlesskit")
      && error.instructions.contains("--sandbox docker")
  }
}
