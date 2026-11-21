import ChildProcess
import Docker
import Foundation
import OCI
import Report
import Sandbox

#if canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#endif

/// The instructions for a machine without docker on PATH.
let dockerMissing =
  "docker was not found on PATH. --sandbox docker (the default) runs the image with Docker: install Docker "
  + "(Ubuntu: sudo apt install docker.io; or Docker Engine, also rootless: https://docs.docker.com/engine/install/), "
  + "start its daemon or put docker on PATH, build or pull the image, then run again."

private let docker = DockerCLI()

private func inspectId(_ ref: String) throws -> String {
  let run: ProcessOutput
  do {
    run = try runProcess("docker", ["image", "inspect", "--format", "{{.Id}}", "--", ref])
  } catch is ExecutableNotFound {
    throw RefactorError(code: .INTERNAL, instructions: dockerMissing)
  }
  guard run.succeeded else { throw docker.inspectFailure(reference: ref, stderr: run.stderrText) }
  return run.stdoutText.trimmingCharacters(in: .whitespacesAndNewlines)
}

/// The error for a `docker run` that failed in Docker itself rather than in the image, or nil. `docker
/// run` exits with 125 when docker (client or daemon) failed, 126 when the container's command could not
/// be invoked and 127 when it was not found; it then says so on stderr as `docker: ...`. The image's own
/// exit codes 125–127, without such a line, stay the image's.
func dockerRunFailure(_ client: Termination, stderr: String) -> RefactorError? {
  guard case .exited(let code) = client, (125...127).contains(code) else { return nil }
  let markers = ["docker: ", "Error response from daemon", "Cannot connect to the Docker daemon"]
  guard markers.contains(where: { stderr.contains($0) }) else { return nil }
  let what =
    switch code {
    case 125: "docker itself failed"
    case 126: "Docker could not invoke the image's command"
    default: "Docker could not find the image's command"
    }
  return RefactorError(
    code: .INTERNAL,
    instructions: "docker run failed (exit code \(code)): \(oneLine(stderr)). \(what), before the image ran; nothing "
      + "was changed in the repository. \(dockerNextStep) If docker run works for other images and the image's "
      + "command is missing, rebuild the image.")
}

/// A container name of its own for each run, so an interruption can remove exactly that container.
func newContainerName() -> String {
  "jig-" + UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
}

/// How the image's process ended. `docker run` exits with the container's exit code, and with 128 + N
/// when the container's process was killed by signal N (125–127 are docker's own failures).
func containerTermination(_ client: Termination) -> Termination {
  if case .exited(let code) = client, code > 128, code <= 128 + 64 { return .signaled(code - 128) }
  return client
}

/// The error for a registry image when there is no folder for jig's image store.
let noStoreFolder =
  "jig keeps registry images in $XDG_CACHE_HOME/jig/oci, else $HOME/.cache/jig/oci, and neither XDG_CACHE_HOME "
  + "(an absolute path) nor HOME is set. Set one of them, then run again; or use a local image (localhost/...) "
  + "built or pulled with Docker."

/// Runs the image with the Docker daemon: `docker run --rm --name <unique> --network none --read-only
/// --tmpfs /tmp -v <workspace>:/workspace -w /workspace <image> <args...>`. A local image
/// (`localhost/...`) runs by its local image ID; a registry image is downloaded into jig's image store
/// by the `ImagePuller`, loaded into Docker once as `dockerName(for: manifest)`, checked to be that
/// image, and run by its Docker image ID.
/// `cleanup()` removes the run's container with `docker rm -f` (and keeps looking for
/// `lateCreationWindow` seconds, see `DockerCLI.removeContainer`) and the archive of a load that was
/// interrupted. See the package README for its known flaws.
public final class DockerSandbox: Sandbox, @unchecked Sendable {
  private let lock = NSLock()
  private let cleaning = NSLock()
  /// Guards `archive` only. It is taken inside `Lifecycle.shared.gated`, so it is never held while
  /// waiting for `Lifecycle`'s lock.
  private let archiveLock = NSLock()
  /// Downloads registry images; nil when there is no folder for the store (`noStoreFolder`).
  private let puller: ImagePuller?
  /// The container of the run in progress, or of one that was interrupted.
  private var container: String?
  /// The Docker archive of a load in progress, or of one that was interrupted.
  var archive: URL?
  /// What the last cleanup could not remove.
  private var left: [String] = []
  /// What `run` runs for each image ID `resolve` returned: the ID itself for a local image, the checked
  /// Docker image ID of `dockerName(for:)` for a registry image (loaded by then).
  private var dockerImages: [String: String] = [:]
  /// How many times `docker load` ran (for tests).
  var loads = 0

