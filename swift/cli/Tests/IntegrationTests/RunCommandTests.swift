// The process runner the end-to-end tests rely on (no docker needed).
import Foundation
import Testing

@Suite("runCommand", .timeLimit(.minutes(1)))
struct RunCommandTests {
  let temp = TempDirs()

  @Test("returns the exit code and both outputs")
  func finishes() throws {
    let run = try runCommand(["sh", "-c", "echo out; echo err >&2; exit 3"])
    #expect(run.exitCode == 3)
    #expect(run.stdoutText == "out\n")
    #expect(run.stderrText == "err\n")
  }

  @Test("gives up within its limit on a command whose grandchild keeps the pipes open, and kills the group")
  func timeoutKillsProcessGroup() throws {
    let pidFile = try temp.make("run-command-").appendingPathComponent("pid")
    let start = Date()
    #expect(throws: TestFailure.self) {
      try runCommand(["sh", "-c", #"sleep 600 & echo $! > "$1"; sleep 600"#, "sh", pidFile.path], timeout: 2)
    }
    #expect(Date().timeIntervalSince(start) < 2 + killGrace + 3)

    // The background `sleep` (a grandchild of the runner) is gone, or a zombie waiting to be reaped.
    // SIGKILL is not instant: under load the process can still show as running (R) for a moment.
    let pid = try readText(pidFile).trimmingCharacters(in: .whitespacesAndNewlines)
    var stat: String?
    let ended = poll(seconds: 3) {
      stat = try? readText(URL(fileURLWithPath: "/proc/\(pid)/stat"))
      let state = stat.flatMap { $0.split(separator: ")").last?.split(separator: " ").first }
      return stat == nil || state == "Z"
    }
    #expect(ended, "the grandchild \(pid) still runs: \(stat ?? "")")
  }
}
