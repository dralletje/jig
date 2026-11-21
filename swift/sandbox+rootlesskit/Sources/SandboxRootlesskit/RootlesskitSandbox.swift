import CSandboxInit
import ChildProcess
import Foundation
import OCI
import Report
import Sandbox

#if canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#endif

/// Runs action images as direct children, without a daemon: rootlesskit gives a user, PID, network
/// (none), UTS, IPC and cgroup namespace; the in-sandbox init (`CSandboxInit`, run by re-executing this
/// binary) builds the root with `pivot_root`, drops to a non-root uid with no capabilities,
/// no_new_privs and a seccomp filter, and runs the image's entrypoint in `/workspace`.
///
/// Registry images come from jig's image store (`swift/oci`), unpacked into the image folder cache
/// without Docker; only `localhost/...` images are taken from local Docker (`docker export`).
///
/// A `Sandbox` (`swift/sandbox`): `resolve`, `run`, `cleanup`, `leftovers`. Everything a run starts dies
/// with its PID namespace; `cleanup()` removes its folders and the container of an image export in
/// progress, and `leftovers` names what it could not (a container docker would not remove, processes
/// not reaped in time, a folder it could not delete).
public final class RootlesskitSandbox: Sandbox, @unchecked Sendable {
  public struct Options: Sendable {
    /// The AppArmor exception on Ubuntu 24.04 is for exactly this path.
    public var rootlesskit = "/usr/bin/rootlesskit"
    public var docker = "docker"
    public var tar = "tar"
    /// nil: `RootfsCache.defaultRoot` (`$XDG_CACHE_HOME/jig/rootfs`).
    public var cacheRoot: URL?
    /// Where each run's folder (status file, rootlesskit state) goes; nil: the system temp folder.
    public var temporaryRoot: URL?
    /// The action's uid/gid inside the sandbox (mapped to the invoking host user). Non-zero.
    public var uid: UInt32 = 1000
    public var gid: UInt32 = 1000
    public var hostname = "jig"
    /// The executable rootlesskit runs as the in-sandbox init: any binary that links this package.
    /// nil: this process's own executable (`/proc/self/exe`).
    public var helper: String?
    /// How long `cleanup()` waits for the runs to reap what it killed before it reports them as left.
    public var reapWait = 5.0
    /// jig's image store, where registry images are downloaded to; nil: `OCIStore.defaultRoot`
    /// (`$XDG_CACHE_HOME/jig/oci`).
    public var ociRoot: URL?
    /// What talks to registries; nil: a `RegistryClient` over the network. Tests give one with a fake
    /// transport.
    public var registry: RegistryClient?

    public init() {}
  }

  let options: Options
  let registry = RunRegistry()
  private let cacheLock = NSLock()
  private let resolvedLock = NSLock()
  /// The registry images `resolve` returned, by `PinnedImage.id`, so `run` needs no second registry call.
  private var resolved: [String: ResolvedImage] = [:]
  private let client: RegistryClient
  /// Held by `cleanup()`, so a second caller waits for the first one's removals.
  private let cleaning = NSLock()
  private let leftLock = NSLock()
  /// What the cleanups could not remove.
  private var left: [String] = []

  public init(options: Options = Options()) {
    self.options = options
    self.client = options.registry ?? RegistryClient()
    // Keeps the constructor that runs the in-sandbox init linked into every binary that uses this.
    precondition(rc_sandbox_init_protocol_version() == 1)
  }

  /// Why this machine cannot run the sandbox, or nil when it can (rootlesskit present and executable).
  public static func unavailableReason(rootlesskit: String = "/usr/bin/rootlesskit") -> String? {
    guard access(rootlesskit, X_OK) == 0 else {
      return "\(rootlesskit) is missing or not executable: install rootlesskit (Ubuntu and Debian: sudo apt install "
        + "rootlesskit; on Ubuntu 24.04 its package also installs the AppArmor profile /etc/apparmor.d/rootlesskit, "
        + "which is what allows its user namespace)"
    }
    guard access("/proc/self/exe", R_OK) == 0 else { return "/proc is not mounted" }
    return nil
  }

