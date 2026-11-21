import ChildProcess
import Docker
import Foundation
import Report

/// Docker is used only to obtain the image: its ID and configuration (`docker image inspect`) and its
/// files (`docker create` + `docker export`, unpacked with `tar`). Nothing runs in Docker.
struct DockerImages: Sendable {
  /// The name of every container `export` creates starts with this.
  static let exportContainerPrefix = "jig-export-"

  var docker: String
  var tar: String

  struct Inspected: Equatable, Sendable {
    var id: String
    var config: ImageConfig
  }

  /// The docker commands shared with sandbox+docker, run through the registry (so `cleanup()` can stop
  /// them).
  func cli(_ registry: RunRegistry) -> DockerCLI {
    let docker = self.docker
    return DockerCLI(run: { arguments, gated in
      try registry.runTracked(docker, arguments, environment: nil, gated: gated)
    })
  }

  /// `docker image inspect` of `ref`; IMAGE_NOT_FOUND with instructions when docker does not have it, and
  /// INTERNAL with Docker's instructions when the daemon cannot be reached (as sandbox+docker).
  func inspect(_ ref: String, registry: RunRegistry) throws -> Inspected {
    let run = try runDocker(["image", "inspect", "--", ref], registry: registry)
    guard run.succeeded else { throw cli(registry).inspectFailure(reference: ref, stderr: run.stderrText) }
    return try Self.parseInspect(run.stdout)
  }

  /// The first object of `docker image inspect`'s JSON array.
  static func parseInspect(_ data: Data) throws -> Inspected {
    guard let array = try? JSONSerialization.jsonObject(with: data) as? [Any],
      let object = array.first as? [String: Any],
      let id = object["Id"] as? String, isImageID(id)
    else { throw RefactorError(.INTERNAL, "docker image inspect printed something unexpected") }
    let config = object["Config"] as? [String: Any] ?? [:]
    return Inspected(
      id: id,
      config: ImageConfig(
        entrypoint: config["Entrypoint"] as? [String] ?? [],
        cmd: config["Cmd"] as? [String] ?? [],
        env: config["Env"] as? [String] ?? []))
  }

  /// Writes the files of image `id` into `rootfs` (empty), using `scratch` for the archive.
  func export(imageID: String, into rootfs: URL, scratch: URL, registry: RunRegistry) throws {
    let name = "\(Self.exportContainerPrefix)\(randomSuffix())"
    // Known before it exists, so an interruption can remove it even while `docker create` runs.
    try registry.addContainer(name)
    // A `docker create` that ended by itself has nothing in flight; one that was killed (or that an
    // interruption cut short) may still get its container from the daemon later: look for it a while.
    var createEnded = false
    defer {
      let window = createEnded && !registry.isStopped ? 0 : lateCreationWindow
      // Removed: forget it. Not removed: it stays registered, so an interruption's cleanup (which
      // reports what it could not remove) tries again.
      if cli(registry).removeContainer(name, window: window) { registry.removeContainer(name) }
    }
    let create = try runDocker(
      // The entrypoint is never run; it only keeps `docker create` from asking for a command.
      ["create", "--name", name, "--network", "none", "--entrypoint", "/jig-export-only", "--", imageID],
      registry: registry)
    if case .exited = create.termination { createEnded = true }
    guard create.succeeded else {
      throw RefactorError(.INTERNAL, "docker create \(imageID) failed: \(create.stderrText.trimmingCharacters(in: .whitespacesAndNewlines))")
    }
    let archive = scratch.appendingPathComponent("image.tar")
    let export = try runDocker(["export", "-o", archive.path, name], registry: registry)
    guard export.succeeded else {
      throw RefactorError(.INTERNAL, "docker export \(imageID) failed: \(export.stderrText.trimmingCharacters(in: .whitespacesAndNewlines))")
    }
    // -p keeps the modes (no umask); ownership is the invoking user's (we cannot chown anyway).
    let untar: ProcessOutput
    do {
      untar = try registry.runTracked(
        tar, ["-x", "-p", "--no-same-owner", "-f", archive.path, "-C", rootfs.path],
        environment: ["PATH": "/usr/bin:/bin", "LC_ALL": "C"])
    } catch let missing as ExecutableNotFound {
      throw RefactorError(.INTERNAL, Self.tarMissing(missing.name))
    }
    guard untar.succeeded else {
      throw RefactorError(
        .INTERNAL,
        "tar could not unpack the files of the image \(imageID) (\(untar.termination)): "
          + "\(oneLine(untar.stderrText)). Check that tar works (tar --version) and that the cache folder "
          + "\(rootfs.deletingLastPathComponent().deletingLastPathComponent().path) has room for the image's files, "
          + "then run again.")
    }
    try? FileManager.default.removeItem(at: archive)
  }

  /// The instructions for a machine without tar.
  static func tarMissing(_ name: String) -> String {
    "\(name) was not found. The rootlesskit sandbox unpacks an image's files with tar the first time it runs "
      + "that image: install tar (Ubuntu: sudo apt install tar) or put it on PATH, then run again."
  }

  /// A docker command, with the user's environment (DOCKER_HOST, XDG_RUNTIME_DIR for rootless docker).
  /// No docker at all is `INTERNAL` with what to install.
  func runDocker(_ arguments: [String], registry: RunRegistry, gated: Bool = true) throws -> ProcessOutput {
    do {
      return try registry.runTracked(docker, arguments, environment: nil, gated: gated)
    } catch let missing as ExecutableNotFound {
      throw RefactorError(.INTERNAL, Self.dockerMissing(missing.name))
    }
  }

  /// The instructions for a machine without docker.
  static func dockerMissing(_ name: String) -> String {
    "\(name) was not found on PATH. The rootlesskit sandbox uses Docker only for localhost/ images, to look one up "
      + "and to copy its files out once (docker image inspect, create, export; nothing runs in Docker). Install "
      + "Docker (Ubuntu: apt install docker.io, or rootless Docker: https://docs.docker.com/engine/security/rootless/), "
      + "build the image, then run again. A replay of a pinned reference whose image folder is already cached "
      + "needs no Docker, and registry images never do."
  }
}
