import Foundation
import Report
import Sandbox

// `PinnedImage`, `SandboxRun` and `Sandbox` come from `swift/sandbox`, `Termination` and `RefactorError`
// from `swift/report`: what this package returns is what the CLI records and prints.

extension RefactorError {
  /// A failure of the sandbox itself (not of the action): `IMAGE_NOT_FOUND` or `INTERNAL`, with
  /// instructions.
  init(_ code: ErrorCode, _ instructions: String) {
    self.init(code: code, instructions: instructions)
  }
}

/// What the runtime needs from the image's configuration (from `docker image inspect`), kept next to
/// the image files in the cache so a run needs no docker at all.
struct ImageConfig: Codable, Equatable, Sendable {
  var entrypoint: [String]
  var cmd: [String]
  var env: [String]

  /// docker's rule: the entrypoint, then the run's arguments, or the image's `Cmd` when there are none.
  func command(arguments: [String]) -> [String] {
    entrypoint + (arguments.isEmpty ? cmd : arguments)
  }

  /// The action's whole environment: the image's, plus `HOME=/root` and `HOSTNAME` as `docker run`
  /// adds them when the image does not set them. Nothing of the host's environment.
  func environment(hostname: String) -> [String] {
    var result = env
    let names = Set(env.map { String($0.prefix(while: { $0 != "=" })) })
    if !names.contains("PATH") { result.append("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin") }
    if !names.contains("HOSTNAME") { result.append("HOSTNAME=\(hostname)") }
    if !names.contains("HOME") { result.append("HOME=/root") }
    return result
  }
}

/// `sha256:<64 lowercase hex>`, the only image ID form this package accepts (it becomes a path).
func isImageID(_ id: String) -> Bool {
  guard id.hasPrefix("sha256:") else { return false }
  let hex = id.dropFirst("sha256:".count)
  return hex.count == 64 && hex.unicodeScalars.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
}