  var docker: DockerImages { DockerImages(docker: options.docker, tar: options.tar) }

  func cache() throws -> RootfsCache {
    guard let root = options.cacheRoot ?? RootfsCache.defaultRoot(environment: ProcessInfo.processInfo.environment) else {
      throw RefactorError(.INTERNAL, "no cache folder: set XDG_CACHE_HOME or HOME")
    }
    return RootfsCache(root: root, registry: registry)
  }

  /// jig's image store.
  func store() throws -> OCIStore {
    guard let root = options.ociRoot ?? OCIStore.defaultRoot(environment: ProcessInfo.processInfo.environment) else {
      throw RefactorError(.INTERNAL, "no cache folder for jig's image store: set XDG_CACHE_HOME or HOME")
    }
    return OCIStore(root: root)
  }

  // MARK: - resolve

  /// A `localhost/...` reference is a local Docker image: pinned to its local image ID. A reference
  /// already pinned (`<name>@sha256:<id>`, a replay) is accepted as it is when its image folder is
  /// cached; otherwise docker must have the ID.
  ///
  /// Anything else is a registry image, resolved through jig's image store (`ImagePuller`): `id` is the
  /// manifest for this machine's platform, `reference` what was typed plus the digest its tag points to.
  /// Docker is not used.
  public func resolve(_ reference: String) throws -> PinnedImage {
    if !isLocalImage(reference) {
      let puller = ImagePuller(store: try store(), client: client)
      let image = try puller.resolve(try ImageReference.parse(reference))
      let id = image.manifest.description
      resolvedLock.lock()
      resolved[id] = image
      resolvedLock.unlock()
      return PinnedImage(id: id, reference: puller.pinnedReference(typed: reference, image), note: image.note)
    }
    if let (_, id) = PinnedImage.split(reference) {
      if try cache().load(imageID: id) != nil { return PinnedImage(id: id, reference:reference) }
      let inspected = try docker.inspect(id, registry: registry)
      guard inspected.id == id else { throw RefactorError(.IMAGE_NOT_FOUND, "There is no local image with the ID \(id).") }
      return PinnedImage(id: id, reference:reference)
    }
    let inspected = try docker.inspect(reference, registry: registry)
    return PinnedImage(id: inspected.id, reference:"\(reference)@\(inspected.id)")
  }

  /// The image's folder, from the cache or made now (once per image ID): a registry image unpacked
  /// from jig's image store, a local image exported from Docker.
  func imageFolder(_ image: PinnedImage) throws -> CacheEntry {
    cacheLock.lock()
    defer { cacheLock.unlock() }
    let cache = try cache()
    if let entry = cache.load(imageID: image.id) { return entry }
    if !isLocalImage(image.reference) {
      let pulled = try registryImage(image)
      let store = try store()
      let registry = self.registry
      return try cache.ensure(imageID: image.id) { rootfs, _ in
        try unpackLayers(pulled.layers.map { (descriptor: $0, file: store.blobURL($0.digest)) }, into: rootfs)
        if registry.isStopped { throw RunRegistry.interrupted }
        return ImageConfig(entrypoint: pulled.config.entrypoint, cmd: pulled.config.cmd, env: pulled.config.env)
      }
    }
    let docker = self.docker
    return try cache.ensure(imageID: image.id) { rootfs, scratch in
      let inspected = try docker.inspect(image.id, registry: registry)
      guard inspected.id == image.id else { throw RefactorError(.IMAGE_NOT_FOUND, "There is no local image with the ID \(image.id).") }
      try docker.export(imageID: image.id, into: rootfs, scratch: scratch, registry: registry)
      return inspected.config
    }
  }

  /// The registry image `image` names, in the store: the one `resolve` returned, or, for a
  /// `PinnedImage` this sandbox did not resolve, its `reference` resolved again (the store first, then
  /// the registry). It must be the manifest `image.id` names.
  func registryImage(_ image: PinnedImage) throws -> ResolvedImage {
    resolvedLock.lock()
    let known = resolved[image.id]
    resolvedLock.unlock()
    if let known { return known }
    let pulled = try ImagePuller(store: try store(), client: client).resolve(try ImageReference.parse(image.reference))
    guard pulled.manifest.description == image.id else {
      throw RefactorError(
        .IMAGE_NOT_FOUND,
        "\(image.reference) resolves to the manifest \(pulled.manifest) on this machine, not to \(image.id).")
    }
    resolvedLock.lock()
    resolved[image.id] = pulled
    resolvedLock.unlock()
    return pulled
  }

