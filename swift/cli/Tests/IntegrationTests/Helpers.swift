// Helpers for the end-to-end tests: they build the images, the probe image and the static binary once
// per test run, make throwaway repos from the fixtures in packages/test-utils/fixtures and the example
// repos in examples/, and run the
// binary, git and docker. Every process gets an argument array, never a shell command line.
import Dispatch
import Foundation
import Testing

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

struct TestFailure: Error, CustomStringConvertible {
  var description: String
  init(_ description: String) { self.description = description }
}

/// The repository root: this file is `swift/cli/Tests/IntegrationTests/Helpers.swift`.
let repoRoot: URL = URL(fileURLWithPath: #filePath)
  .deletingLastPathComponent()
  .deletingLastPathComponent()
  .deletingLastPathComponent()
  .deletingLastPathComponent()
  .deletingLastPathComponent()

let TS = "localhost/jig/typescript:local"
let PRETTIER = "localhost/jig/prettier:local"
let PROBE = "localhost/jig/probe:local"
let RENAME = ["typescript-rename", "--file", "a.ts", "--symbol", "foo", "--to", "bar"]

// MARK: - Processes

/// What a finished process left.
struct Finished {
  var exitCode: Int32
  var stdout: Data
  var stderr: Data
  var stdoutText: String { String(decoding: stdout, as: UTF8.self) }
  var stderrText: String { String(decoding: stderr, as: UTF8.self) }
}

private final class DataBox: @unchecked Sendable {
  var data = Data()
}

private final class StatusBox: @unchecked Sendable {
  var status: Int32 = 0
}

private let spawnLock = NSLock()

/// How long to wait for the pipes to close after the process group was killed.
let killGrace = 5.0

/// `name` itself when it holds a slash, else the first executable `name` on PATH.
private func executable(_ name: String) throws -> URL {
  if name.contains("/") { return URL(fileURLWithPath: name) }
  let path = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/local/bin:/usr/bin:/bin"
  for dir in path.split(separator: ":") where !dir.isEmpty {
    let candidate = URL(fileURLWithPath: String(dir)).appendingPathComponent(name)
    if FileManager.default.isExecutableFile(atPath: candidate.path) { return candidate }
  }
  throw TestFailure("\(name) not found on PATH")
}

/// Reads `fd` to its end on a thread of its own, then closes it.
private func drain(_ fd: Int32, into box: DataBox, _ group: DispatchGroup) {
  group.enter()
  Thread.detachNewThread {
    var buffer = [UInt8](repeating: 0, count: 65536)
    while true {
      let n = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
      if n > 0 {
        box.data.append(contentsOf: buffer[0..<n])
      } else if n < 0 && errno == EINTR {
        continue
      } else {
        break
      }
    }
    close(fd)
    group.leave()
  }
}

/// Runs `argv` (no shell, no stdin) in a process group of its own and waits for it, whatever its exit
/// code. It must be done, and its output pipes closed, within `timeout` seconds; otherwise the whole
/// process group is killed (children and grandchildren that inherited the pipes included), and after a
/// short grace period it throws, even if something still holds the pipes open.
func runCommand(
  _ argv: [String], cwd: URL? = nil, environment: [String: String]? = nil, timeout: Double = 120
) throws -> Finished {
  try startCommand(argv, cwd: cwd, environment: environment).wait(timeout: timeout)
}

/// A command started by `startCommand`, running in a process group of its own (its ID is `pid`).
struct Started {
  var argv: [String]
  var pid: pid_t
  fileprivate var pipes: DispatchGroup
  fileprivate var out: DataBox
  fileprivate var err: DataBox
  fileprivate var exited: DispatchSemaphore
  fileprivate var status: StatusBox

  /// Waits as `runCommand` does.
  func wait(timeout: Double = 120) throws -> Finished {
    let deadline = DispatchTime.now() + timeout
    if exited.wait(timeout: deadline) == .timedOut || pipes.wait(timeout: deadline) == .timedOut {
      kill(-pid, SIGKILL)
      // After the kill the pipes close, unless something outside the group holds them: then give up on
      // them (the reader threads are abandoned) rather than wait forever.
      _ = pipes.wait(timeout: .now() + killGrace)
      _ = exited.wait(timeout: .now() + killGrace)
      throw TestFailure("\(argv.joined(separator: " ")) did not finish within \(timeout)s; its process group was killed")
    }
    // Exit code, or 128 + signal number as a shell reports it.
    let raw = status.status
    let exitCode = raw & 0x7f == 0 ? (raw >> 8) & 0xff : 128 + (raw & 0x7f)
    return Finished(exitCode: exitCode, stdout: out.data, stderr: err.data)
  }
}

/// Starts `argv` (no shell, no stdin) in a process group of its own; `environment` replaces ours.
func startCommand(_ argv: [String], cwd: URL? = nil, environment: [String: String]? = nil) throws -> Started {
  let path = try executable(argv[0]).path

  // A process spawned at the same time by another thread must not inherit these pipes: they are
  // close-on-exec, and made and handed to the child under `spawnLock` (every spawn here goes through it).
  spawnLock.lock()
  var outFds: [Int32] = [-1, -1]
  var errFds: [Int32] = [-1, -1]
  guard pipe(&outFds) == 0, pipe(&errFds) == 0 else {
    spawnLock.unlock()
    throw TestFailure("pipe failed: errno \(errno)")
  }
  for fd in outFds + errFds { _ = fcntl(fd, F_SETFD, FD_CLOEXEC) }

  var actions = posix_spawn_file_actions_t()
  posix_spawn_file_actions_init(&actions)
  defer { posix_spawn_file_actions_destroy(&actions) }
  posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
  posix_spawn_file_actions_adddup2(&actions, outFds[1], 1)
  posix_spawn_file_actions_adddup2(&actions, errFds[1], 2)
  if let cwd { posix_spawn_file_actions_addchdir_np(&actions, cwd.path) }

  var attributes = posix_spawnattr_t()
  posix_spawnattr_init(&attributes)
  defer { posix_spawnattr_destroy(&attributes) }
  posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP))
  posix_spawnattr_setpgroup(&attributes, 0)  // a new group, whose ID is the child's PID

  let cArgs: [UnsafeMutablePointer<CChar>?] = argv.map { strdup($0) } + [nil]
  defer { for arg in cArgs { free(arg) } }
  let cEnv: [UnsafeMutablePointer<CChar>?]? = environment.map { $0.map { strdup("\($0.key)=\($0.value)") } + [nil] }
  defer { for item in cEnv ?? [] { free(item) } }
  var pid: pid_t = 0
  let spawned =
    cEnv.map { env in posix_spawn(&pid, path, &actions, &attributes, cArgs, env) }
    ?? posix_spawn(&pid, path, &actions, &attributes, cArgs, environ)
  close(outFds[1])
  close(errFds[1])
  spawnLock.unlock()
  guard spawned == 0 else {
    close(outFds[0])
    close(errFds[0])
    throw TestFailure("could not start \(argv[0]): errno \(spawned)")
  }

  // Read both pipes at the same time, so a full pipe never blocks the child, and reap the child.
  let pipes = DispatchGroup()
  let out = DataBox()
  let err = DataBox()
  drain(outFds[0], into: out, pipes)
  drain(errFds[0], into: err, pipes)
  let exited = DispatchSemaphore(value: 0)
  let status = StatusBox()
  let child = pid
  Thread.detachNewThread {
    var raw: Int32 = 0
    while waitpid(child, &raw, 0) < 0 && errno == EINTR {}
    status.status = raw
    exited.signal()
  }

  return Started(argv: argv, pid: pid, pipes: pipes, out: out, err: err, exited: exited, status: status)
}

