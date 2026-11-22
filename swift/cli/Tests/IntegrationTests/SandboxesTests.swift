// The other sandbox end to end: `--sandbox rootlesskit` gives the same commits as docker and leaves
// nothing behind when interrupted.
import Foundation
import Testing

#if canImport(Glibc)
  import Glibc
#endif

// MARK: - rootlesskit

/// Whether the rootlesskit sandbox can run here (`/usr/bin/rootlesskit`, the path its AppArmor
/// exception is for; it also needs docker, for the images).
let rootlesskitAvailable = access("/usr/bin/rootlesskit", X_OK) == 0 && dockerAvailable

let rootlesskitMissing: Comment =
  "rootlesskit (/usr/bin/rootlesskit) or docker is not available: the rootlesskit end-to-end tests need both"

/// What two runs of the same action must agree on, whatever the sandbox: everything but the commit IDs.
struct Agreed: Equatable {
  var image: String
  var args: [String]
  var kind: String
  var subject: String
  var summary: String
  var filesChanged: [String]

  init(_ s: Success) {
    image = s.image
    args = s.args
    kind = s.kind
    subject = s.subject
    summary = s.summary
    filesChanged = s.filesChanged
  }
}

/// The `/tmp/jig-<uuid>/workspace` a running process of the binary names in its argv (the
/// rootlesskit launcher and the sandbox init carry the workspace path).
func workspaceNamed(by processes: [RunningProcess]) -> String? {
  for process in processes {
    if let path = process.argv.first(where: { $0.hasSuffix("/workspace") && $0.contains("/jig-") }) {
      return path
    }
  }
  return nil
}

@Suite("jig (rootlesskit)", .serialized, .enabled(if: rootlesskitAvailable, rootlesskitMissing), .builtOnce)
struct RootlesskitTests {
  let temp = TempDirs()

  /// Runs `image` with `args` on two copies of the same repo, with docker and with rootlesskit; both
  /// must give the same tree, the same report and the same commit message. Then the docker commit is
  /// replayed on its parent with rootlesskit, which gives the same tree.
  func sameAsDocker(image: String, args: [String], prepare: (URL) throws -> Void = { _ in }) throws -> Success {
    let viaDocker = try temp.repo()
    let viaRootlesskit = try temp.repo()
    try prepare(viaDocker)
    try prepare(viaRootlesskit)
    let docker = try runImage(repo: viaDocker, image: image, args: args)
    let rootlesskit = try runImage(repo: viaRootlesskit, image: image, args: args, sandbox: "rootlesskit")

    #expect(try treeOf(viaRootlesskit, rootlesskit.commit) == (try treeOf(viaDocker, docker.commit)))
    #expect(Agreed(rootlesskit) == Agreed(docker))
    let dockerBody = try git(viaDocker, ["log", "-1", "--format=%B"])
    let rootlesskitBody = try git(viaRootlesskit, ["log", "-1", "--format=%B"])
    #expect(rootlesskitBody == dockerBody)
    #expect(try status(viaRootlesskit) == "")

    // A commit made with docker replays with rootlesskit: the pinned image is the same string.
    let recorded = try #require(parseRefactorCommand(dockerBody))
    try git(viaDocker, ["checkout", "-q", "--detach", docker.parent])
    let replay = try runImage(repo: viaDocker, image: recorded.image, args: recorded.args, sandbox: "rootlesskit")
    #expect(replay.image == recorded.image)
    #expect(try treeOf(viaDocker, replay.commit) == (try treeOf(viaDocker, docker.commit)))
    #expect(Agreed(replay) == Agreed(docker))
    return rootlesskit
  }

  @Test("typescript rename: the same tree, commit message and report as docker", .timeLimit(.minutes(3)))
  func typescriptRename() throws {
    let result = try sameAsDocker(image: TS, args: RENAME)
    #expect(result.kind == "refactor")
    #expect(result.subject == "refactor(rename): foo → bar in a.ts")
  }

  @Test("prettier format: the same tree, commit message and report as docker", .timeLimit(.minutes(3)))
  func prettierFormat() throws {
    let result = try sameAsDocker(image: PRETTIER, args: ["format", "--files", "ugly.ts"]) { dir in
      try commitFile(dir, "ugly.ts", "const   x = {a:1}\n")
    }
    #expect(result.kind == "sweep")
    #expect(result.filesChanged == ["ugly.ts"])
  }

