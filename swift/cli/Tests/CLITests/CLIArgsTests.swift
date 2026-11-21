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
    try parseCommand(["--repo", "r", "img", "--x"])
      == .run(CLIArgs(repo: "r", message: nil, sandbox: .docker, image: "img", args: ["--x"])))
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
