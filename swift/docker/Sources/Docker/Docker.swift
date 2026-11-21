import ChildProcess
import Foundation
import Report

#if canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#endif

/// `text` on one line: its lines trimmed and joined with spaces.
public func oneLine(_ text: String) -> String {
  text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    .joined(separator: " ")
}

/// Docker's own next step, for a failure of Docker rather than of the image.
public let dockerNextStep =
  "This is a problem with Docker, not with the image: check that the Docker daemon runs and that you can reach "
  + "it (docker info; also DOCKER_HOST and docker context), fix what it reports, then run again."

/// The error for a failed `docker image inspect`: `IMAGE_NOT_FOUND` when the daemon answered (there is no
/// such image), `INTERNAL` with Docker instructions when the daemon could not be reached.
public func inspectFailure(reference: String, stderr: String, daemonReachable: Bool) -> RefactorError {
  guard daemonReachable else {
    return RefactorError(
      code: .INTERNAL,
      instructions: "docker could not reach the Docker daemon to look up the image \(reference) (docker: "
        + "\(oneLine(stderr))). \(dockerNextStep)")
  }
  return RefactorError(
    code: .IMAGE_NOT_FOUND,
    instructions: "There is no local image \(reference) (docker: \(oneLine(stderr))). Build or pull it, then run again.")
}

/// How long a container removal keeps looking for the container after its first `docker rm -f`: the
/// daemon may still be creating it from a request a killed client sent just before.
public let lateCreationWindow = 3.0

/// The docker commands the sandboxes run for themselves, through a runner of the sandbox's choosing (so
/// each tracks its own processes).
public struct DockerCLI: Sendable {
  /// Runs docker with the arguments; `gated: false` for a cleanup's own command (see `runProcess`).
  public typealias Runner = @Sendable (_ arguments: [String], _ gated: Bool) throws -> ProcessOutput

  public var run: Runner
  /// Where a failure the caller does not throw goes: one line on stderr by default.
  public var report: @Sendable (String) -> Void

  public init(run: @escaping Runner, report: @escaping @Sendable (String) -> Void = DockerCLI.writeToStderr) {
    self.run = run
    self.report = report
  }

  /// `executable` (default `docker` on PATH) through `runProcess`, with our environment.
  public init(executable: String = "docker") {
    self.init(run: { arguments, gated in try runProcess(executable, arguments, gated: gated) })
  }

  public static let writeToStderr: @Sendable (String) -> Void = { line in
    FileHandle.standardError.write(Data("jig: \(line)\n".utf8))
  }

  /// Whether the Docker daemon answers (`docker version` needs the server).
  public func daemonReachable() -> Bool {
    (try? run(["version", "--format", "{{.Server.Version}}"], true))?.succeeded ?? false
  }

  /// `inspectFailure` for a failed `docker image inspect`: "No such image" is the daemon's answer;
  /// anything else may be docker itself failing, so the daemon is asked.
  public func inspectFailure(reference: String, stderr: String) -> RefactorError {
    let reachable = stderr.contains("No such image") || daemonReachable()
    return Docker.inspectFailure(reference: reference, stderr: stderr, daemonReachable: reachable)
  }

  /// Whether the daemon lists a container named `name` (in any state); nil when docker could not say.
  public func containerListed(_ name: String) -> Bool? {
    guard let run = try? run(["ps", "-aq", "--filter", "name=^/\(name)$"], false), run.succeeded else { return nil }
    return !run.stdoutText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  /// `docker rm -f <name>`, also when the run is being interrupted, then a look every 0.25 s for `window`
  /// seconds, removing a container the daemon created late (from a killed client's request) whenever it
  /// shows up. Returns whether the container is gone as far as the daemon knows (false when it is still
  /// listed, or docker could not tell). A failed removal is reported (one line on stderr).
  public func removeContainer(_ name: String, window: Double = lateCreationWindow) -> Bool {
    func remove() {
      do {
        let ran = try run(["rm", "-f", name], false)
        if !ran.succeeded, !ran.stderrText.contains("No such container") {
          report("could not remove the container \(name): \(oneLine(ran.stderrText))")
        }
      } catch {
        report("could not remove the container \(name): \(error)")
      }
    }
    remove()
    var gone = containerListed(name) == false
    let deadline = Date().addingTimeInterval(window)
    while Date() < deadline {
      usleep(250_000)
      switch containerListed(name) {
      case true?:
        remove()
        gone = containerListed(name) == false
      case false?: gone = true
      case nil: gone = false
      }
    }
    return gone
  }
}