  // MARK: - run

  /// Runs the image's entrypoint with `arguments` (docker's rule: the image's `Cmd` when empty) on
  /// `workspace`, mounted read-write at `/workspace`, the working directory.
  public func run(_ image: PinnedImage, arguments: [String], workspace: URL) throws -> SandboxRun {
    try execute(image, command: nil, arguments: arguments, workspace: workspace)
  }

  /// Runs `command` instead of the image's entrypoint (like `docker run --entrypoint`), with the same
  /// sandbox: the tests run their probe this way.
  public func run(_ image: PinnedImage, command: [String], workspace: URL) throws -> SandboxRun {
    try execute(image, command: command, arguments: [], workspace: workspace)
  }

  private func execute(_ image: PinnedImage, command: [String]?, arguments: [String], workspace: URL) throws
    -> SandboxRun
  {
    if let reason = Self.unavailableReason(rootlesskit: options.rootlesskit) { throw RefactorError(.INTERNAL, reason) }
    if registry.isStopped { throw RunRegistry.interrupted }
    let entry = try imageFolder(image)
    let argv = command ?? entry.config.command(arguments: arguments)
    guard !argv.isEmpty else { throw RefactorError(.INTERNAL, "the image \(image.reference) has no entrypoint and no command") }
    guard let workspacePath = realPath(workspace.path), isRealDirectory(workspacePath) else {
      throw RefactorError(.INTERNAL, "the workspace \(workspace.path) is not a folder")
    }
    guard let rootfsPath = realPath(entry.rootfs.path) else {
      throw RefactorError(.INTERNAL, "the image folder \(entry.rootfs.path) is gone")
    }
    let helper = try helperExecutable()

    var tempRoot = options.temporaryRoot ?? FileManager.default.temporaryDirectory
    if tempRoot.path.utf8.count > 70 { tempRoot = URL(fileURLWithPath: "/tmp") }
    Self.sweepStaleRunFolders(in: tempRoot)
    let runDir = try makeRunFolder(in: tempRoot)
    defer {
      RootfsCache.forceRemove(URL(fileURLWithPath: runDir))
      registry.removeTemporary(runDir)
    }
    let statusFile = runDir + "/status"
    let arguments = Self.rootlesskitArguments(
      stateDir: runDir + "/rk", helper: helper, statusFile: statusFile, rootfs: rootfsPath,
      workspace: workspacePath, uid: options.uid, gid: options.gid, hostname: options.hostname,
      environment: entry.config.environment(hostname: options.hostname), command: argv)

    // The lifeline: rootlesskit's stdin, passed down to the init. Only this process holds the write
    // end, so when this process dies (even by SIGKILL) the init reads EOF and kills the sandbox.
    var lifeline: [Int32] = [-1, -1]
    guard rc_pipe_cloexec(&lifeline) == 0 else { throw RefactorError(.INTERNAL, "pipe: \(String(cString: strerror(errno)))") }
    var token = 0
    let child: StartedChild
    do {
      child = try registry.spawn {
        // Through the launcher (this binary again): PDEATHSIG on rootlesskit itself, armed before its
        // exec, so the kernel kills it when this process dies; nothing inside can clear it.
        let started = try Spawner.start(
          path: helper,
          arguments: Self.launchArguments(parentPID: getpid(), rootlesskit: options.rootlesskit, arguments: arguments),
          environment: Self.rootlesskitEnvironment, stdinFd: lifeline[0])
        token = registry.addLifelineLocked(lifeline[1])
        return started
      }
    } catch {
      close(lifeline[0])
      close(lifeline[1])
      if let failure = error as? RefactorError { throw failure }
      throw RefactorError(.INTERNAL, "\(error)")
    }
    close(lifeline[0])
    // Reaped under the registry's lock, which `cleanup()` signals under: never a reused group ID.
    let output = Spawner.collect(child, reap: registry.reap)
    registry.closeLifeline(token)

    let statusText = (try? String(contentsOfFile: statusFile, encoding: .utf8)) ?? ""
    switch Self.parseStatus(statusText) {
    case .finished(let termination)?:
      return SandboxRun(termination: termination, stdout: output.stdout, stderr: output.stderr)
    case .failed(let reason)?:
      if registry.isStopped { throw RunRegistry.interrupted }
      throw RefactorError(
        .INTERNAL, "the rootlesskit sandbox could not run the image \(image.reference): \(reason)"
          + Self.stderrTail(output.stderr))
    case nil:
      if registry.isStopped { throw RunRegistry.interrupted }
      throw RefactorError(
        .INTERNAL, "rootlesskit ended (\(output.termination)) before the sandbox reported a status"
          + Self.stderrTail(output.stderr))
    }
  }

