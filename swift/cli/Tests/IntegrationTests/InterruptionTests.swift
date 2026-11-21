// Interruptions at the awkward moments: while the image is still writing files, while `git status` holds
// the repo's index lock, while a git filter runs, during the final fast-forward; and Docker's own
// failures (daemon unreachable, `docker run` failing, a container the daemon creates late).
import Foundation
import Testing

#if canImport(Glibc)
  import Glibc
#endif

/// A process running now: its PID, parent PID and argv.
struct RunningProcess {
  var pid: pid_t
  var parent: pid_t
  var argv: [String]
}

/// Every process of ours that `/proc` lists now (one that goes away while it is read is left out).
func runningProcesses() -> [RunningProcess] {
  let names = (try? fm.contentsOfDirectory(atPath: "/proc")) ?? []
  return names.compactMap { name -> RunningProcess? in
    guard let pid = pid_t(name),
      let cmdline = fm.contents(atPath: "/proc/\(name)/cmdline"),
      let stat = fm.contents(atPath: "/proc/\(name)/stat")
    else { return nil }
    // `pid (comm) state ppid ...`: comm may hold spaces and parentheses, so read after the last `)`.
    let text = String(decoding: stat, as: UTF8.self)
    guard let close = text.lastIndex(of: ")") else { return nil }
    let fields = text[text.index(after: close)...].split(separator: " ")
    guard fields.count > 1, let parent = pid_t(fields[1]) else { return nil }
    let argv = cmdline.split(separator: 0).map { String(decoding: $0, as: UTF8.self) }
    return RunningProcess(pid: pid, parent: parent, argv: argv)
  }
}

/// Whether a child of `parent` runs git with `argument` among its arguments.
func gitChildRuns(_ parent: pid_t, _ argument: String) -> Bool {
  runningProcesses().contains { process in
    process.parent == parent && (process.argv.first.map { $0.hasSuffix("git") } ?? false)
      && process.argv.contains(argument)
  }
}

/// Polls `condition` every millisecond until it holds (true) or `seconds` pass (false).
func poll(seconds: Double, _ condition: () -> Bool) -> Bool {
  let deadline = Date().addingTimeInterval(seconds)
  while Date() < deadline {
    if condition() { return true }
    usleep(1000)
  }
  return false
}

/// A `docker` that runs the real one, except for `docker run`, which does what `FAKE_DOCKER_RUN` says:
/// `125` and `127` fail as docker itself does; `late` prints the container name to `$FAKE_DOCKER_MARK`,
/// has the daemon create that container two seconds later (in a session of its own, so killing the
/// client does not stop it) and hangs. `FAKE_DOCKER_CREATE=late` does the same for `docker create` (the
/// rootlesskit sandbox's image export), with the real arguments. Once the late `docker create` has
/// ended, `$FAKE_DOCKER_MARK.created` exists: a test looks for the container only after that.
func fakeDocker(_ temp: TempDirs) throws -> (path: String, dir: URL) {
  let dir = try temp.make("fake-docker-")
  let real = try runCommand(["sh", "-c", "command -v docker"]).stdoutText.trimmingCharacters(in: .whitespacesAndNewlines)
  let script = """
    #!/bin/sh
    if [ "$1" = run ]; then
      prev=
      for arg in "$@"; do
        if [ "$prev" = --name ]; then name=$arg; fi
        prev=$arg
      done
      case "$FAKE_DOCKER_RUN" in
        125)
          echo "docker: Error response from daemon: fake failure." >&2
          exit 125 ;;
        127)
          echo 'docker: Error response from daemon: failed to create task for container: exec: "node": executable file not found in $PATH' >&2
          exit 127 ;;
        late)
          # The mark is written from the new session, so the client's group can be killed from then on.
          setsid sh -c 'echo "$1" > "$FAKE_DOCKER_MARK"; sleep 2; "$0" create --name "$1" "$2" true; echo done > "$FAKE_DOCKER_MARK.created"' '\(real)' "$name" '\(PROBE)' </dev/null >/dev/null 2>&1 &
          exec sleep 600 ;;
      esac
    fi
    if [ "$1" = create ] && [ "${FAKE_DOCKER_CREATE:-}" = late ]; then
      prev=
      for arg in "$@"; do
        if [ "$prev" = --name ]; then name=$arg; fi
        prev=$arg
      done
      setsid sh -c 'echo "$2" > "$FAKE_DOCKER_MARK"; sleep 2; shift 2; "$@"; echo done > "$FAKE_DOCKER_MARK.created"' sh '\(real)' "$name" '\(real)' "$@" </dev/null >/dev/null 2>&1 &
      exec sleep 600
    fi
    exec '\(real)' "$@"

    """
  let path = dir.appendingPathComponent("docker")
  try write(path, script)
  try chmod(path, 0o755)
  return (path.path, dir)
}