/// Runs `sh scripts/<name> <args...>` (at most 30 minutes); returns its stdout.
private func script(_ name: String, _ args: [String] = []) throws -> String {
  let path = repoRoot.appendingPathComponent("scripts").appendingPathComponent(name).path
  let run = try runCommand(["sh", path] + args, timeout: 1800)
  guard run.exitCode == 0 else {
    let tail = run.stderrText.split(separator: "\n", omittingEmptySubsequences: false).suffix(30)
    throw TestFailure("\(name) failed (exit \(run.exitCode)):\n\(tail.joined(separator: "\n"))")
  }
  return run.stdoutText
}

// MARK: - One-time setup

/// Whether docker answers. The suites are skipped, not failed, when it does not.
let dockerAvailable: Bool = (try? runCommand(["docker", "info"], timeout: 30))?.exitCode == 0

let dockerMissing: Comment = "docker is not available (`docker info` failed): the end-to-end tests need it"

/// Builds the action images, the probe image and the binary; returns the binary's path.
private func buildAll() throws -> String {
  _ = try script("build-images.sh", ["typescript", "prettier"])
  let probe = repoRoot.appendingPathComponent("swift/cli/Tests/IntegrationTests/probe").path
  let build = try runCommand(["docker", "build", "-f", probe + "/Containerfile", "-t", PROBE, probe], timeout: 1800)
  guard build.exitCode == 0 else {
    throw TestFailure("docker build of the probe failed (exit \(build.exitCode)):\n\(build.stderrText)")
  }
  return try binaryBuilt.get()
}

