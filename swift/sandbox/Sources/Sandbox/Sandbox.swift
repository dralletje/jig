import Foundation
import Report

/// An image resolved to what is run and recorded. Docker and rootlesskit pin the same digests, so a
/// commit made with one replays with the other.
public struct PinnedImage: Equatable, Sendable {
  /// What runs, and what the sandbox caches by, `sha256:<64 lowercase hex>`: the local image ID for a
  /// local image, the manifest chosen for this machine's platform for a registry image.
  public var id: String
  /// What is recorded, `<name>@sha256:<64 lowercase hex>`: the `image` of the `Refactor-Command` trailer
  /// and of the output. For a registry image the digest is the one its tag points to (an index digest for
  /// a multi-platform image), so it can differ from `id`.
  public var reference: String
  /// Something the agent should know about how the image was resolved (a cached image used because its
  /// registry could not be reached, and why); nil when there is nothing to say. It goes to the output's
  /// `notes`.
  public var note: String?

  public init(id: String, reference: String, note: String? = nil) {
    self.id = id
    self.reference = reference
    self.note = note
  }

  /// `<name>@sha256:<64 lowercase hex>` split into name and ID, or nil when `reference` is not pinned.
  public static func split(_ reference: String) -> (name: String, id: String)? {
    guard let at = reference.lastIndex(of: "@") else { return nil }
    let name = reference[..<at]
    let id = reference[reference.index(after: at)...]
    let prefix = "sha256:"
    guard !name.isEmpty, id.hasPrefix(prefix) else { return nil }
    let hex = id.dropFirst(prefix.count)
    guard hex.count == 64, hex.unicodeScalars.allSatisfy({ ("0"..."9").contains($0) || ("a"..."f").contains($0) })
    else { return nil }
    return (String(name), String(id))
  }
}

/// How the image's process ended and everything it wrote.
public struct SandboxRun: Sendable {
  /// The action's own exit code, or the signal that killed it (not a wrapper's status: `docker run`'s
  /// 128 + N is `.signaled(N)` here).
  public var termination: Termination
  public var stdout: Data
  public var stderr: Data

  public init(termination: Termination, stdout: Data, stderr: Data) {
    self.termination = termination
    self.stdout = stdout
    self.stderr = stderr
  }
}

/// Where an image runs. One run at a time per instance.
///
/// The CLI resolves the image first, runs it once on the exported workspace, and on SIGINT, SIGTERM or
/// SIGHUP calls `cleanup()` from its signal queue (after it has SIGKILLed and waited for every process
/// group started through `ChildProcess.runProcess`), then removes the workspace.
public protocol Sandbox: AnyObject, Sendable {
  /// Resolves an image reference to its pinned identity. A reference already pinned
  /// (`<name>@sha256:<id>`, a replay) resolves to itself as long as what it pins exists here (a local
  /// image ID), whatever its name points at now;
  /// anything else is pinned to the ID it names now.
  /// Throws `RefactorError` `IMAGE_NOT_FOUND`, with instructions, when there is no such image.
  func resolve(_ reference: String) throws -> PinnedImage

  /// Runs `image` with `arguments` as its argv (after the image's entrypoint; never through a shell) and
  /// waits for it. `workspace` is read-write at `/workspace`, and there is no network. The image
  /// sandboxes (docker, rootlesskit) also make `/workspace` the working directory, the image's filesystem
  /// read-only and `/tmp` a writable scratch folder.
  /// Returns how the action ended and its raw stdout and stderr; a failing action is a result, not an
  /// error. Throws only when the sandbox itself fails (it could not start, say).
  func run(_ image: PinnedImage, arguments: [String], workspace: URL) throws -> SandboxRun

  /// Kills and removes everything the current run started (processes, container, mounts, temporary
  /// folders); when it returns, nothing of the run is left. Idempotent, and safe to call from another
  /// thread at any time, also while `run` is in progress or returning, and when no run started. It may
  /// only start processes with `runProcess(..., gated: false)`; a gated one would never start while
  /// the binary is being interrupted. Failures are one line on stderr, never thrown.
  func cleanup()

  /// What the last `cleanup()` could not remove, each as a phrase that names it and says how to remove
  /// it by hand ("the container X (remove it: docker rm -f X)"); empty when nothing is left. The
  /// interruption's instructions name these instead of claiming a clean state.
  var leftovers: [String] { get }
}

extension Sandbox {
  /// A sandbox that does not track what its cleanup left claims nothing is left.
  public var leftovers: [String] { [] }
}
