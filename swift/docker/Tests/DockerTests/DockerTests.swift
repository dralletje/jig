import ChildProcess
import Foundation
import Report
import Testing

@testable import Docker

/// A fake docker: answers `ps` from a list the test changes, and `rm` as the test says.
final class FakeDocker: @unchecked Sendable {
  private let lock = NSLock()
  private var listed: Set<String> = []
  private var calls: [[String]] = []
  private var reported: [String] = []
  var rmFails = false
  /// After this many `ps` calls, the daemon "creates" this container (late, from a killed client).
  var lateCreation: (afterListings: Int, name: String)?

  func list(_ name: String) {
    lock.lock()
    listed.insert(name)
    lock.unlock()
  }

  var commands: [[String]] {
    lock.lock()
    defer { lock.unlock() }
    return calls
  }

  var lines: [String] {
    lock.lock()
    defer { lock.unlock() }
    return reported
  }

  var cli: DockerCLI {
    DockerCLI(
      run: { [self] arguments, _ in
        lock.lock()
        defer { lock.unlock() }
        calls.append(arguments)
        switch arguments.first {
        case "rm":
          if rmFails {
            return ProcessOutput(termination: .exited(1), stdout: Data(), stderr: Data("Error response from daemon: boom\n".utf8))
          }
          listed.remove(arguments.last!)
          return ProcessOutput(termination: .exited(0), stdout: Data(), stderr: Data())
        case "ps":
          let listings = calls.filter { $0.first == "ps" }.count
          if let late = lateCreation, listings > late.afterListings {
            listed.insert(late.name)
            lateCreation = nil
          }
          let filter = arguments.last!  // name=^/<name>$
          let name = String(filter.dropFirst("name=^/".count).dropLast())
          return ProcessOutput(termination: .exited(0), stdout: Data((listed.contains(name) ? "abc\n" : "").utf8), stderr: Data())
        default:
          return ProcessOutput(termination: .exited(1), stdout: Data(), stderr: Data())
        }
      },
      report: { [self] line in
        lock.lock()
        reported.append(line)
        lock.unlock()
      })
  }
}

@Test func aContainerTheDaemonCreatesLateIsRemovedWithinTheWindow() {
  let fake = FakeDocker()
  fake.lateCreation = (afterListings: 2, name: "c1")
  #expect(fake.cli.removeContainer("c1", window: 1.5))
  #expect(fake.commands.filter { $0.first == "rm" }.count == 2)
  #expect(fake.lines.isEmpty)
}

@Test func aContainerThatCannotBeRemovedIsReportedAndNotGone() {
  let fake = FakeDocker()
  fake.list("c2")
  fake.rmFails = true
  #expect(!fake.cli.removeContainer("c2", window: 0.5))
  #expect(fake.lines.first == "could not remove the container c2: Error response from daemon: boom")
}

@Test func withoutAWindowOneRemovalAndOneLook() {
  let fake = FakeDocker()
  fake.list("c3")
  #expect(fake.cli.removeContainer("c3", window: 0))
  #expect(fake.commands == [["rm", "-f", "c3"], ["ps", "-aq", "--filter", "name=^/c3$"]])
}

@Test func anUnreachableDaemonIsNotAMissingImage() {
  let unreachable = inspectFailure(
    reference: "x:local", stderr: "Cannot connect to the Docker daemon at unix:///nope.sock. Is the docker daemon running?",
    daemonReachable: false)
  #expect(unreachable.code == .INTERNAL)
  #expect(unreachable.instructions.contains("Docker daemon"))
  #expect(!unreachable.instructions.contains("Build or pull"))
  let missing = inspectFailure(reference: "x:local", stderr: "Error: No such image: x:local", daemonReachable: true)
  #expect(missing.code == .IMAGE_NOT_FOUND)
  #expect(missing.instructions.contains("Build or pull it"))
  // The CLI's own check: "No such image" needs no question to the daemon; anything else asks it.
  let fake = FakeDocker()
  #expect(fake.cli.inspectFailure(reference: "y", stderr: "Error: No such image: y").code == .IMAGE_NOT_FOUND)
  #expect(fake.commands.isEmpty)
  #expect(fake.cli.inspectFailure(reference: "y", stderr: "error during connect").code == .INTERNAL)
  #expect(fake.commands.first?.first == "version")
}