/// Our environment with `dir` first on PATH and `extra` set.
func environment(pathFirst dir: URL?, _ extra: [String: String] = [:]) -> [String: String] {
  var env = ProcessInfo.processInfo.environment
  if let dir { env["PATH"] = dir.path + ":" + (env["PATH"] ?? "/usr/bin:/bin") }
  for (key, value) in extra { env[key] = value }
  return env
}

extension DockerInterruptionSuites {
  @Suite("interruptions and docker failures", .serialized, .enabled(if: dockerAvailable, dockerMissing), .builtOnce)
  struct InterruptionTests {
    let temp = TempDirs()

    @Test(
      "SIGTERM and SIGINT while the image keeps writing files: no temp folder and no container left, repeatedly",
      .timeLimit(.minutes(5)))
    func interruptedWhileWriting() throws {
      for (sig, name) in [(SIGTERM, "SIGTERM"), (SIGINT, "SIGINT"), (SIGTERM, "SIGTERM"), (SIGINT, "SIGINT")] {
        let dir = try temp.repo()
        let before = try headCommit(dir)
        let token = "spew-\(UUID().uuidString)"
        let started = try startCommand([try setup(), "--repo", dir.path, PROBE, "spew", token])
        let container = try runningContainer(token: token)
        let workspace = try #require(container.workspace)
        let folder = URL(fileURLWithPath: workspace).deletingLastPathComponent()
        sleep(3)
        kill(started.pid, sig)
        let finished = try started.wait(timeout: 60)

        #expect(finished.exitCode == 128 + sig)
        let output = try onlyOutput(finished)
        #expect(output.code == "INTERNAL")
        #expect(
          output.instructions?.hasPrefix("interrupted by \(name) before the repository was changed; the container and "
            + "temporary files were removed.") == true, "\(output.instructions ?? "")\n\(finished.stderrText)")
        #expect(try containers(token: token).isEmpty)
        #expect(!fm.fileExists(atPath: folder.path), "left: \(folder.path)\n\(finished.stderrText)")
        if fm.fileExists(atPath: folder.path) { removeTree(folder) }
        #expect(try headCommit(dir) == before)
        #expect(try status(dir) == "")
      }
    }

    @Test("SIGINT while `git status` scans a large untracked tree leaves no index.lock", .timeLimit(.minutes(5)))
    func interruptedDuringStatus() throws {
      let dir = try temp.repo()
      try git(dir, ["config", "status.showUntrackedFiles", "all"])
      // 200 000 untracked files: the status that checks the tree takes a while.
      for d in 0..<400 {
        let folder = dir.appendingPathComponent("untracked/d\(d)")
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        for f in 0..<500 {
          let fd = open(folder.path + "/f\(f)", O_CREAT | O_WRONLY | O_TRUNC, 0o644)
          if fd >= 0 { close(fd) }
        }
      }
      let lock = dir.appendingPathComponent(".git/index.lock").path
      let started = try startCommand([try setup(), "--repo", dir.path, PROBE, "write", "fresh.txt"])
      let caught = poll(seconds: 60) { fm.fileExists(atPath: lock) || gitChildRuns(started.pid, "status") }
      #expect(caught, "git status was never seen running")
      kill(started.pid, SIGINT)
      let finished = try started.wait(timeout: 60)

      #expect(finished.exitCode == 130, "\(finished.stdoutText)")
      #expect(!fm.fileExists(atPath: lock), "the repo was left with .git/index.lock")
      try? fm.removeItem(atPath: lock)
    }