  // MARK: - cleanup

  /// Kills everything every run of this sandbox started (rootlesskit's process group, and with it the
  /// sandbox; docker and tar of an image export), removes export containers (also one the daemon
  /// creates after its `docker create` was killed) and temporary folders, and refuses new runs.
  /// Idempotent; meant for the signal path (no new process starts except `docker rm -f` and `docker ps`
  /// of an export container). What it could not remove is in `leftovers`.
  public func cleanup() {
    cleaning.lock()
    defer { cleaning.unlock() }
    let snapshot = registry.stop()
    var left: [String] = []
    // Launchers: signalled under the registry's lock, only while unreaped (`registry.reap`).
    registry.signalGroups(SIGKILL)
    // Docker and tar were started by `runProcess`: `Lifecycle` signals them only while unreaped.
    for group in snapshot.helpers { Lifecycle.shared.signalGroup(group, SIGKILL) }
    for fd in snapshot.lifelines { close(fd) }
    // The runs reap their processes; wait for that (the sandbox's PID namespace is gone with them). Only
    // what was running at `stop()`: a run's own `docker rm` of its export container may start meanwhile.
    let killed = Set(snapshot.groups + snapshot.helpers)
    func stillLive() -> [pid_t] { registry.live.filter(killed.contains) }
    let deadline = Date().addingTimeInterval(options.reapWait)
    while !stillLive().isEmpty && Date() < deadline { usleep(25_000) }
    registry.signalGroups(SIGKILL)
    for group in snapshot.helpers { Lifecycle.shared.signalGroup(group, SIGKILL) }
    let live = stillLive()
    if !live.isEmpty {
      let groups = live.map(String.init).joined(separator: " ")
      let negated = live.map { "-\($0)" }.joined(separator: " ")
      left.append(
        "processes of the rootlesskit sandbox that had not ended \(String(format: "%g", options.reapWait)) s after SIGKILL (process "
          + "groups \(groups); check: ps -o pid,args -g \(live.map(String.init).joined(separator: ",")); end them: "
          + "kill -KILL -- \(negated))")
      FileHandle.standardError.write(
        Data("jig: processes of the rootlesskit sandbox (process groups \(groups)) had not ended\n".utf8))
    }
    let docker = self.docker.cli(registry)
    for name in snapshot.containers.sorted() where !docker.removeContainer(name) {
      left.append("the container \(name) (remove it: docker rm -f \(name))")
    }
    for path in registry.takeTemporary().sorted() {
      let url = URL(fileURLWithPath: path)
      RootfsCache.forceRemove(url)
      var st = stat()
      if lstat(path, &st) == 0 { left.append("the temporary folder \(path) (remove it: chmod -R u+w '\(path)' && rm -rf '\(path)')") }
    }
    leftLock.lock()
    for item in left where !self.left.contains(item) { self.left.append(item) }
    leftLock.unlock()
  }

  /// What the cleanups could not remove (see `Sandbox.leftovers`).
  public var leftovers: [String] {
    leftLock.lock()
    defer { leftLock.unlock() }
    return left
  }

  // MARK: - Pieces (internal for the tests)

  static let rootlesskitEnvironment = ["PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C"]