/// The static binary (scripts/build-binary.sh), built once per run.
private let binaryBuilt: Result<String, any Error> = Result {
  let lines = try script("build-binary.sh").split(separator: "\n")
  guard let path = lines.last, !path.isEmpty else { throw TestFailure("build-binary.sh printed no path") }
  return String(path)
}

/// Global lets are initialized once, on first use, and every other caller waits for it.
private let built: Result<String, any Error> = Result { try buildAll() }

/// Builds everything once per test run; returns the binary's path.
@discardableResult
func setup() throws -> String { try built.get() }

/// Runs `setup()` once before a suite's tests, outside their per-test time limits (a non-recursive
/// suite scope is not counted against a test's `.timeLimit`).
struct BuiltOnce: SuiteTrait, TestScoping {
  var isRecursive: Bool { false }

  func provideScope(
    for test: Test, testCase: Test.Case?, performing function: @Sendable () async throws -> Void
  ) async throws {
    try setup()
    try await function()
  }
}

extension Trait where Self == BuiltOnce {
  static var builtOnce: Self { BuiltOnce() }
}

// MARK: - Files and repos

let fm = FileManager.default

func isDirectory(_ path: String) -> Bool {
  (try? fm.attributesOfItem(atPath: path))?[.type] as? FileAttributeType == .typeDirectory
}

/// Removes `url`, first making every folder under it writable and searchable again.
func removeTree(_ url: URL) {
  func open(_ path: String) {
    guard isDirectory(path) else { return }
    try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path)
    for name in (try? fm.contentsOfDirectory(atPath: path)) ?? [] { open(path + "/" + name) }
  }
  open(url.path)
  try? fm.removeItem(at: url)
}

func makeTempDir(_ prefix: String) throws -> URL {
  let dir = fm.temporaryDirectory.appendingPathComponent(prefix + UUID().uuidString)
  try fm.createDirectory(at: dir, withIntermediateDirectories: false)
  return dir
}

func readText(_ url: URL) throws -> String {
  String(decoding: try Data(contentsOf: url), as: UTF8.self)
}

func write(_ url: URL, _ text: String) throws {
  try Data(text.utf8).write(to: url)
}

func permissions(_ url: URL) throws -> Int {
  (try fm.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)?.intValue ?? 0
}

func chmod(_ url: URL, _ mode: Int) throws {
  try fm.setAttributes([.posixPermissions: mode], ofItemAtPath: url.path)
}

/// Every regular file under `dir` (symlinks not followed, the top-level `.git` left out), as UTF-8 text.
func readTree(_ dir: URL) throws -> [String: String] {
  var out: [String: String] = [:]
  func walk(_ rel: String) throws {
    let full = rel.isEmpty ? dir.path : dir.path + "/" + rel
    for name in try fm.contentsOfDirectory(atPath: full) {
      let path = rel.isEmpty ? name : rel + "/" + name
      if path == ".git" { continue }
      let type = try fm.attributesOfItem(atPath: full + "/" + name)[.type] as? FileAttributeType
      if type == .typeDirectory {
        try walk(path)
      } else if type == .typeRegular {
        out[path] = try readText(dir.appendingPathComponent(path))
      }
    }
  }
  try walk("")
  return out
}

/// Temporary folders of one test, removed when the test's suite instance goes away.
final class TempDirs {
  private var dirs: [URL] = []

  deinit {
    for dir in dirs { removeTree(dir) }
  }

  /// An empty temporary folder.
  func make(_ prefix: String) throws -> URL {
    let dir = try makeTempDir(prefix)
    dirs.append(dir)
    return dir
  }

  /// A git repo holding a copy of `packages/test-utils/fixtures/<name>`, or of the example repo
  /// `examples/<name>` when `name` starts with `examples/`, with one commit "init".
  func fixture(_ name: String) throws -> URL {
    let dir = try make("jig-")
    let source =
      name.hasPrefix("examples/")
      ? repoRoot.appendingPathComponent(name)
      : repoRoot.appendingPathComponent("packages/test-utils/fixtures").appendingPathComponent(name)
    for entry in try fm.contentsOfDirectory(atPath: source.path) {
      try fm.copyItem(at: source.appendingPathComponent(entry), to: dir.appendingPathComponent(entry))
    }
    try git(dir, ["init", "-q", "-b", "main"])
    try git(dir, ["config", "user.name", "Test"])
    try git(dir, ["config", "user.email", "test@example.com"])
    try git(dir, ["config", "commit.gpgsign", "false"])
    try git(dir, ["add", "-A"])
    try git(dir, ["commit", "-q", "-m", "init"])
    return dir
  }

