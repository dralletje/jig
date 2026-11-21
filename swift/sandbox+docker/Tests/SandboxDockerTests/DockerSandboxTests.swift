import Testing

@testable import SandboxDocker

@Test func dockerRunStatusesAbove128AreSignals() {
  #expect(containerTermination(.exited(137)) == .signaled(9))
  #expect(containerTermination(.exited(143)) == .signaled(15))
  #expect(containerTermination(.exited(125)) == .exited(125))
  #expect(containerTermination(.exited(1)) == .exited(1))
  #expect(containerTermination(.exited(0)) == .exited(0))
  #expect(containerTermination(.signaled(9)) == .signaled(9))
}


@Test func dockerOwnFailuresAreToldApartFromTheImage() {
  let daemon = "docker: Error response from daemon: fake failure.\n"
  let e125 = dockerRunFailure(.exited(125), stderr: daemon)
  #expect(e125?.code == .INTERNAL)
  #expect(e125?.instructions.hasPrefix("docker run failed (exit code 125): docker: Error response from daemon: fake failure.") == true)
  #expect(e125?.instructions.contains("not with the image") == true)
  let notFound = "docker: Error response from daemon: failed to create task for container: exec: \"node\": executable file not found in $PATH\n"
  #expect(dockerRunFailure(.exited(127), stderr: notFound)?.code == .INTERNAL)
  #expect(dockerRunFailure(.exited(126), stderr: "docker: Error response from daemon: permission denied\n")?.code == .INTERNAL)
  // The image's own exit codes, also 125–127 when docker did not complain, are the image's.
  #expect(dockerRunFailure(.exited(127), stderr: "sh: x: not found\n") == nil)
  #expect(dockerRunFailure(.exited(1), stderr: daemon) == nil)
  #expect(dockerRunFailure(.exited(0), stderr: "") == nil)
}
