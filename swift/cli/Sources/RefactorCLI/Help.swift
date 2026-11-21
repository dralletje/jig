import ChildProcess
import Foundation
import Report
import Sandbox

#if canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#endif

/// The empty folder a help call mounts as `/workspace` (the sandbox contract always mounts one). Like
/// `Workspace`, its removal is registered with the interruption's cleanups before `create()` makes it.
final class HelpFolder: @unchecked Sendable {
  let dir: URL
  private let removal = NSLock()
  private var removed = false

  init() {
    dir = FileManager.default.temporaryDirectory.appendingPathComponent("jig-help-\(UUID().uuidString)")
  }

  func create() throws {
    removal.lock()
    defer { removal.unlock() }
    guard !removed else {
      throw RefactorError(code: .INTERNAL, instructions: "the temporary folder \(dir.path) was already removed")
    }
    try FileManager.default.createDirectory(
      at: dir, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
  }

  /// Deletes the folder (the help call and an interruption may both ask). A failure is one line on
  /// stderr, never an error, and the next call tries again.
  func remove() {
    removal.lock()
    defer { removal.unlock() }
    guard !removed else { return }
    var info = stat()
    if lstat(dir.path, &info) != 0 && errno == ENOENT {
      removed = true
      return
    }
    do {
      try FileManager.default.removeItem(at: dir)
      removed = true
    } catch {
      let reason = String(describing: error).split(whereSeparator: \.isNewline).joined(separator: " ")
      FileHandle.standardError.write(Data("jig: could not remove \(dir.path): \(reason)\n".utf8))
    }
  }

  /// The folder's path until a `remove()` succeeded; nil once it is gone.
  var leftover: String? {
    removal.lock()
    defer { removal.unlock() }
    return removed ? nil : dir.path
  }
}

/// Asks `image` what it can do: resolves it as a run does (a registry image is downloaded and pinned),
/// runs it in `sandbox` with exactly `["--help"]` on an empty temporary folder, without network, and
/// checks its answer (`ImageHelpAnswer`). With `action`, the help holds only that action, and an action
/// the image does not have is `UNKNOWN_ACTION`. Touches no repo. Returns the pinned reference and the
/// notes resolving had (`PinnedImage.note`) with the help.
public func imageHelp(image: String, action: String?, sandbox: any Sandbox) throws
  -> (image: String, notes: [String], help: ImageHelp)
{
  // 1. The image, pinned (downloaded first when it is a registry image the store does not have).
  let pinned: PinnedImage
  do {
    pinned = try sandbox.resolve(image)
  } catch {
    // `verify` after other options is the help form with an image named verify: say how to verify.
    var failure = RefactorError.from(error)
    guard image == "verify", failure.code == .IMAGE_NOT_FOUND else { throw error }
    failure.instructions += " To verify commits, put `verify` first: jig verify [options] <commit-or-range>."
    throw failure
  }

  // 2. Run it with `--help` on an empty folder. The removal is registered before the folder exists, and
  // it is made while no interruption is handled, so a signal at any moment leaves nothing behind.
  let folder = HelpFolder()
  Lifecycle.shared.addCleanup(reporting: {
    folder.remove()
    return folder.leftover.map { ["the temporary folder \($0) (remove it: rm -rf '\($0)')"] } ?? []
  })
  try Lifecycle.shared.gated { try folder.create() }
  // Once an interruption started, its cleanup owns the removal (after the sandbox's).
  defer { Lifecycle.shared.unlessInterrupted { folder.remove() } }
  let ran = try sandbox.run(pinned, arguments: ["--help"], workspace: folder.dir)

  // 3. Its answer, checked.
  let help: ImageHelp
  switch ImageHelpAnswer.parse(
    stdout: String(decoding: ran.stdout, as: UTF8.self), stderr: String(decoding: ran.stderr, as: UTF8.self),
    termination: ran.termination)
  {
  case .help(let answered): help = answered
  case .failed(let error): throw error
  }
  let notes = pinned.note.map { [$0] } ?? []

  // 4. Only the action asked for.
  guard let action else {
    return (pinned.reference, notes, help)
  }
  guard let shown = help.actions.first(where: { $0.name == action }) else {
    throw RefactorError(
      code: .UNKNOWN_ACTION,
      instructions: "Unknown action \"\(action)\". This image has: "
        + help.actions.map(\.name).joined(separator: ", ") + ".")
  }
  return (pinned.reference, notes, ImageHelp(summary: help.summary, actions: [shown]))
}