  /// The simple fixture, plus an ignored `node_modules/x.txt` that must stay out of the container.
  func repo() throws -> URL {
    let dir = try fixture("simple")
    try fm.createDirectory(at: dir.appendingPathComponent("node_modules"), withIntermediateDirectories: false)
    try write(dir.appendingPathComponent("node_modules/x.txt"), "ignored\n")
    return dir
  }
}

// MARK: - Git

@discardableResult
func git(_ dir: URL, _ args: [String]) throws -> String {
  let run = try runCommand(["git"] + args, cwd: dir)
  guard run.exitCode == 0 else {
    throw TestFailure(
      "git \(args.joined(separator: " ")) failed (exit \(run.exitCode)): "
        + run.stderrText.trimmingCharacters(in: .whitespacesAndNewlines))
  }
  return run.stdoutText
}

func headCommit(_ dir: URL) throws -> String {
  try git(dir, ["rev-parse", "HEAD"]).trimmingCharacters(in: .whitespacesAndNewlines)
}

func status(_ dir: URL) throws -> String {
  try git(dir, ["status", "--porcelain"])
}

func treeOf(_ dir: URL, _ rev: String = "HEAD") throws -> String {
  try git(dir, ["rev-parse", "\(rev)^{tree}"]).trimmingCharacters(in: .whitespacesAndNewlines)
}

func commitFile(_ dir: URL, _ path: String, _ text: String, mode: Int? = nil) throws {
  let url = dir.appendingPathComponent(path)
  try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
  try write(url, text)
  if let mode { try chmod(url, mode) }
  try git(dir, ["add", path])
  try git(dir, ["commit", "-q", "-m", "add \(path)"])
}

// MARK: - JSON

/// Any JSON value, compared structurally.
enum JSON: Equatable, Decodable, ExpressibleByBooleanLiteral, ExpressibleByStringLiteral,
  ExpressibleByIntegerLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral
{
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSON])
  case object([String: JSON])

  init(booleanLiteral value: Bool) { self = .bool(value) }
  init(stringLiteral value: String) { self = .string(value) }
  init(integerLiteral value: Int) { self = .number(Double(value)) }
  init(arrayLiteral elements: JSON...) { self = .array(elements) }
  init(dictionaryLiteral elements: (String, JSON)...) {
    self = .object(Dictionary(uniqueKeysWithValues: elements))
  }

  init(from decoder: any Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let value = try? c.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? c.decode(Double.self) {
      self = .number(value)
    } else if let value = try? c.decode(String.self) {
      self = .string(value)
    } else if let value = try? c.decode([JSON].self) {
      self = .array(value)
    } else {
      self = .object(try c.decode([String: JSON].self))
    }
  }

  subscript(key: String) -> JSON? {
    if case .object(let fields) = self { return fields[key] }
    return nil
  }

  subscript(index: Int) -> JSON? {
    if case .array(let items) = self, items.indices.contains(index) { return items[index] }
    return nil
  }
}

func decode<T: Decodable>(_ type: T.Type, _ text: String) throws -> T {
  try JSONDecoder().decode(type, from: Data(text.utf8))
}

// MARK: - The binary

/// The binary's failure: `{"schema","ok":false,"code","instructions"}`.
struct Failure {
  var code: String
  var instructions: String
}

/// The binary's one JSON object (output v1): a success or a failure.
struct Output: Decodable {
  var schema: String
  var ok: Bool
  var commit: String?
  var parent: String?
  var image: String?
  var args: [String]?
  var kind: String?
  var subject: String?
  var summary: String?
  var filesChanged: [String]?
  var notes: [String]?
  var code: String?
  var instructions: String?

  var failure: Failure? {
    guard !ok, let code, let instructions else { return nil }
    return Failure(code: code, instructions: instructions)
  }
}

struct Success {
  var commit: String
  var parent: String
  var image: String
  var args: [String]
  var kind: String
  var subject: String
  var summary: String
  var filesChanged: [String]
  /// The output's `notes` (a cached tag used while the registry was unreachable), nil when absent.
  var notes: [String]? = nil
}

struct Ran {
  var exitCode: Int32
  var output: Output
  var stdout: String
  var stderr: String
}

