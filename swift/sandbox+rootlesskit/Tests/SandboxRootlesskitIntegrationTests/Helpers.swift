// Helpers for the integration tests: real rootlesskit, real docker images (built by
// scripts/build-images.sh with the standard tags; never deleted here), a static C probe.
import Foundation
import Testing

@testable import SandboxRootlesskit

#if canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#endif

struct TestFailure: Error, CustomStringConvertible {
  var description: String
  init(_ description: String) { self.description = description }
}

/// `swift/sandbox+rootlesskit/Tests/SandboxRootlesskitIntegrationTests/Helpers.swift` → repo root.
let repoRoot = URL(fileURLWithPath: #filePath)
  .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
  .deletingLastPathComponent().deletingLastPathComponent()
let testsDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()

let TS = "localhost/jig/typescript:local"
let PRETTIER = "localhost/jig/prettier:local"

/// Runs a host tool to its end (argv only).
@discardableResult
func host(_ tool: String, _ arguments: [String]) throws -> ChildOutput {
  guard let path = Spawner.find(tool) else { throw TestFailure("\(tool) not found") }
  return try Spawner.run(
    path: path, arguments: arguments, environment: ProcessInfo.processInfo.environment.map { "\($0.key)=\($0.value)" })
}

/// Why the integration tests cannot run here, or nil.
let unavailable: String? = {
  if let reason = RootlesskitSandbox.unavailableReason() { return reason }
  for image in [TS, PRETTIER] {
    guard let run = try? host("docker", ["image", "inspect", "--format", "{{.Id}}", image]), run.succeeded else {
      return "docker or the image \(image) is not available (build it with sh scripts/build-images.sh)"
    }
  }
  guard Spawner.find("cc") != nil else { return "no cc to build the probe" }
  return nil
}()

let available = unavailable == nil

/// One cache for the whole run (and kept across runs: building an image folder takes seconds).
let testCacheRoot = FileManager.default.temporaryDirectory.appendingPathComponent("jig-rootlesskit-test-cache-\(getuid())")

func makeSandbox() -> RootlesskitSandbox {
  var options = RootlesskitSandbox.Options()
  options.cacheRoot = testCacheRoot
  return RootlesskitSandbox(options: options)
}

/// Shared by every test that does not clean up its sandbox.
let shared = makeSandbox()

/// The static probe, built once per run.
let probeBinary: Result<URL, TestFailure> = {
  let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rk-probe-\(UUID().uuidString)")
  do {
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let out = dir.appendingPathComponent("probe")
    let run = try host("cc", ["-static", "-O1", "-o", out.path, testsDir.appendingPathComponent("probe/probe.c").path])
    guard run.succeeded else { return .failure(TestFailure("cc failed: \(run.stderrText)")) }
    return .success(out)
  } catch {
    return .failure(TestFailure("\(error)"))
  }
}()

/// Copies the probe to `target` with `cp`, in a process of its own: a copy made here would hold a
/// writable descriptor that a process another test spawns at that moment could inherit, and the probe's
/// exec would then fail with ETXTBSY ("Text file busy").
func installProbe(at target: URL) throws {
  let run = try host("cp", [try probeBinary.get().path, target.path])
  guard run.succeeded else { throw TestFailure("cp of the probe failed: \(run.stderrText)") }
}

/// A fresh folder, removed by `cleanup()`.
final class TempDirs: @unchecked Sendable {
  private var dirs: [URL] = []

  func make() throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rk-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    dirs.append(dir)
    return dir
  }

  /// A copy of packages/test-utils/fixtures/<name>.
  func fixture(_ name: String) throws -> URL {
    let dir = try make().appendingPathComponent("ws")
    try FileManager.default.copyItem(at: repoRoot.appendingPathComponent("packages/test-utils/fixtures/\(name)"), to: dir)
    return dir
  }

  /// A workspace holding only the probe.
  func probeWorkspace() throws -> URL {
    let dir = try make().appendingPathComponent("ws")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try installProbe(at: dir.appendingPathComponent("probe"))
    return dir
  }

  deinit {
    for dir in dirs { RootfsCache.forceRemove(dir) }
  }
}