  /// `puller` downloads registry images; by default one over the store at
  /// `OCIStore.defaultRoot(environment:)` and the registries on the network.
  public convenience init(puller: ImagePuller? = nil) {
    self.init(puller: puller, environment: ProcessInfo.processInfo.environment)
  }

  init(puller: ImagePuller?, environment: [String: String]) {
    if let puller {
      self.puller = puller
    } else if let root = OCIStore.defaultRoot(environment: environment) {
      self.puller = ImagePuller(store: OCIStore(root: root), client: RegistryClient())
    } else {
      self.puller = nil
    }
  }

  /// A local image (`localhost/...`): a reference pinned with `@sha256:<id>` (a replay) runs that local
  /// image ID as long as it exists, whatever its tag points at now; local images have no registry
  /// digest, so docker cannot resolve the reference itself. Anything else is inspected and pinned to its
  /// current ID. A registry image: see `resolveRegistry`.
  public func resolve(_ reference: String) throws -> PinnedImage {
    guard isLocalImage(reference) else { return try resolveRegistry(reference) }
    let pinned: PinnedImage
    if let (_, id) = PinnedImage.split(reference) {
      _ = try inspectId(id)
      pinned = PinnedImage(id: id, reference: reference)
    } else {
      let id = try inspectId(reference)
      pinned = PinnedImage(id: id, reference: "\(reference)@\(id)")
    }
    lock.lock()
    dockerImages[pinned.id] = pinned.id
    lock.unlock()
    return pinned
  }

  /// Resolves `reference` with the puller (its manifest, config and layers in the store) and makes sure
  /// Docker has it as `dockerName(for: manifest)`: when `docker image inspect` does not find that name,
  /// or finds an image that is not this one, the image is written as a Docker archive into the store's
  /// temporary folder, loaded with `docker load -i` (which moves the name to it), and the archive is
  /// deleted. Whatever has the name is checked to be the image itself, as anyone with access to Docker
  /// can `docker tag` another image to it: its ID must be the platform manifest's digest (Docker's
  /// containerd image store) or the config's digest (the classic store). `run` runs it by that ID, so
  /// the name moving afterwards changes nothing. Pinned like rootlesskit pins it: `id` is the manifest
  /// digest, `reference` what was typed plus the digest the tag points to.
  func resolveRegistry(_ reference: String) throws -> PinnedImage {
    let ref = try ImageReference.parse(reference)
    guard let puller else { throw RefactorError(code: .INTERNAL, instructions: noStoreFolder) }
    let resolved = try puller.resolve(ref)
    let name = dockerName(for: resolved.manifest)
    let accepted = [resolved.manifest.description, resolved.configDescriptor.digest.description]
    var dockerId = try dockerImageId(name)
    if dockerId == nil || !accepted.contains(dockerId ?? "") {
      try load(resolved, as: name, from: puller.store)
      dockerId = try dockerImageId(name)
    }
    guard let dockerId, accepted.contains(dockerId) else {
      throw RefactorError(
        code: .INTERNAL,
        instructions: "Docker has the image \(name) as \(dockerId ?? "nothing") right after jig loaded it from its "
          + "image store, but it should be \(resolved.manifest) or \(resolved.configDescriptor.digest). Remove it "
          + "(docker rmi --force \(name)) and run again; if it happens again, report it as a jig bug.")
    }
    lock.lock()
    dockerImages[resolved.manifest.description] = dockerId
    lock.unlock()
    return PinnedImage(
      id: resolved.manifest.description, reference: puller.pinnedReference(typed: reference, resolved),
      note: resolved.note)
  }

  /// The ID of the image `name` in Docker, or nil when Docker does not have it. Throws `INTERNAL` when
  /// docker is missing or its daemon cannot be reached.
  private func dockerImageId(_ name: String) throws -> String? {
    let run: ProcessOutput
    do {
      run = try runProcess("docker", ["image", "inspect", "--format", "{{.Id}}", "--", name])
    } catch is ExecutableNotFound {
      throw RefactorError(code: .INTERNAL, instructions: dockerMissing)
    }
    if run.succeeded { return run.stdoutText.trimmingCharacters(in: .whitespacesAndNewlines) }
    if run.stderrText.contains("No such image") { return nil }
    if !docker.daemonReachable() {
      throw inspectFailure(reference: name, stderr: run.stderrText, daemonReachable: false)
    }
    return nil
  }