/// Runs the binary; its stdout must be exactly one JSON object on one line. `environment` replaces ours.
func run(_ argv: [String], environment: [String: String]? = nil) throws -> Ran {
  let finished = try runCommand([try setup()] + argv, environment: environment)
  let stdout = finished.stdoutText
  #expect(
    stdout.hasSuffix("\n") && stdout.firstIndex(of: "\n") == stdout.index(before: stdout.endIndex),
    "exit \(finished.exitCode), stdout: \(stdout), stderr: \(finished.stderrText)")
  let output = try decode(Output.self, stdout)
  #expect(output.schema == "urn:jig:output:1")
  #expect(finished.exitCode == (output.ok ? 0 : 1))
  return Ran(exitCode: finished.exitCode, output: output, stdout: stdout, stderr: finished.stderrText)
}

/// `jig --repo <dir> [--message <message>] [--sandbox <sandbox>] <image> <args...>`, expected
/// to succeed. `environment` replaces ours.
func runImage(
  repo: URL, image: String, args: [String], message: String? = nil, sandbox: String? = nil,
  environment: [String: String]? = nil
) throws -> Success {
  let ran = try run(
    ["--repo", repo.path] + (message.map { ["--message", $0] } ?? []) + (sandbox.map { ["--sandbox", $0] } ?? [])
      + [image] + args, environment: environment)
  let o = ran.output
  guard o.ok, let commit = o.commit, let parent = o.parent, let image = o.image, let args = o.args,
    let kind = o.kind, let subject = o.subject, let summary = o.summary, let filesChanged = o.filesChanged
  else {
    throw TestFailure("expected success, got \(ran.stdout)\n\(ran.stderr)")
  }
  return Success(
    commit: commit, parent: parent, image: image, args: args, kind: kind, subject: subject, summary: summary,
    filesChanged: filesChanged, notes: o.notes)
}

/// The same, expected to fail; returns the failure.
func failImage(repo: URL, image: String, args: [String]) throws -> Failure {
  let ran = try run(["--repo", repo.path, image] + args)
  guard let failure = ran.output.failure else {
    throw TestFailure("expected failure, got \(ran.stdout)")
  }
  return failure
}

/// The value of the last `<name>: ` trailer line of a commit message, or nil.
func trailer(_ name: String, _ commitMessage: String) -> String? {
  let prefix = "\(name): "
  return commitMessage.split(separator: "\n", omittingEmptySubsequences: false)
    .last(where: { $0.hasPrefix(prefix) }).map { String($0.dropFirst(prefix.count)) }
}

struct RefactorCommand: Decodable, Equatable {
  var image: String
  var args: [String]
}

/// The command from the commit's `Refactor-Command` trailer (the last such line), or nil.
func parseRefactorCommand(_ commitMessage: String) -> RefactorCommand? {
  let trailer = "Refactor-Command: "
  guard
    let line = commitMessage.split(separator: "\n", omittingEmptySubsequences: false)
      .last(where: { $0.hasPrefix(trailer) })
  else { return nil }
  return try? decode(RefactorCommand.self, String(line.dropFirst(trailer.count)))
}

// MARK: - A local registry

/// The architecture name of this machine in image platforms.
#if arch(arm64)
  let hostArchitecture = "arm64"
  let otherArchitecture = "amd64"
#else
  let hostArchitecture = "amd64"
  let otherArchitecture = "arm64"
#endif

/// An HTTP answer.
struct HTTPAnswer {
  var status: Int
  var response: HTTPURLResponse
  var body: Data

  func header(_ name: String) -> String? { response.value(forHTTPHeaderField: name) }
  var text: String { String(decoding: body, as: UTF8.self) }
}

private final class AnswerBox: @unchecked Sendable {
  var data: Data?
  var response: URLResponse?
  var error: (any Error)?
}

/// Sends one HTTP request and waits for the answer (redirects followed); throws when nothing answers.
func http(
  _ method: String, _ url: URL, headers: [String: String] = [:], body: Data? = nil, timeout: Double = 120
) throws -> HTTPAnswer {
  var request = URLRequest(url: url, timeoutInterval: timeout)
  request.httpMethod = method
  for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
  request.httpBody = body
  let box = AnswerBox()
  let done = DispatchSemaphore(value: 0)
  let task = URLSession.shared.dataTask(with: request) { data, response, error in
    box.data = data
    box.response = response
    box.error = error
    done.signal()
  }
  task.resume()
  guard done.wait(timeout: .now() + timeout + 5) == .success else {
    task.cancel()
    throw TestFailure("\(method) \(url) did not answer within \(timeout)s")
  }
  if let error = box.error { throw TestFailure("\(method) \(url) failed: \(error)") }
  guard let response = box.response as? HTTPURLResponse else {
    throw TestFailure("\(method) \(url) gave no HTTP response")
  }
  return HTTPAnswer(status: response.statusCode, response: response, body: box.data ?? Data())
}