  /// rootlesskit's argv: namespaces (no network, no host loopback, own PID/UTS/IPC/cgroup), a state
  /// folder of our own, then the init with its arguments (see sandbox_init.c).
  static func rootlesskitArguments(
    stateDir: String, helper: String, statusFile: String, rootfs: String, workspace: String,
    uid: UInt32, gid: UInt32, hostname: String, environment: [String], command: [String]
  ) -> [String] {
    [
      "--net=none", "--disable-host-loopback", "--pidns", "--utsns", "--ipcns", "--cgroupns",
      "--propagation=rprivate", "--state-dir", stateDir, "--",
      helper, RC_SANDBOX_INIT_MARKER, statusFile, rootfs, workspace, String(uid), String(gid), hostname,
      String(environment.count),
    ] + environment + [String(command.count)] + command
  }

  /// The launcher's argv (after the helper path): marker, our PID (checked after PDEATHSIG is armed),
  /// then rootlesskit's own argv.
  static func launchArguments(parentPID: pid_t, rootlesskit: String, arguments: [String]) -> [String] {
    [RC_SANDBOX_LAUNCH_MARKER, String(parentPID), rootlesskit] + arguments
  }

  enum InitStatus: Equatable {
    case finished(Termination)
    case failed(String)
  }

  /// The first line of the status file the init writes.
  static func parseStatus(_ text: String) -> InitStatus? {
    guard let line = text.split(separator: "\n", omittingEmptySubsequences: true).first else { return nil }
    let parts = line.split(separator: " ", maxSplits: 1)
    guard parts.count == 2 else { return nil }
    switch parts[0] {
    case "exit":
      guard let code = Int32(parts[1]), (0...255).contains(code) else { return nil }
      return .finished(.exited(code))
    case "signal":
      guard let sig = Int32(parts[1]), (1...64).contains(sig) else { return nil }
      return .finished(.signaled(sig))
    case "error":
      return .failed(String(parts[1]))
    default:
      return nil
    }
  }

  static func stderrTail(_ data: Data) -> String {
    let text = String(decoding: data.suffix(2000), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty ? "" : " (stderr: \(text))"
  }

  /// Short: rootlesskit's api.sock goes in `<run folder>/rk/`, and a unix socket path has 107 bytes.
  static let runFolderPrefix = "rcrk-"

  private func makeRunFolder(in root: URL) throws -> String {
    var template = Array((root.path + "/" + Self.runFolderPrefix + "\(getpid())-XXXXXX").utf8CString)
    guard let made = template.withUnsafeMutableBufferPointer({ mkdtemp($0.baseAddress!) }) else {
      throw RefactorError(.INTERNAL, "could not create a run folder in \(root.path): \(String(cString: strerror(errno)))")
    }
    let path = String(cString: made)
    do {
      try registry.addTemporary(path)
    } catch {
      RootfsCache.forceRemove(URL(fileURLWithPath: path))
      throw error
    }
    return path
  }

  /// Run folders of processes that are gone (killed with SIGKILL, which no cleanup survives).
  static func sweepStaleRunFolders(in root: URL) {
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: root.path) else { return }
    for name in names where name.hasPrefix(runFolderPrefix) {
      let rest = name.dropFirst(runFolderPrefix.count)
      guard let pid = pid_t(rest.prefix(while: { $0 != "-" })), pid != getpid() else { continue }
      if kill(pid, 0) != 0 && errno == ESRCH {
        let path = root.appendingPathComponent(name)
        var st = stat()
        // Only our own folders.
        if lstat(path.path, &st) == 0, st.st_uid == getuid(), (st.st_mode & S_IFMT) == S_IFDIR {
          RootfsCache.forceRemove(path)
        }
      }
    }
  }

  private func helperExecutable() throws -> String {
    if let helper = options.helper { return helper }
    guard let path = realPath("/proc/self/exe") else {
      throw RefactorError(.INTERNAL, "cannot find this binary (/proc/self/exe) to run as the sandbox init")
    }
    return path
  }
}

func realPath(_ path: String) -> String? {
  guard let resolved = realpath(path, nil) else { return nil }
  defer { free(resolved) }
  return String(cString: resolved)
}