  @Test(
    "SIGTERM and SIGINT while the image keeps writing files: no process, run folder or temp folder left",
    .timeLimit(.minutes(5)))
  func interruptedWhileWriting() throws {
    let tmp = fm.temporaryDirectory.path
    for (sig, name) in [(SIGTERM, "SIGTERM"), (SIGINT, "SIGINT")] {
      let dir = try temp.repo()
      let before = try headCommit(dir)
      let token = "spew-\(UUID().uuidString)"
      let started = try startCommand([try setup(), "--repo", dir.path, "--sandbox", "rootlesskit", PROBE, "spew", token])
      var workspace: String?
      let writing = poll(seconds: 120) {
        workspace = workspaceNamed(by: runningProcesses().filter { $0.argv.contains(token) })
        guard let workspace else { return false }
        return fm.fileExists(atPath: workspace + "/d0")
      }
      #expect(writing, "the image was never seen writing")
      let folder = try #require(workspace.map { URL(fileURLWithPath: $0).deletingLastPathComponent() })
      sleep(2)
      kill(started.pid, sig)
      let finished = try started.wait(timeout: 60)

      #expect(finished.exitCode == 128 + sig)
      let output = try onlyOutput(finished)
      #expect(output.code == "INTERNAL")
      #expect(
        output.instructions?.hasPrefix(
          "interrupted by \(name) before the repository was changed; the sandbox and temporary files were removed.")
          == true, "\(output.instructions ?? "")\n\(finished.stderrText)")
      // Every process of the run is gone (the sandbox's PID namespace went with rootlesskit).
      let gone = poll(seconds: 3) { runningProcesses().allSatisfy { !$0.argv.contains(token) } }
      #expect(gone, "left running: \(runningProcesses().filter { $0.argv.contains(token) }.map(\.argv))")
      #expect(!fm.fileExists(atPath: folder.path), "left: \(folder.path)\n\(finished.stderrText)")
      if fm.fileExists(atPath: folder.path) { removeTree(folder) }
      // The sandbox's run folder (status file, rootlesskit's state) is gone too.
      let runFolders = ((try? fm.contentsOfDirectory(atPath: tmp)) ?? []).filter { $0.hasPrefix("rcrk-\(started.pid)-") }
      #expect(runFolders.isEmpty, "left: \(runFolders)")
      #expect(try headCommit(dir) == before)
      #expect(try status(dir) == "")
    }
  }

  @Test(
    "SIGTERM and SIGINT during the first export of an image: the export container is removed, also when the daemon creates it late",
    .timeLimit(.minutes(8)))
  func interruptedDuringTheExport() throws {
    let fake = try fakeDocker(temp)
    for (sig, name) in [(SIGTERM, "SIGTERM"), (SIGINT, "SIGINT")] {
      let dir = try temp.repo()
      let before = try headCommit(dir)
      let mark = try temp.make("fake-docker-mark-").appendingPathComponent("name")
      // A cache of its own, so this run exports the image; `docker create`'s container appears 2 s after
      // the client started, whether or not the client is still there.
      let cache = try temp.make("rk-cache-")
      let env = environment(
        pathFirst: fake.dir, ["FAKE_DOCKER_CREATE": "late", "FAKE_DOCKER_MARK": mark.path, "XDG_CACHE_HOME": cache.path])
      let started = try startCommand(
        [try setup(), "--repo", dir.path, "--sandbox", "rootlesskit", PROBE, "write", "fresh.txt"], environment: env)
      let creating = poll(seconds: 150) {
        ((try? readText(mark)) ?? "").hasSuffix("\n") || (kill(started.pid, 0) != 0 && errno == ESRCH)
      }
      guard creating, ((try? readText(mark)) ?? "").hasSuffix("\n") else {
        let finished = try started.wait(timeout: 10)
        Issue.record("docker create never started (exit \(finished.exitCode)): \(finished.stdoutText)\n\(finished.stderrText)")
        return
      }
      let container = try readText(mark).trimmingCharacters(in: .whitespacesAndNewlines)
      #expect(container.hasPrefix("jig-export-"))
      kill(started.pid, sig)
      let finished = try started.wait(timeout: 60)
      // Look once the late `docker create` has ended (two seconds after the mark, plus docker's time).
      let created = URL(fileURLWithPath: mark.path + ".created")
      #expect(poll(seconds: 60) { fm.fileExists(atPath: created.path) }, "the late docker create never ended")
      let listed = try runCommand(["docker", "ps", "-aq", "--filter", "name=^/\(container)$"]).stdoutText
      let left = !listed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      _ = try? runCommand(["docker", "rm", "-f", container])

      #expect(finished.exitCode == 128 + sig)
      let output = try onlyOutput(finished)
      #expect(output.code == "INTERNAL")
      let instructions = output.instructions ?? ""
      if left {
        // Never claimed gone: the cleanup names what it could not remove.
        #expect(instructions.contains("the container \(container) (remove it: docker rm -f \(container))"), "\(instructions)")
      } else {
        #expect(
          instructions.hasPrefix(
            "interrupted by \(name) before the repository was changed; the sandbox and temporary files were removed."),
          "\(instructions)\n\(finished.stderrText)")
      }
      #expect(!left, "the export container \(container) was left\n\(finished.stderrText)")
      // The half-built image folder is gone too, and nothing was cached.
      let rootfs = cache.appendingPathComponent("jig/rootfs")
      #expect(((try? fm.contentsOfDirectory(atPath: rootfs.path)) ?? []).isEmpty)
      #expect(try headCommit(dir) == before)
      #expect(try status(dir) == "")
    }
  }
}