/// `sha256:<hex>` of `data` (by `sha256sum`: the tests do not depend on jig's own SHA-256).
func sha256Digest(_ data: Data) throws -> String {
  let file = fm.temporaryDirectory.appendingPathComponent("jig-sha256-" + UUID().uuidString)
  try data.write(to: file)
  defer { try? fm.removeItem(at: file) }
  let run = try runCommand(["sha256sum", file.path])
  guard run.exitCode == 0, let hex = run.stdoutText.split(separator: " ").first, hex.count == 64 else {
    throw TestFailure("sha256sum failed (exit \(run.exitCode)): \(run.stderrText)")
  }
  return "sha256:" + hex
}

/// A `registry:2` container listening on `127.0.0.1:<port>`, named `jig-test-registry-<uuid>`.
/// jig reaches it as `localhost:<port>/...` (a registry over plain HTTP).
final class TestRegistry {
  let container: String
  /// The host port; read again by `start()`, since Docker may give a restarted container another one.
  fileprivate(set) var port: Int

  /// The registry part of an image reference: `localhost:<port>`.
  var host: String { "localhost:\(port)" }
  /// Where the tests talk to it themselves.
  var base: URL { URL(string: "http://127.0.0.1:\(port)")! }

  fileprivate init(container: String, port: Int) {
    self.container = container
    self.port = port
  }

  /// Stops the container (the registry no longer answers; its content is kept).
  func stop() throws {
    let stopped = try runCommand(["docker", "stop", "-t", "1", container], timeout: 60)
    guard stopped.exitCode == 0 else {
      throw TestFailure("docker stop \(container) failed (exit \(stopped.exitCode)): \(stopped.stderrText)")
    }
  }

  /// Starts the stopped container again and waits until it answers.
  func start() throws {
    let started = try runCommand(["docker", "start", container], timeout: 60)
    guard started.exitCode == 0 else {
      throw TestFailure("docker start \(container) failed (exit \(started.exitCode)): \(started.stderrText)")
    }
    port = try publishedPort(container)
    try waitUntilAnswering(self)
  }

  /// Removes the container, whatever its state; errors are ignored.
  func remove() {
    _ = try? runCommand(["docker", "rm", "-f", "-v", container], timeout: 60)
  }

  deinit {
    remove()
  }
}

/// The host port `container`'s port 5000 is published on.
private func publishedPort(_ container: String) throws -> Int {
  let ran = try runCommand(["docker", "port", container, "5000/tcp"], timeout: 30)
  guard ran.exitCode == 0,
    let line = ran.stdoutText.split(separator: "\n").first,
    let colon = line.lastIndex(of: ":"),
    let port = Int(line[line.index(after: colon)...])
  else {
    throw TestFailure("docker port \(container) 5000/tcp gave no port (exit \(ran.exitCode)): \(ran.stdoutText)\(ran.stderrText)")
  }
  return port
}

/// Waits (at most 60 s) until `GET /v2/` answers 200.
private func waitUntilAnswering(_ registry: TestRegistry) throws {
  let url = registry.base.appendingPathComponent("v2/")
  let deadline = Date().addingTimeInterval(60)
  var last = "no answer"
  while Date() < deadline {
    do {
      let answer = try http("GET", url, timeout: 5)
      if answer.status == 200 { return }
      last = "status \(answer.status)"
    } catch {
      last = "\(error)"
    }
    usleep(200_000)
  }
  throw TestFailure("the test registry \(registry.container) never answered GET /v2/: \(last)")
}

/// Removes registry containers left by test processes that are gone (killed before their cleanup ran).
private func removeStaleRegistries() {
  guard
    let listed = try? runCommand(
      ["docker", "ps", "-a", "--filter", "label=jig-test-registry-pid", "--format", "{{.Names}} {{.Label \"jig-test-registry-pid\"}}"],
      timeout: 30)
  else { return }
  for line in listed.stdoutText.split(separator: "\n") {
    let parts = line.split(separator: " ")
    guard parts.count == 2, let pid = pid_t(parts[1]) else { continue }
    if kill(pid, 0) != 0 && errno == ESRCH {
      _ = try? runCommand(["docker", "rm", "-f", "-v", String(parts[0])], timeout: 60)
    }
  }
}

