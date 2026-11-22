// The binary under interruption, killed children, protected `.gitattributes`, non-UTF-8 paths, a
// cleaned git environment and the stricter report checks. Uses the probe image.
import Foundation
import Testing

#if canImport(Glibc)
  import Glibc
#endif

/// A container of a run: its name and the host folder mounted as `/workspace`.
struct RunContainer {
  var name: String
  var workspace: String?
  var running: Bool
}

/// The `jig-*` containers (in any state) whose args contain `token`.
func containers(token: String) throws -> [RunContainer] {
  let listed = try runCommand(["docker", "ps", "-a", "--filter", "name=jig-", "--format", "{{.Names}}"])
  let names = listed.stdoutText.split(separator: "\n").map(String.init).filter { !$0.isEmpty }
  if names.isEmpty { return [] }
  // A container that went away in between makes inspect fail for it; the others are still printed.
  let inspected = try runCommand(["docker", "inspect"] + names)
  guard let all = try? JSONSerialization.jsonObject(with: inspected.stdout) as? [[String: Any]] else { return [] }
  return all.compactMap { item in
    guard let args = item["Args"] as? [String], args.contains(token) else { return nil }
    let name = ((item["Name"] as? String) ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    let mounts = (item["Mounts"] as? [[String: Any]]) ?? []
    let workspace = mounts.first { $0["Destination"] as? String == "/workspace" }?["Source"] as? String
    let running = ((item["State"] as? [String: Any])?["Running"] as? Bool) ?? false
    return RunContainer(name: name, workspace: workspace, running: running)
  }
}

/// Waits (up to 60 s) until the run's container with `token` is running.
func runningContainer(token: String) throws -> RunContainer {
  for _ in 0..<240 {
    if let found = try containers(token: token).first(where: \.running) { return found }
    usleep(250_000)
  }
  throw TestFailure("no running container with \(token) appeared")
}

/// The binary's one JSON line.
func onlyOutput(_ finished: Finished) throws -> Output {
  let stdout = finished.stdoutText
  #expect(stdout.hasSuffix("\n") && stdout.firstIndex(of: "\n") == stdout.index(before: stdout.endIndex), "\(stdout)")
  let output = try decode(Output.self, stdout)
  #expect(output.schema == "urn:jig:output:1")
  return output
}

/// Creates `<dir>/<name bytes>` with the content "x".
func createFile(_ dir: URL, rawName: [UInt8]) throws {
  let path = Array(dir.path.utf8) + [0x2f] + rawName + [0]
  let fd = path.withUnsafeBufferPointer { buffer in
    buffer.withMemoryRebound(to: CChar.self) { open($0.baseAddress!, O_CREAT | O_WRONLY | O_TRUNC, 0o644) }
  }
  guard fd >= 0 else { throw TestFailure("could not create the file: errno \(errno)") }
  _ = write(fd, "x", 1)
  close(fd)
}

/// The suites that interrupt the binary while docker runs (hardening, interruptions): one at a time, so
/// their timing and their containers never overlap.
@Suite("docker interruptions", .serialized) struct DockerInterruptionSuites {}

extension DockerInterruptionSuites {
  @Suite("hardening (docker)", .serialized, .enabled(if: dockerAvailable, dockerMissing), .builtOnce)
  struct HardeningTests {
    let temp = TempDirs()

    @Test("SIGINT during a slow image: exit 130, an INTERNAL failure, no container and no temp folder left", .timeLimit(.minutes(2)))
    func sigint() throws {
      let dir = try temp.repo()
      let before = try headCommit(dir)
      let token = "sigint-\(UUID().uuidString)"
      let started = try startCommand([try setup(), "--repo", dir.path, PROBE, "sleep", "600", token])
      let container = try runningContainer(token: token)
      let workspace = try #require(container.workspace)
      #expect(fm.fileExists(atPath: workspace))
      kill(started.pid, SIGINT)
      let finished = try started.wait(timeout: 60)

      #expect(finished.exitCode == 130)
      let output = try onlyOutput(finished)
      #expect(!output.ok)
      #expect(output.code == "INTERNAL")
      #expect(output.instructions?.hasPrefix("interrupted by SIGINT before the repository was changed;") == true)
      #expect(try containers(token: token).isEmpty)
      // The export and the temporary index live in one temporary folder: all of it is gone.
      #expect(!fm.fileExists(atPath: URL(fileURLWithPath: workspace).deletingLastPathComponent().path))
      #expect(try headCommit(dir) == before)
      #expect(try status(dir) == "")
    }

    @Test("`timeout` (SIGTERM) on a hanging image: exit 143, an INTERNAL failure, nothing left behind", .timeLimit(.minutes(2)))
    func timeoutCommand() throws {
      let dir = try temp.repo()
      let before = try headCommit(dir)
      let token = "timeout-\(UUID().uuidString)"
      let binary = try setup()
      // `timeout`'s 8 s start when it is spawned. The shutdown after them is long by design (the image's
      // node, PID 1, ignores SIGTERM: 2 s grace, SIGKILL, reaping, docker rm -f, the late-creation
      // window) and docker is slow under load: the bound only says the run did not hang.
      let launched = Date()
      let started = try startCommand(
        ["timeout", "--preserve-status", "8", binary, "--repo", dir.path, PROBE, "sleep", "600", token])
      let container = try runningContainer(token: token)
      let workspace = try #require(container.workspace)
      let finished = try started.wait(timeout: 60)

      #expect(Date().timeIntervalSince(launched) < 8 + 40)
      #expect(finished.exitCode == 143)
      let output = try onlyOutput(finished)
      #expect(output.code == "INTERNAL")
      #expect(output.instructions?.hasPrefix("interrupted by SIGTERM before the repository was changed;") == true)
      #expect(try containers(token: token).isEmpty)
      #expect(!fm.fileExists(atPath: URL(fileURLWithPath: workspace).deletingLastPathComponent().path))
      #expect(try headCommit(dir) == before)
      #expect(try status(dir) == "")
    }

    @Test("an image container killed by a signal is IMAGE_FAILED, \"killed by signal 9\"", .timeLimit(.minutes(2)))
    func containerKilled() throws {
      let dir = try temp.repo()
      let before = try headCommit(dir)
      let token = "killed-\(UUID().uuidString)"
      let started = try startCommand([try setup(), "--repo", dir.path, PROBE, "sleep", "600", token])
      let container = try runningContainer(token: token)
      #expect(try runCommand(["docker", "kill", container.name]).exitCode == 0)
      let finished = try started.wait(timeout: 60)

      #expect(finished.exitCode == 1)
      let output = try onlyOutput(finished)
      #expect(output.code == "IMAGE_FAILED")
      #expect(output.instructions?.hasPrefix("The image printed no report (killed by signal 9);") == true, "\(output.instructions ?? "")")
      #expect(try headCommit(dir) == before)
    }

    @Test("git killed by a signal is INTERNAL, \"killed by signal 9\", with instructions", .timeLimit(.minutes(1)))
    func gitKilled() throws {
      let dir = try temp.repo()
      // The export runs this smudge filter, which kills the git that runs it.
      try git(dir, ["config", "filter.boom.smudge", "kill -9 $PPID"])
      try commitFile(dir, ".gitattributes", "boom.txt filter=boom\n")
      try commitFile(dir, "boom.txt", "boom\n")
      let before = try headCommit(dir)
      let err = try failImage(repo: dir, image: PROBE, args: ["write", "fresh.txt"])
      #expect(err.code == "INTERNAL")
      #expect(err.instructions.contains("checkout-index"))
      #expect(err.instructions.contains("failed (killed by signal 9)"), "\(err.instructions)")
      #expect(err.instructions.contains("Check that git works in this repository"))
      #expect(try headCommit(dir) == before)
    }

    @Test(".gitattributes changed, added (root and nested) or deleted is IMAGE_FAILED", .timeLimit(.minutes(2)))
    func gitattributesChange() throws {
      let dir = try temp.repo()
      try commitFile(dir, ".gitattributes", "*.txt text\n")
      try commitFile(dir, "sub/keep.txt", "keep\n")
      let before = try headCommit(dir)
      let cases: [([String], String)] = [
        (["write", ".gitattributes"], ".gitattributes"),
        (["write", "sub/.gitattributes"], "sub/.gitattributes"),
        (["write", "deep/er/.gitattributes"], "deep/er/.gitattributes"),
        (["write", "node_modules/.gitattributes"], "node_modules/.gitattributes"),
        (["rm", ".gitattributes"], ".gitattributes"),
      ]
      for (args, path) in cases {
        let err = try failImage(repo: dir, image: PROBE, args: args)
        #expect(err.code == "IMAGE_FAILED")
        #expect(err.instructions.hasPrefix("the image changed a .gitattributes file: \(path). Nothing was committed."), "\(err.instructions)")
        #expect(try headCommit(dir) == before)
        #expect(try status(dir) == "")
      }
    }

    @Test("an image-written .gitattributes never selects a host filter driver during the capture", .timeLimit(.minutes(1)))
    func gitattributesFilter() throws {
      let dir = try temp.repo()
      let marker = try temp.make("filter-marker-").appendingPathComponent("ran")
      try git(dir, ["config", "filter.evil.clean", "touch '\(marker.path)'; cat"])
      let err = try failImage(repo: dir, image: PROBE, args: ["write-text", ".gitattributes", "* filter=evil"])
      #expect(err.code == "IMAGE_FAILED")
      #expect(err.instructions.hasPrefix("the image changed a .gitattributes file: .gitattributes."))
      #expect(!fm.fileExists(atPath: marker.path))
      #expect(try status(dir) == "")
    }

    @Test("a file or folder name that is not valid UTF-8 created by the image is IMAGE_FAILED", .timeLimit(.minutes(1)))
    func nonUTF8FromImage() throws {
      let dir = try temp.repo()
      let before = try headCommit(dir)
      for (mode, shown) in [("bad-name", #"b\xff.txt"#), ("bad-dir", #"d\xfe"#)] {
        let err = try failImage(repo: dir, image: PROBE, args: [mode])
        #expect(err.code == "IMAGE_FAILED")
        #expect(err.instructions.hasPrefix("the image created a path that is not valid UTF-8: \(shown) "), "\(err.instructions)")
        #expect(try headCommit(dir) == before)
        #expect(try status(dir) == "")
      }
    }

    @Test("a path that is not valid UTF-8 already in the repo is refused before the image runs", .timeLimit(.minutes(1)))
    func nonUTF8InRepo() throws {
      let dir = try temp.repo()
      try createFile(dir, rawName: [0x62, 0xff])
      try git(dir, ["add", "-A"])
      try git(dir, ["commit", "-q", "-m", "bad name"])
      let err = try failImage(repo: dir, image: PROBE, args: ["write", "fresh.txt"])
      #expect(err.code == "DIRTY_WORKTREE")
      #expect(err.instructions.hasPrefix(#"The repository has a path that is not valid UTF-8: b\xff "#), "\(err.instructions)")
      #expect(err.instructions.contains("git mv"))
    }

    @Test("a subject that does not start with <kind>(<image> <action>): is IMAGE_FAILED", .timeLimit(.minutes(2)))
    func stricterReports() throws {
      let dir = try temp.repo()
      let before = try headCommit(dir)
      let expected =
        #"the subject must start with "refactor(<image> subject): " for kind refactor and action subject, "#
        + #"where <image> is the image's own name (not empty, without spaces, "(" or ")"): "#
      let cases: [([String], String)] = [
        (["subject", "probe: no kind"], expected + #""probe: no kind""#),
        (["subject", "sweep(probe subject): wrong kind"], expected + #""sweep(probe subject): wrong kind""#),
        // The form from before subjects named the image.
        (["subject", "refactor(subject): no image"], expected + #""refactor(subject): no image""#),
        (["subject", "refactor(probe write): another action"], expected),
        (["subject", "refactor(my probe subject): a space"], expected),
      ]
      for (args, says) in cases {
        let err = try failImage(repo: dir, image: PROBE, args: args)
        #expect(err.code == "IMAGE_FAILED")
        #expect(err.instructions.contains(says), "\(err.instructions)")
        #expect(err.instructions.hasPrefix("The image's report is not a valid urn:jig:report:1 report: "))
        #expect(try headCommit(dir) == before)
        #expect(try status(dir) == "")
      }
    }

    @Test("GIT_* variables from the caller do not reach git", .timeLimit(.minutes(1)))
    func cleanedGitEnvironment() throws {
      let dir = try temp.repo()
      var env = ProcessInfo.processInfo.environment
      let elsewhere = try temp.make("elsewhere-")
      env["GIT_DIR"] = elsewhere.path
      env["GIT_WORK_TREE"] = elsewhere.path
      env["GIT_INDEX_FILE"] = elsewhere.appendingPathComponent("index").path
      env["GIT_OBJECT_DIRECTORY"] = elsewhere.path
      env["GIT_CONFIG_COUNT"] = "1"
      env["GIT_CONFIG_KEY_0"] = "core.hooksPath"
      env["GIT_CONFIG_VALUE_0"] = elsewhere.path
      let ran = try run(["--repo", dir.path, PROBE, "write", "fresh.txt"], environment: env)
      #expect(ran.output.ok, "\(ran.stdout)")
      #expect(ran.output.filesChanged == ["fresh.txt"])
      #expect(ran.output.commit == (try headCommit(dir)))
      #expect(try fm.contentsOfDirectory(atPath: elsewhere.path) == [])
      #expect(try status(dir) == "")
    }
  }
}
