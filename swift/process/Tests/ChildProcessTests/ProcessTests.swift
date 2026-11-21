import Foundation
import Testing

@testable import ChildProcess
import Report

#if canImport(Glibc)
  import Glibc
#endif

// MARK: - Termination and processes

@Test func waitStatusesDecode() {
  #expect(Termination(waitStatus: 0) == .exited(0))
  #expect(Termination(waitStatus: 3 << 8) == .exited(3))
  #expect(Termination(waitStatus: 9) == .signaled(9))
  #expect(Termination(waitStatus: 15 | 0x80) == .signaled(15))  // with a core dump flag
  #expect(Termination.exited(3).description == "exit code 3")
  #expect(Termination.signaled(9).description == "killed by signal 9")
}

@Test func aProcessKilledByASignalIsReportedAsSuch() throws {
  let run = try runProcess("sh", ["-c", "kill -9 $$"])
  #expect(run.termination == .signaled(9))
  let failed = CommandFailed(command: ["git", "status"], termination: run.termination, stderr: "")
  #expect(failed.description == "git status failed (killed by signal 9): ")
  let error = RefactorError.from(failed)
  #expect(error.code == .INTERNAL)
  #expect(error.instructions.hasPrefix("git status failed (killed by signal 9): . Check that git works"))
}

@Test func eachToolGetsItsOwnNextStep() {
  func next(_ command: [String]) -> String {
    RefactorError.from(CommandFailed(command: command, termination: .exited(2), stderr: "x")).instructions
  }
  #expect(next(["docker", "ps"]).contains("Check that docker works"))
  #expect(next(["/usr/bin/tar", "-x"]).contains("Check that tar works"))
  #expect(!next(["/usr/bin/tar", "-x"]).contains("git"))
  #expect(next(["rootlesskit"]).contains("Check that rootlesskit works"))
  #expect(!next(["rootlesskit"]).contains("git"))
  #expect(next(["/usr/bin/git", "status"]).contains("Check that git works in this repository"))

  let git = RefactorError.from(ExecutableNotFound(name: "git")).instructions
  #expect(git == "git was not found on PATH. jig needs git on PATH: install git or fix PATH, then run again.")
  let tar = RefactorError.from(ExecutableNotFound(name: "tar")).instructions
  #expect(!tar.contains("docker") && !tar.contains("git"), "\(tar)")
}

@Test func aProcessExitCodeIsNotASignal() throws {
  let run = try runProcess("sh", ["-c", "echo out; echo err >&2; exit 9"], stdin: Data("in".utf8))
  #expect(run.termination == .exited(9))
  #expect(run.stdoutText == "out\n")
  #expect(run.stderrText == "err\n")
  #expect(try runProcess("cat", [], stdin: Data("piped".utf8)).stdoutText == "piped")
}

@Test func onStartGivesThePIDAndSignalGroupStopsOnlyALiveGroup() throws {
  final class Box: @unchecked Sendable { var pid: pid_t = 0 }
  let box = Box()
  let started = DispatchSemaphore(value: 0)
  DispatchQueue.global().async {
    while box.pid == 0 { usleep(10_000) }
    usleep(100_000)
    #expect(Lifecycle.shared.signalGroup(box.pid, SIGKILL))
    started.signal()
  }
  let run = try runProcess("sh", ["-c", "sleep 30 & wait"], onStart: { box.pid = $0 })
  started.wait()
  #expect(run.termination == .signaled(SIGKILL))
  // Reaped: never signalled again (the PID may belong to another process by now).
  #expect(!Lifecycle.shared.signalGroup(box.pid, SIGKILL))
}

@Test func childrenStartInTheirOwnProcessGroup() throws {
  let run = try runProcess("sh", ["-c", "echo $$; ps -o pgid= -p $$"])
  let lines = run.stdoutText.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
  #expect(lines.count == 2 && lines[0] == lines[1], "\(lines)")
}
