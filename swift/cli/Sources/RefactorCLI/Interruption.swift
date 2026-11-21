import ChildProcess
import Foundation
import Report
import Sandbox
import SandboxDocker
import SandboxRootlesskit

/// The sandbox `--sandbox` names. A sandbox this machine cannot run is `INTERNAL`, with what to install
/// or do instead.
public func makeSandbox(_ kind: SandboxKind, rootlesskit: String = "/usr/bin/rootlesskit") throws -> any Sandbox {
  switch kind {
  case .docker:
    return DockerSandbox()
  case .rootlesskit:
    if let reason = RootlesskitSandbox.unavailableReason(rootlesskit: rootlesskit) {
      throw RefactorError(
        code: .INTERNAL,
        instructions: "--sandbox rootlesskit cannot run on this machine: \(reason). Then run again; or run with "
          + "--sandbox docker (the default), which needs a running Docker daemon instead.")
    }
    var options = RootlesskitSandbox.Options()
    options.rootlesskit = rootlesskit
    return RootlesskitSandbox(options: options)
  }
}

private let chosenLock = NSLock()
nonisolated(unsafe) private var chosen = SandboxKind.docker

/// The sandbox of this run, for the interruption's line (call once the arguments are parsed).
public func setInterruptedSandbox(_ kind: SandboxKind) {
  chosenLock.lock()
  chosen = kind
  chosenLock.unlock()
}

private func interruptedSandbox() -> SandboxKind {
  chosenLock.lock()
  defer { chosenLock.unlock() }
  return chosen
}

/// The instructions printed when a run is interrupted, with or without the commit having landed.
/// `leftovers` is what the cleanup could not remove (each saying how to remove it by hand); the
/// instructions claim a clean state only when it is empty. `sandbox` names what was running (the
/// container, the sandbox).
func interruptedInstructions(
  signal sig: Int32, landed commit: String?, leftovers: [String] = [], sandbox: SandboxKind = .docker
) -> String {
  let thing = sandbox.runningThing
  let cleaned =
    leftovers.isEmpty
    ? "The \(thing) and temporary files were removed."
    : "The cleanup could not remove everything; left: \(leftovers.joined(separator: "; ")). Remove "
      + (leftovers.count == 1 ? "it" : "them") + " yourself."
  if let commit {
    return "interrupted by \(signalName(sig)) after the commit \(commit) was applied: the repository now has it "
      + "checked out (it was in the middle of the final fast-forward, which was let finish). \(cleaned) Review "
      + "the commit (git show \(commit)) and keep it or reset it."
  }
  let state =
    leftovers.isEmpty
    ? "the \(thing) and temporary files were removed."
    : "the cleanup could not remove everything; left: \(leftovers.joined(separator: "; ")). Remove "
      + (leftovers.count == 1 ? "it" : "them") + " yourself, then"
  return "interrupted by \(signalName(sig)) before the repository was changed; \(state) "
    + (leftovers.isEmpty ? "Run" : "run") + " it again; if a timeout stopped a slow image, give it more time, or "
    + "report the image as hanging."
}

/// The one JSON line printed when a run is interrupted (see `installInterruptHandlers`).
@Sendable public func interruptedJSON(signal sig: Int32, landed commit: String?, leftovers: [String]) -> String {
  errorJSON(
    RefactorError(
      code: .INTERNAL,
      instructions: interruptedInstructions(
        signal: sig, landed: commit, leftovers: leftovers, sandbox: interruptedSandbox())))
}
