import Testing

@testable import RefactorCLI
import ChildProcess

#if canImport(Glibc)
  import Glibc
#endif

@Test func interruptedInstructionsSayWhatHappened() {
  #expect(
    interruptedInstructions(signal: SIGINT, landed: nil).hasPrefix(
      "interrupted by SIGINT before the repository was changed; the container and temporary files were removed."))
  let landed = interruptedInstructions(signal: SIGTERM, landed: "abc123")
  #expect(landed.hasPrefix("interrupted by SIGTERM after the commit abc123 was applied"))
  #expect(landed.contains("git show abc123"))
  #expect(signalName(SIGHUP) == "SIGHUP")
  #expect(
    interruptedInstructions(signal: SIGTERM, landed: nil, sandbox: .rootlesskit).hasPrefix(
      "interrupted by SIGTERM before the repository was changed; the sandbox and temporary files were removed."))
}


@Test func interruptedInstructionsNameWhatTheCleanupLeft() {
  let left = [
    "the container jig-abc (remove it: docker rm -f jig-abc)",
    "the temporary folder /tmp/jig-x (remove it: rm -rf /tmp/jig-x)",
  ]
  let text = interruptedInstructions(signal: SIGTERM, landed: nil, leftovers: left)
  #expect(text.hasPrefix("interrupted by SIGTERM before the repository was changed; the cleanup could not remove"))
  #expect(!text.contains("were removed"))
  #expect(text.contains("docker rm -f jig-abc"))
  #expect(text.contains("rm -rf /tmp/jig-x"))
  let landed = interruptedInstructions(signal: SIGINT, landed: "abc123", leftovers: left)
  #expect(landed.hasPrefix("interrupted by SIGINT after the commit abc123 was applied"))
  #expect(!landed.contains("were removed"))
  #expect(landed.contains("docker rm -f jig-abc"))
}