/// Starts a fresh `registry:2` container on `127.0.0.1:<random port>` and waits until it answers.
/// The caller removes it (`remove()`, also run when the object goes away).
func startTestRegistry() throws -> TestRegistry {
  removeStaleRegistries()
  let container = "jig-test-registry-" + UUID().uuidString.lowercased()
  let ran = try runCommand(
    [
      "docker", "run", "-d", "--name", container, "--label", "jig-test-registry-pid=\(getpid())",
      "-p", "127.0.0.1::5000", "registry:2",
    ], timeout: 300)
  guard ran.exitCode == 0 else {
    _ = try? runCommand(["docker", "rm", "-f", "-v", container], timeout: 60)
    throw TestFailure("docker run registry:2 failed (exit \(ran.exitCode)): \(ran.stderrText)")
  }
  // From here on the object owns the container: a throw below removes it with the object.
  let registry = TestRegistry(container: container, port: 0)
  registry.port = try publishedPort(container)
  try waitUntilAnswering(registry)
  return registry
}

/// A JSON object read from `data`.
private func jsonObject(_ data: Data, _ what: String) throws -> [String: Any] {
  guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    throw TestFailure("\(what) is not a JSON object")
  }
  return object
}

/// The blob file of `digest` in the OCI layout at `layout`.
private func layoutBlob(_ layout: URL, _ digest: String) throws -> URL {
  guard digest.hasPrefix("sha256:") else { throw TestFailure("unexpected digest \(digest)") }
  let file = layout.appendingPathComponent("blobs/sha256").appendingPathComponent(String(digest.dropFirst(7)))
  guard fm.fileExists(atPath: file.path) else { throw TestFailure("docker save wrote no blob \(digest)") }
  return file
}

/// The `linux/<host arch>` image manifest the descriptor leads to: the descriptor itself when it is a
/// manifest, else the matching entry of the index it names (indexes may nest: `docker save` with the
/// containerd image store writes `index.json` → the image's index → its platform manifests and their
/// attestations).
private func platformManifest(_ layout: URL, _ descriptor: [String: Any]) throws -> (digest: String, mediaType: String) {
  guard let digest = descriptor["digest"] as? String, let mediaType = descriptor["mediaType"] as? String else {
    throw TestFailure("a descriptor without digest or mediaType: \(descriptor)")
  }
  if mediaType == "application/vnd.oci.image.manifest.v1+json"
    || mediaType == "application/vnd.docker.distribution.manifest.v2+json"
  {
    return (digest, mediaType)
  }
  guard
    mediaType == "application/vnd.oci.image.index.v1+json"
      || mediaType == "application/vnd.docker.distribution.manifest.list.v2+json"
  else {
    throw TestFailure("unexpected media type \(mediaType) in docker save's layout")
  }
  let index = try jsonObject(try Data(contentsOf: try layoutBlob(layout, digest)), "index \(digest)")
  let entries = index["manifests"] as? [[String: Any]] ?? []
  for entry in entries {
    let platform = entry["platform"] as? [String: Any]
    let os = platform?["os"] as? String
    let architecture = platform?["architecture"] as? String
    // An entry without a platform is a nested index (or a lone manifest); an attestation is unknown/unknown.
    if platform == nil || (os == "linux" && architecture == hostArchitecture) {
      return try platformManifest(layout, entry)
    }
  }
  throw TestFailure("docker save's index \(digest) has no linux/\(hostArchitecture) manifest")
}

/// Pushes the blob `file` (whose digest is `digest`) into `repository`, unless the registry has it.
private func pushBlob(_ file: URL, _ digest: String, repository: String, registry: TestRegistry) throws {
  let existing = try http("HEAD", registry.base.appendingPathComponent("v2/\(repository)/blobs/\(digest)"))
  if existing.status == 200 { return }
  let upload = try http("POST", registry.base.appendingPathComponent("v2/\(repository)/blobs/uploads/"))
  guard upload.status == 202, let location = upload.header("Location"),
    let uploadURL = URL(string: location, relativeTo: registry.base)?.absoluteURL,
    var components = URLComponents(url: uploadURL, resolvingAgainstBaseURL: false)
  else {
    throw TestFailure("starting the upload of \(digest) failed: \(upload.status) \(upload.text)")
  }
  components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "digest", value: digest)]
  guard let putURL = components.url else { throw TestFailure("bad upload URL \(location)") }
  let put = try http(
    "PUT", putURL, headers: ["Content-Type": "application/octet-stream"], body: try Data(contentsOf: file))
  guard put.status == 201 else {
    throw TestFailure("uploading \(digest) failed: \(put.status) \(put.text)")
  }
}

/// Puts `data` (a manifest or an index of `mediaType`) under `reference` (a tag or its digest).
private func pushManifest(
  _ data: Data, mediaType: String, repository: String, reference: String, registry: TestRegistry
) throws {
  let put = try http(
    "PUT", registry.base.appendingPathComponent("v2/\(repository)/manifests/\(reference)"),
    headers: ["Content-Type": mediaType], body: data)
  guard put.status == 201 else {
    throw TestFailure("putting the manifest \(repository):\(reference) failed: \(put.status) \(put.text)")
  }
}