    @Test("an interruption gives git and its filters SIGTERM (and a moment) before SIGKILL", .timeLimit(.minutes(2)))
    func childrenGetSIGTERMFirst() throws {
      let dir = try temp.repo()
      let marks = try temp.make("filter-marks-")
      let startedMark = marks.appendingPathComponent("started").path
      let termedMark = marks.appendingPathComponent("termed").path
      // The export's checkout runs this smudge filter: it hangs, and notes a SIGTERM before it exits.
      try git(dir, [
        "config", "filter.slow.smudge",
        "touch '\(startedMark)'; trap \"touch '\(termedMark)'; exit 1\" TERM; sleep 600 & wait $!; cat",
      ])
      try commitFile(dir, ".gitattributes", "slow.txt filter=slow\n")
      try commitFile(dir, "slow.txt", "slow\n")
      let started = try startCommand([try setup(), "--repo", dir.path, PROBE, "write", "fresh.txt"])
      #expect(poll(seconds: 60) { fm.fileExists(atPath: startedMark) }, "the filter never ran")
      kill(started.pid, SIGINT)
      let finished = try started.wait(timeout: 60)

      #expect(finished.exitCode == 130, "\(finished.stdoutText)")
      #expect(fm.fileExists(atPath: termedMark), "the filter was killed without a SIGTERM first")
    }