/// Runs the probe in the sandbox (typescript image's root) with `checks`; returns `label → result`.
func probe(_ checks: [String], sandbox: RootlesskitSandbox = shared, workspace: URL? = nil) throws -> [String: String] {
  let temp = TempDirs()
  let ws = try workspace ?? temp.probeWorkspace()
  if workspace != nil, !FileManager.default.fileExists(atPath: ws.appendingPathComponent("probe").path) {
    try installProbe(at: ws.appendingPathComponent("probe"))
  }
  let image = try sandbox.resolve(TS)
  let result = try sandbox.run(image, command: ["/workspace/probe"] + checks, workspace: ws)
  guard result.termination == .exited(0) else {
    throw TestFailure("probe ended with \(result.termination): \(String(decoding: result.stderr, as: UTF8.self))")
  }
  var answers: [String: String] = [:]
  for line in String(decoding: result.stdout, as: UTF8.self).split(separator: "\n") {
    guard let sep = line.range(of: ": ") else { continue }
    let key = String(line[..<sep.lowerBound])
    let value = String(line[sep.upperBound...])
    answers[key] = answers[key].map { $0 + "\n" + value } ?? value
  }
  return answers
}

/// `docker run` as sandbox+docker does it, for parity.
func dockerRun(_ image: String, _ args: [String], workspace: URL) throws -> ChildOutput {
  try host(
    "docker",
    ["run", "--rm", "--network", "none", "--read-only", "--tmpfs", "/tmp", "-v", "\(workspace.path):/workspace", "-w", "/workspace", image]
      + args)
}

/// Every file under `dir` (relative path → bytes), the probe excluded.
func readTree(_ dir: URL) throws -> [String: Data] {
  var tree: [String: Data] = [:]
  let base = dir.standardizedFileURL.path
  guard let walker = FileManager.default.enumerator(atPath: base) else { return tree }
  while let rel = walker.nextObject() as? String {
    let path = base + "/" + rel
    var st = stat()
    guard lstat(path, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, rel != "probe" else { continue }
    tree[rel] = try Data(contentsOf: URL(fileURLWithPath: path))
  }
  return tree
}

/// Owners (uid, gid) of every entry under `dir`, the folder itself included.
func owners(_ dir: URL) -> Set<String> {
  var result: Set<String> = []
  let base = dir.standardizedFileURL.path
  var st = stat()
  if lstat(base, &st) == 0 { result.insert("\(st.st_uid):\(st.st_gid)") }
  let walker = FileManager.default.enumerator(atPath: base)
  while let rel = walker?.nextObject() as? String {
    if lstat(base + "/" + rel, &st) == 0 { result.insert("\(st.st_uid):\(st.st_gid)") }
  }
  return result
}

// MARK: - Processes on the host

struct HostProcess {
  var pid: pid_t
  var ppid: pid_t
  var argv: [String]
}

func hostProcesses() -> [HostProcess] {
  guard let names = try? FileManager.default.contentsOfDirectory(atPath: "/proc") else { return [] }
  var result: [HostProcess] = []
  for name in names {
    guard let pid = pid_t(name),
      let cmdline = try? Data(contentsOf: URL(fileURLWithPath: "/proc/\(name)/cmdline")), !cmdline.isEmpty,
      let stat = try? String(contentsOfFile: "/proc/\(name)/stat", encoding: .utf8),
      let close = stat.lastIndex(of: ")")
    else { continue }
    let fields = stat[stat.index(after: close)...].split(separator: " ")
    let ppid = fields.count > 1 ? pid_t(fields[1]) ?? 0 : 0
    let argv = cmdline.split(separator: 0, omittingEmptySubsequences: false).dropLast().map { String(decoding: $0, as: UTF8.self) }
    result.append(HostProcess(pid: pid, ppid: ppid, argv: argv))
  }
  return result
}

/// Processes whose argv mentions `token`.
func processes(mentioning token: String) -> [HostProcess] {
  hostProcesses().filter { $0.argv.contains { $0.contains(token) } }
}

/// Polls `condition` every 50 ms for up to `seconds`.
func waitUntil(_ seconds: Double, _ condition: () -> Bool) -> Bool {
  let deadline = Date().addingTimeInterval(seconds)
  while Date() < deadline {
    if condition() { return true }
    usleep(50_000)
  }
  return condition()
}

/// The built `rootlesskit-sandbox-run`, next to the test bundle.
func runTool() throws -> URL {
  guard let me = realPath("/proc/self/exe") else { throw TestFailure("no /proc/self/exe") }
  var dir = URL(fileURLWithPath: me).deletingLastPathComponent()
  for _ in 0..<4 {
    let candidate = dir.appendingPathComponent("rootlesskit-sandbox-run")
    if FileManager.default.isExecutableFile(atPath: candidate.path) { return candidate }
    dir = dir.deletingLastPathComponent()
  }
  throw TestFailure("rootlesskit-sandbox-run not found near \(me)")
}