/// Pushes the local Docker image `localImage` to `registry` as `name` (`<repository>:<tag>`), over the
/// registry's HTTP API: the blobs and the `linux/<host arch>` manifest come from `docker save` (an OCI
/// layout). With `extraPlatform`, the tag gets an OCI index listing that manifest as
/// `linux/<host arch>` and an annotated copy of it as `linux/<other arch>`. Returns the digest the tag
/// now points to (the index's with `extraPlatform`, else the manifest's), `sha256:<hex>`.
@discardableResult
func pushToTestRegistry(
  _ localImage: String, as name: String, registry: TestRegistry, extraPlatform: Bool = false
) throws -> String {
  guard let colon = name.lastIndex(of: ":"), !name[colon...].contains("/") else {
    throw TestFailure("pushToTestRegistry needs <repository>:<tag>, got \(name)")
  }
  let repository = String(name[..<colon])
  let tag = String(name[name.index(after: colon)...])

  let work = try makeTempDir("jig-push-")
  defer { removeTree(work) }
  let archive = work.appendingPathComponent("image.tar")
  let saved = try runCommand(["docker", "save", "-o", archive.path, localImage], timeout: 600)
  guard saved.exitCode == 0 else {
    throw TestFailure("docker save \(localImage) failed (exit \(saved.exitCode)): \(saved.stderrText)")
  }
  let layout = work.appendingPathComponent("layout")
  try fm.createDirectory(at: layout, withIntermediateDirectories: false)
  let unpacked = try runCommand(["tar", "-xf", archive.path, "-C", layout.path], timeout: 600)
  guard unpacked.exitCode == 0 else {
    throw TestFailure("tar -xf of docker save's archive failed (exit \(unpacked.exitCode)): \(unpacked.stderrText)")
  }
  try? fm.removeItem(at: archive)

  let top = try jsonObject(try Data(contentsOf: layout.appendingPathComponent("index.json")), "index.json")
  guard let image = (top["manifests"] as? [[String: Any]])?.first else {
    throw TestFailure("docker save's index.json lists no image")
  }
  let manifest = try platformManifest(layout, image)
  let manifestData = try Data(contentsOf: try layoutBlob(layout, manifest.digest))
  let manifestObject = try jsonObject(manifestData, "manifest \(manifest.digest)")
  guard let config = (manifestObject["config"] as? [String: Any])?["digest"] as? String else {
    throw TestFailure("manifest \(manifest.digest) has no config")
  }
  let layers = (manifestObject["layers"] as? [[String: Any]] ?? []).compactMap { $0["digest"] as? String }

  for digest in [config] + layers {
    try pushBlob(try layoutBlob(layout, digest), digest, repository: repository, registry: registry)
  }
  guard extraPlatform else {
    try pushManifest(manifestData, mediaType: manifest.mediaType, repository: repository, reference: tag, registry: registry)
    return manifest.digest
  }

  try pushManifest(
    manifestData, mediaType: manifest.mediaType, repository: repository, reference: manifest.digest, registry: registry)
  // The other architecture's entry: the same image with an annotation, so its digest differs.
  var copyObject = manifestObject
  var annotations = manifestObject["annotations"] as? [String: Any] ?? [:]
  annotations["org.opencontainers.image.description"] = "jig test copy for linux/\(otherArchitecture)"
  copyObject["annotations"] = annotations
  let copyData = try JSONSerialization.data(withJSONObject: copyObject, options: [.sortedKeys, .withoutEscapingSlashes])
  let copyDigest = try sha256Digest(copyData)
  try pushManifest(copyData, mediaType: manifest.mediaType, repository: repository, reference: copyDigest, registry: registry)

  let index: [String: Any] = [
    "schemaVersion": 2,
    "mediaType": "application/vnd.oci.image.index.v1+json",
    "manifests": [
      [
        "mediaType": manifest.mediaType, "digest": manifest.digest, "size": manifestData.count,
        "platform": ["os": "linux", "architecture": hostArchitecture],
      ],
      [
        "mediaType": manifest.mediaType, "digest": copyDigest, "size": copyData.count,
        "platform": ["os": "linux", "architecture": otherArchitecture],
      ],
    ],
  ]
  let indexData = try JSONSerialization.data(withJSONObject: index, options: [.sortedKeys, .withoutEscapingSlashes])
  try pushManifest(
    indexData, mediaType: "application/vnd.oci.image.index.v1+json", repository: repository, reference: tag,
    registry: registry)
  return try sha256Digest(indexData)
}