    @Test(
      "SIGTERM during the final fast-forward: it finishes, exit 143, the commit is reported as applied",
      .timeLimit(.minutes(2)))
    func interruptedDuringTheMerge() throws {
      let dir = try temp.repo()
      // Checking out slow.txt takes 3 s (hooks never run, filters do): the export and the fast-forward.
      try git(dir, ["config", "filter.slow.smudge", "sleep 3; cat"])
      try commitFile(dir, ".gitattributes", "slow.txt filter=slow\n")
      try commitFile(dir, "slow.txt", String(repeating: "slow\n", count: 200_000))
      let before = try headCommit(dir)
      let started = try startCommand([try setup(), "--repo", dir.path, PROBE, "write", "slow.txt"])
      #expect(poll(seconds: 60) { gitChildRuns(started.pid, "--ff-only") }, "the fast-forward was never seen running")
      kill(started.pid, SIGTERM)
      let finished = try started.wait(timeout: 60)

      #expect(finished.exitCode == 143)
      let output = try onlyOutput(finished)
      #expect(output.code == "INTERNAL")
      let head = try headCommit(dir)
      #expect(head != before)
      #expect(try git(dir, ["rev-parse", "HEAD^"]).trimmingCharacters(in: .whitespacesAndNewlines) == before)
      #expect(
        output.instructions?.hasPrefix("interrupted by SIGTERM after the commit \(head) was applied") == true,
        "\(output.instructions ?? "")")
      #expect(try readText(dir.appendingPathComponent("slow.txt")) == "from image\n")
      #expect(try status(dir) == "")
    }

    @Test("an unreachable Docker daemon is INTERNAL with Docker instructions, not IMAGE_NOT_FOUND", .timeLimit(.minutes(1)))
    func daemonUnreachable() throws {
      let dir = try temp.repo()
      let env = environment(pathFirst: nil, ["DOCKER_HOST": "unix:///nonexistent/jig-test.sock"])
      let ran = try run(["--repo", dir.path, PROBE, "write", "fresh.txt"], environment: env)
      let failure = try #require(ran.output.failure)
      #expect(failure.code == "INTERNAL", "\(failure.instructions)")
      #expect(failure.instructions.contains("Docker daemon"), "\(failure.instructions)")
      #expect(!failure.instructions.contains("Build or pull"), "\(failure.instructions)")
      #expect(try status(dir) == "")
    }

    @Test("no docker on PATH is INTERNAL saying what to install", .timeLimit(.minutes(1)))
    func dockerMissing() throws {
      let dir = try temp.repo()
      // A PATH with git and nothing else.
      let bin = try temp.make("only-git-")
      let realGit = try runCommand(["sh", "-c", "command -v git"]).stdoutText.trimmingCharacters(in: .whitespacesAndNewlines)
      try fm.createSymbolicLink(atPath: bin.appendingPathComponent("git").path, withDestinationPath: realGit)
      var env = ProcessInfo.processInfo.environment
      env["PATH"] = bin.path
      let ran = try run(["--repo", dir.path, PROBE, "write", "fresh.txt"], environment: env)
      let failure = try #require(ran.output.failure)
      #expect(failure.code == "INTERNAL", "\(failure.instructions)")
      #expect(failure.instructions.hasPrefix("docker was not found on PATH"), "\(failure.instructions)")
      #expect(failure.instructions.contains("install Docker"), "\(failure.instructions)")
      #expect(try status(dir) == "")
    }

    @Test("docker run failing itself (125, 127) is INTERNAL about Docker, not a broken image", .timeLimit(.minutes(1)))
    func dockerRunFails() throws {
      let dir = try temp.repo()
      let before = try headCommit(dir)
      let fake = try fakeDocker(temp)
      for (code, says) in [("125", "fake failure"), ("127", "executable file not found")] {
        let env = environment(pathFirst: fake.dir, ["FAKE_DOCKER_RUN": code])
        let ran = try run(["--repo", dir.path, PROBE, "write", "fresh.txt"], environment: env)
        let failure = try #require(ran.output.failure)
        #expect(failure.code == "INTERNAL", "\(failure.instructions)")
        #expect(failure.instructions.hasPrefix("docker run failed (exit code \(code))"), "\(failure.instructions)")
        #expect(failure.instructions.contains(says))
        #expect(!failure.instructions.contains("report the image as broken"), "\(failure.instructions)")
        #expect(try headCommit(dir) == before)
      }
    }

    @Test("a container the daemon creates after the client was killed is still removed", .timeLimit(.minutes(1)))
    func lateContainer() throws {
      let dir = try temp.repo()
      let fake = try fakeDocker(temp)
      let mark = try temp.make("fake-docker-mark-").appendingPathComponent("name")
      let env = environment(pathFirst: fake.dir, ["FAKE_DOCKER_RUN": "late", "FAKE_DOCKER_MARK": mark.path])
      let started = try startCommand([try setup(), "--repo", dir.path, PROBE, "write", "fresh.txt"], environment: env)
      #expect(poll(seconds: 60) { ((try? readText(mark)) ?? "").hasSuffix("\n") }, "docker run never started")
      let name = try readText(mark).trimmingCharacters(in: .whitespacesAndNewlines)
      kill(started.pid, SIGINT)
      let finished = try started.wait(timeout: 60)
      #expect(finished.exitCode == 130)
      // Look once the late creation has ended (two seconds after `docker run` started, plus docker's time).
      let created = URL(fileURLWithPath: mark.path + ".created")
      #expect(poll(seconds: 60) { fm.fileExists(atPath: created.path) }, "the late docker create never ended")
      let listed = try runCommand(["docker", "ps", "-aq", "--filter", "name=^/\(name)$"]).stdoutText
      #expect(listed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "the container \(name) was left")
      _ = try? runCommand(["docker", "rm", "-f", name])
    }
  }
}