  /// Writes `image` as a Docker archive into the store's temporary folder, `docker load`s it and deletes
  /// it. The archive is recorded before it exists (under `Lifecycle.shared.gated`), so an interruption
  /// at any moment finds it: `cleanup()` deletes it.
  private func load(_ image: ResolvedImage, as name: String, from store: OCIStore) throws {
    let file = try Lifecycle.shared.gated { () throws -> URL in
      let file = try store.temporaryFile()
      archiveLock.lock()
      archive = file
      archiveLock.unlock()
      return file
    }
    // Deleted whatever happens; once an interruption started, its cleanup owns that.
    defer { Lifecycle.shared.unlessInterrupted { _ = removeArchive() } }
    try writeDockerArchive(image, from: store, to: file)
    let loaded: ProcessOutput
    do {
      loaded = try runProcess("docker", ["load", "-i", file.path])
    } catch is ExecutableNotFound {
      throw RefactorError(code: .INTERNAL, instructions: dockerMissing)
    }
    lock.lock()
    loads += 1
    lock.unlock()
    guard loaded.succeeded else {
      throw RefactorError(
        code: .INTERNAL,
        instructions: "docker load could not load the image \(name) from jig's image store (docker: "
          + "\(oneLine(loaded.stderrText))). \(dockerNextStep)")
    }
  }

  /// Deletes the recorded archive, if any; returns what could not be deleted.
  private func removeArchive() -> [String] {
    archiveLock.lock()
    let file = archive
    archive = nil
    archiveLock.unlock()
    guard let file else { return [] }
    do {
      try FileManager.default.removeItem(at: file)
    } catch {
      if FileManager.default.fileExists(atPath: file.path) {
        return ["the temporary file \(file.path) (remove it: rm -f '\(file.path)')"]
      }
    }
    return []
  }

  /// The local image ID for a local image; the checked Docker image ID of `dockerName(for:)` for a
  /// registry image. An image this
  /// sandbox did not resolve is resolved again from its reference (for a registry image: from the store
  /// when it has it, and loaded into Docker when Docker does not).
  public func run(_ image: PinnedImage, arguments: [String], workspace: URL) throws -> SandboxRun {
    lock.lock()
    var known = dockerImages[image.id]
    lock.unlock()
    if known == nil {
      if isLocalImage(image.reference) {
        known = image.id
      } else {
        let resolved = try resolve(image.reference)
        lock.lock()
        known = dockerImages[resolved.id]
        lock.unlock()
      }
    }
    guard let dockerImage = known else {
      throw RefactorError(
        code: .INTERNAL,
        instructions: "The image \(image.reference) was resolved but has no Docker image to run. Report it as a "
          + "jig bug.")
    }
    let name = newContainerName()
    lock.lock()
    container = name
    lock.unlock()
    let ran = try runProcess(
      "docker",
      [
        "run", "--rm", "--name", name, "--network", "none", "--read-only", "--tmpfs", "/tmp", "-v",
        "\(workspace.path):/workspace", "-w", "/workspace", dockerImage,
      ] + arguments)
    // `--rm` removed the container. When the run was interrupted, the name stays for `cleanup()`, which
    // may be about to run on the signal queue.
    lock.lock()
    if !Lifecycle.shared.isInterrupted { container = nil }
    lock.unlock()
    if let failure = dockerRunFailure(ran.termination, stderr: ran.stderrText) { throw failure }
    return SandboxRun(termination: containerTermination(ran.termination), stdout: ran.stdout, stderr: ran.stderr)
  }

  public func cleanup() {
    // A second caller waits for the first one's removal, so neither returns before it is done.
    cleaning.lock()
    defer { cleaning.unlock() }
    var notRemoved = removeArchive()
    lock.lock()
    let name = container
    container = nil
    lock.unlock()
    if let name, !docker.removeContainer(name) {
      notRemoved.append("the container \(name) (remove it: docker rm -f \(name))")
    }
    lock.lock()
    left = notRemoved
    lock.unlock()
  }

  public var leftovers: [String] {
    lock.lock()
    defer { lock.unlock() }
    return left
  }
}
