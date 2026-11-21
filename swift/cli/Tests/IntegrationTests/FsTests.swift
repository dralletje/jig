// The fs image (busybox + Nushell, containers/fs) end to end on the fs fixture: every command commits
// and `jig verify` replays it as identical; every refusal leaves the repo untouched.
import Foundation
import Testing

private let FS = "localhost/jig/fs:local"

/// Builds the fs image once (the shared `setup()` builds the binary and the other images).
private let builtFs: Result<Void, any Error> = Result {
  try setup()
  let build = try runCommand(
    ["sh", repoRoot.appendingPathComponent("scripts/build-images.sh").path, "fs"], cwd: repoRoot, timeout: 1800)
  guard build.exitCode == 0 else {
    throw TestFailure("build-images.sh fs failed (exit \(build.exitCode)):\n\(build.stderrText)")
  }
}

private struct FsBuilt: SuiteTrait, TestScoping {
  var isRecursive: Bool { false }

  func provideScope(
    for test: Test, testCase: Test.Case?, performing function: @Sendable () async throws -> Void
  ) async throws {
    try builtFs.get()
    try await function()
  }
}

/// Commits a symlink at `path` pointing to `target` (the fixture copy carries no symlinks).
private func commitSymlink(_ dir: URL, _ path: String, _ target: String) throws {
  try fm.createSymbolicLink(atPath: dir.appendingPathComponent(path).path, withDestinationPath: target)
  try git(dir, ["add", path])
  try git(dir, ["commit", "-q", "-m", "add \(path)"])
}

/// `jig verify HEAD` says the one commit is identical.
private func expectIdentical(_ dir: URL) throws {
  let verified = try verify(["--repo", dir.path, "HEAD"])
  let commits = try verified.commits()
  #expect(commits.count == 1)
  #expect(commits.first?.verdict == "identical", "\(verified.stdout)\n\(verified.stderr)")
}

/// The fs image run with `args` refuses; HEAD and the work tree stay as they were.
private func refused(_ dir: URL, _ args: [String]) throws -> Failure {
  let before = try headCommit(dir)
  let err = try failImage(repo: dir, image: FS, args: args)
  #expect(try headCommit(dir) == before)
  #expect(try status(dir) == "")
  return err
}

@Suite("fs (docker)", .serialized, .enabled(if: dockerAvailable, dockerMissing), FsBuilt())
struct FsTests {
  let temp = TempDirs()

  @Test("copy a folder: dotfiles and nested files come along", .timeLimit(.minutes(3)))
  func copyFolder() throws {
    let dir = try temp.fixture("fs")
    let result = try runImage(repo: dir, image: FS, args: ["copy", "--from", "src/old", "--to", "src/new"])
    #expect(result.kind == "rewrite")
    #expect(result.subject == "rewrite(copy): src/old → src/new")
    #expect(result.summary == "Copied src/old to src/new (3 files).")
    #expect(result.filesChanged == ["src/new/.hidden", "src/new/a.txt", "src/new/nested/b.txt"])
    #expect(try status(dir) == "")
    try expectIdentical(dir)
  }

  @Test("copy with ./ and a trailing / normalizes the paths and creates missing parents", .timeLimit(.minutes(3)))
  func copyNormalizesAndCreatesParents() throws {
    let dir = try temp.fixture("fs")
    let result = try runImage(repo: dir, image: FS, args: ["copy", "--from", "./src/old/", "--to", "src/a/b/new"])
    #expect(result.subject == "rewrite(copy): src/old → src/a/b/new")
    #expect(result.filesChanged == ["src/a/b/new/.hidden", "src/a/b/new/a.txt", "src/a/b/new/nested/b.txt"])
    try expectIdentical(dir)
  }

  @Test("copy names with a space and non-ASCII letters", .timeLimit(.minutes(3)))
  func copySpacesAndUnicode() throws {
    let dir = try temp.fixture("fs")
    let result = try runImage(repo: dir, image: FS, args: ["copy", "--from", "my dir", "--to", "été"])
    #expect(result.subject == "rewrite(copy): my dir → été")
    #expect(result.summary == "Copied my dir to été (1 file).")
    #expect(try readText(dir.appendingPathComponent("été/a b.txt")) == "a b.txt\n")
    try expectIdentical(dir)
  }

  @Test("copy keeps the executable bit", .timeLimit(.minutes(3)))
  func copyKeepsMode() throws {
    let dir = try temp.fixture("fs")
    try chmod(dir.appendingPathComponent("scripts/run.sh"), 0o755)
    try git(dir, ["commit", "-q", "-am", "make run.sh executable"])
    _ = try runImage(repo: dir, image: FS, args: ["copy", "--from", "scripts/run.sh", "--to", "scripts/run2.sh"])
    #expect(try git(dir, ["ls-tree", "HEAD", "scripts/run2.sh"]).hasPrefix("100755 blob "))
    try expectIdentical(dir)
  }

  @Test("copy of a symlink is a symlink with the same target", .timeLimit(.minutes(3)))
  func copySymlink() throws {
    let dir = try temp.fixture("fs")
    try commitSymlink(dir, "link", "keep.txt")
    _ = try runImage(repo: dir, image: FS, args: ["copy", "--from", "link", "--to", "link2"])
    #expect(try git(dir, ["ls-tree", "HEAD", "link2"]).hasPrefix("120000 blob "))
    #expect(try fm.destinationOfSymbolicLink(atPath: dir.appendingPathComponent("link2").path) == "keep.txt")
    try expectIdentical(dir)
  }

  @Test("move a folder", .timeLimit(.minutes(3)))
  func moveFolder() throws {
    let dir = try temp.fixture("fs")
    let result = try runImage(repo: dir, image: FS, args: ["move", "--from", "src/old", "--to", "src/moved"])
    #expect(result.kind == "rewrite")
    #expect(result.subject == "rewrite(move): src/old → src/moved")
    #expect(result.summary == "Moved src/old to src/moved (3 files).")
    #expect(try git(dir, ["ls-tree", "-r", "--name-only", "HEAD", "src/old"]) == "")
    #expect(
      try git(dir, ["ls-tree", "-r", "--name-only", "HEAD", "src/moved"])
        == "src/moved/.hidden\nsrc/moved/a.txt\nsrc/moved/nested/b.txt\n")
    #expect(try status(dir) == "")
    try expectIdentical(dir)
  }

  @Test(
    "bad paths, a missing source and a taken destination are INVALID_ARGS naming the path",
    .timeLimit(.minutes(2)),
    arguments: [
      (["copy", "--from", "nope", "--to", "x"], "\"nope\""),
      (["move", "--from", "src/old", "--to", "keep.txt"], "\"keep.txt\""),
      (["move", "--from", "src/old", "--to", "src/old/inner"], "\"src/old/inner\""),
      (["copy", "--from", "src/old", "--to", "src/old/inner"], "\"src/old/inner\""),
      (["copy", "--from", "/etc", "--to", "x"], "\"/etc\""),
      (["copy", "--from", "../x", "--to", "y"], "\"../x\""),
      (["copy", "--from", "src/../keep.txt", "--to", "y"], "\"src/../keep.txt\""),
      (["copy", "--from", ".", "--to", "y"], "\".\""),
      (["copy", "--from", "", "--to", "y"], "\"\""),
      (["copy", "--from", "keep.txt", "--to", ".git/x"], "\".git/x\""),
    ])
  func badPaths(args: [String], named: String) throws {
    let dir = try temp.fixture("fs")
    let err = try refused(dir, args)
    #expect(err.code == "INVALID_ARGS")
    #expect(err.instructions.contains(named), "\(err.instructions)")
  }

  @Test(
    "a part made only of dots or starting with ~ is refused (nu would expand it out of the repo)",
    .timeLimit(.minutes(2)),
    arguments: [
      (["copy", "--from", ".../etc/passwd", "--to", "stolen"], "\".../etc/passwd\""),
      (["copy", "--from", "src/old", "--to", "a/..../j"], "\"a/..../j\""),
      (["remove", "--paths", "keep.txt,~"], "\"~\""),
      (["wrap", "--paths", "keep.txt,~", "--into", "box"], "\"~\""),
      (["remove", "--files", "~/*"], "\"~/*\""),
      (["remove", "--files", ".../*"], "\".../*\""),
    ] as [([String], String)])
  func dotsAndTilde(args: [String], named: String) throws {
    let dir = try temp.fixture("fs")
    let err = try refused(dir, args)
    #expect(err.code == "INVALID_ARGS")
    #expect(err.instructions.contains(named), "\(err.instructions)")
    #expect(try readText(dir.appendingPathComponent("keep.txt")) == "keep.txt\n")
  }

  @Test("a dangling symlink at the destination is taken", .timeLimit(.minutes(2)))
  func danglingDestinationIsTaken() throws {
    let dir = try temp.fixture("fs")
    try commitSymlink(dir, "dangling", "missing")
    let err = try refused(dir, ["copy", "--from", "keep.txt", "--to", "dangling"])
    #expect(err.code == "INVALID_ARGS")
    #expect(err.instructions.contains("\"dangling\""), "\(err.instructions)")
  }

  @Test("a path through a symlinked folder is refused", .timeLimit(.minutes(2)))
  func pathThroughSymlink() throws {
    let dir = try temp.fixture("fs")
    try commitSymlink(dir, "linked", "src/lib")
    let err = try refused(dir, ["copy", "--from", "linked/d.txt", "--to", "y"])
    #expect(err.code == "INVALID_ARGS")
    #expect(err.instructions.contains("\"linked/d.txt\""), "\(err.instructions)")
  }

  @Test("a missing flag gives the usage", .timeLimit(.minutes(2)))
  func missingFlag() throws {
    let dir = try temp.fixture("fs")
    let err = try refused(dir, ["copy", "--from", "src/old"])
    #expect(err.code == "INVALID_ARGS")
    #expect(err.instructions.contains("copy --from <path> --to <path>"), "\(err.instructions)")
  }

  @Test("an unknown flag gives the usage", .timeLimit(.minutes(2)))
  func unknownFlag() throws {
    let dir = try temp.fixture("fs")
    let err = try refused(dir, ["copy", "--from", "a", "--to", "b", "--force"])
    #expect(err.code == "INVALID_ARGS")
    #expect(err.instructions.contains("--force"), "\(err.instructions)")
    #expect(err.instructions.contains("copy --from <path> --to <path>"), "\(err.instructions)")
  }

  @Test(
    "a repeated flag, a flag without a value and a stray argument give the usage",
    .timeLimit(.minutes(2)),
    arguments: [
      ["copy", "--from", "a", "--from", "b", "--to", "c"],
      ["copy", "--from"],
      ["copy", "stray", "--from", "a", "--to", "b"],
    ])
  func badFlags(args: [String]) throws {
    let dir = try temp.fixture("fs")
    let err = try refused(dir, args)
    #expect(err.code == "INVALID_ARGS")
    #expect(err.instructions.contains("copy --from <path> --to <path>"), "\(err.instructions)")
  }

  @Test("a path whose parent is a file is refused", .timeLimit(.minutes(2)))
  func parentIsFile() throws {
    let dir = try temp.fixture("fs")
    let err = try refused(dir, ["copy", "--from", "keep.txt/x", "--to", "y"])
    #expect(err.code == "INVALID_ARGS")
    #expect(err.instructions.contains("\"keep.txt/x\""), "\(err.instructions)")
  }

  @Test("copy of a folder holding a symlink counts the link as a file and keeps it a link", .timeLimit(.minutes(3)))
  func copyFolderWithSymlink() throws {
    let dir = try temp.fixture("fs")
    try commitSymlink(dir, "src/old/link", "a.txt")
    let result = try runImage(repo: dir, image: FS, args: ["copy", "--from", "src/old", "--to", "src/new"])
    #expect(result.summary == "Copied src/old to src/new (4 files).")
    #expect(try git(dir, ["ls-tree", "HEAD", "src/new/link"]).hasPrefix("120000 blob "))
    #expect(try fm.destinationOfSymbolicLink(atPath: dir.appendingPathComponent("src/new/link").path) == "a.txt")
    try expectIdentical(dir)
  }

  @Test("remove --paths removes files and folders", .timeLimit(.minutes(3)))
  func removePaths() throws {
    let dir = try temp.fixture("fs")
    let result = try runImage(repo: dir, image: FS, args: ["remove", "--paths", "src/old,keep.txt"])
    #expect(result.kind == "rewrite")
    #expect(result.subject == "rewrite(remove): src/old, keep.txt")
    #expect(result.summary == "Removed src/old, keep.txt (4 files).")
    #expect(try git(dir, ["ls-tree", "-r", "--name-only", "HEAD", "src/old", "keep.txt"]) == "")
    #expect(try status(dir) == "")
    try expectIdentical(dir)
  }

  @Test("remove --files lists the matched files, sorted", .timeLimit(.minutes(3)))
  func removeFiles() throws {
    let dir = try temp.fixture("fs")
    let result = try runImage(repo: dir, image: FS, args: ["remove", "--files", "**/*.bak"])
    #expect(result.subject == "rewrite(remove): **/*.bak")
    #expect(result.summary == "Removed 2 files matching **/*.bak:\n  src/y.bak\n  x.bak")
    #expect(result.filesChanged == ["src/y.bak", "x.bak"])
    try expectIdentical(dir)
  }

  @Test("remove --files takes several globs and matches dotfiles", .timeLimit(.minutes(3)))
  func removeFilesDotfiles() throws {
    let dir = try temp.fixture("fs")
    let result = try runImage(repo: dir, image: FS, args: ["remove", "--files", "**/.DS_Store,**/*.bak"])
    #expect(result.filesChanged == ["src/deep/.DS_Store", "src/y.bak", "x.bak"])
    #expect(result.summary.hasPrefix("Removed 3 files matching **/.DS_Store, **/*.bak:\n"), "\(result.summary)")
    try expectIdentical(dir)
  }

  @Test("remove --files trims each glob", .timeLimit(.minutes(3)))
  func removeFilesTrimmed() throws {
    let dir = try temp.fixture("fs")
    let result = try runImage(repo: dir, image: FS, args: ["remove", "--files", "**/*.bak, src/deep/.DS_Store"])
    #expect(result.filesChanged == ["src/deep/.DS_Store", "src/y.bak", "x.bak"])
    #expect(result.subject == "rewrite(remove): **/*.bak, src/deep/.DS_Store")
    try expectIdentical(dir)
  }

  @Test("unwrap picks a temporary name that no entry of the folder has", .timeLimit(.minutes(3)))
  func unwrapTemporaryNameTaken() throws {
    let dir = try temp.fixture("fs")
    try commitFile(dir, "src/lib/.lib.unwrap-0", "entry\n")
    let result = try runImage(repo: dir, image: FS, args: ["unwrap", "--folder", "src/lib"])
    #expect(result.summary == "Unwrapped src/lib into src (4 files).")
    #expect(try readText(dir.appendingPathComponent("src/.lib.unwrap-0")) == "entry\n")
    #expect(try status(dir) == "")
    try expectIdentical(dir)
  }

  @Test("remove --files lists at most 20 files", .timeLimit(.minutes(3)))
  func removeFilesCapped() throws {
    let dir = try temp.fixture("fs")
    try fm.createDirectory(at: dir.appendingPathComponent("many"), withIntermediateDirectories: false)
    for n in 1...21 {
      try write(dir.appendingPathComponent(String(format: "many/f%02d.tmp", n)), "\(n)\n")
    }
    try git(dir, ["add", "many"])
    try git(dir, ["commit", "-q", "-m", "add many"])
    let result = try runImage(repo: dir, image: FS, args: ["remove", "--files", "many/*.tmp"])
    #expect(result.filesChanged.count == 21)
    #expect(result.summary.hasPrefix("Removed 21 files matching many/*.tmp:\n  many/f01.tmp\n"), "\(result.summary)")
    #expect(result.summary.hasSuffix("\n  many/f20.tmp\n  … and 1 more"), "\(result.summary)")
    try expectIdentical(dir)
  }

  @Test("remove --paths of a symlink removes the link, not its target", .timeLimit(.minutes(3)))
  func removeSymlink() throws {
    let dir = try temp.fixture("fs")
    try commitSymlink(dir, "link", "keep.txt")
    let result = try runImage(repo: dir, image: FS, args: ["remove", "--paths", "link"])
    #expect(result.filesChanged == ["link"])
    #expect(!fm.fileExists(atPath: dir.appendingPathComponent("link").path))
    #expect(try readText(dir.appendingPathComponent("keep.txt")) == "keep.txt\n")
    try expectIdentical(dir)
  }

  @Test("unwrap a folder that holds an item of its own name", .timeLimit(.minutes(3)))
  func unwrapFolder() throws {
    let dir = try temp.fixture("fs")
    let result = try runImage(repo: dir, image: FS, args: ["unwrap", "--folder", "src/lib"])
    #expect(result.kind == "rewrite")
    #expect(result.subject == "rewrite(unwrap): src/lib")
    #expect(result.summary == "Unwrapped src/lib into src (3 files).")
    #expect(
      try git(dir, ["ls-tree", "-r", "--name-only", "HEAD", "src/d.txt", "src/.env.example", "src/lib"])
        == "src/.env.example\nsrc/d.txt\nsrc/lib/c.txt\n")
    #expect(try status(dir) == "")
    try expectIdentical(dir)
  }

  @Test("wrap paths into a new folder", .timeLimit(.minutes(3)))
  func wrapPaths() throws {
    let dir = try temp.fixture("fs")
    let result = try runImage(repo: dir, image: FS, args: ["wrap", "--paths", "keep.txt,my dir", "--into", "box"])
    #expect(result.kind == "rewrite")
    #expect(result.subject == "rewrite(wrap): keep.txt, my dir → box")
    #expect(result.summary == "Wrapped keep.txt, my dir into box (2 files).")
    #expect(
      try git(dir, ["ls-tree", "-r", "--name-only", "HEAD", "box", "keep.txt", "my dir"])
        == "box/keep.txt\nbox/my dir/a b.txt\n")
    #expect(try status(dir) == "")
    try expectIdentical(dir)
  }

  @Test("unwrap a bracketed folder holding a bracketed entry (Next.js route names)", .timeLimit(.minutes(3)))
  func unwrapBrackets() throws {
    let dir = try temp.fixture("fs")
    try commitFile(dir, "app/[id]/[slug]/page.tsx", "page\n")
    try commitFile(dir, "app/[id]/a*?.txt", "a\n")
    let result = try runImage(repo: dir, image: FS, args: ["unwrap", "--folder", "app/[id]"])
    #expect(result.summary == "Unwrapped app/[id] into app (2 files).")
    #expect(try readText(dir.appendingPathComponent("app/[slug]/page.tsx")) == "page\n")
    #expect(try readText(dir.appendingPathComponent("app/a*?.txt")) == "a\n")
    #expect(!fm.fileExists(atPath: dir.appendingPathComponent("app/[id]").path))
    #expect(try status(dir) == "")
    try expectIdentical(dir)
  }

  @Test("wrap bracketed paths into a bracketed folder", .timeLimit(.minutes(3)))
  func wrapBrackets() throws {
    let dir = try temp.fixture("fs")
    try commitFile(dir, "a[1]/x.txt", "x\n")
    let result = try runImage(repo: dir, image: FS, args: ["wrap", "--paths", "a[1],keep.txt", "--into", "b[2]"])
    #expect(result.summary == "Wrapped a[1], keep.txt into b[2] (2 files).")
    #expect(try readText(dir.appendingPathComponent("b[2]/a[1]/x.txt")) == "x\n")
    #expect(try readText(dir.appendingPathComponent("b[2]/keep.txt")) == "keep.txt\n")
    #expect(try status(dir) == "")
    try expectIdentical(dir)
  }

  @Test("move a bracketed folder", .timeLimit(.minutes(3)))
  func moveBrackets() throws {
    let dir = try temp.fixture("fs")
    try commitFile(dir, "app/[id]/page.tsx", "page\n")
    _ = try runImage(repo: dir, image: FS, args: ["move", "--from", "app/[id]", "--to", "app/[slug]"])
    #expect(try readText(dir.appendingPathComponent("app/[slug]/page.tsx")) == "page\n")
    #expect(!fm.fileExists(atPath: dir.appendingPathComponent("app/[id]").path))
    try expectIdentical(dir)
  }

  @Test("remove --files that matches nothing is NO_CHANGES", .timeLimit(.minutes(2)))
  func removeNothing() throws {
    let dir = try temp.fixture("fs")
    let err = try refused(dir, ["remove", "--files", "**/*.nothing"])
    #expect(err.code == "NO_CHANGES")
  }

  @Test(
    "remove, unwrap and wrap refusals are INVALID_ARGS naming the path",
    .timeLimit(.minutes(2)),
    arguments: [
      (["remove", "--paths", "src/old,nope"], "\"nope\""),
      (["remove", "--paths", "a", "--files", "*"], "remove --paths <path,path> | remove --files <glob,glob>"),
      (["remove"], "remove --paths <path,path> | remove --files <glob,glob>"),
      (["remove", "--paths", " , "], "remove --paths <path,path> | remove --files <glob,glob>"),
      (["remove", "--files", ","], "remove --paths <path,path> | remove --files <glob,glob>"),
      (["unwrap", "--folder", "keep.txt"], "\"keep.txt\""),
      (["unwrap", "--folder", "."], "\".\""),
      (["wrap", "--paths", "src/old", "--into", "src/old/box"], "\"src/old/box\""),
      (["wrap", "--paths", "keep.txt", "--into", "src"], "\"src\""),
    ])
  func removeUnwrapWrapRefusals(args: [String], named: String) throws {
    let dir = try temp.fixture("fs")
    let err = try refused(dir, args)
    #expect(err.code == "INVALID_ARGS")
    #expect(err.instructions.contains(named), "\(err.instructions)")
  }

  // A git checkout never holds an empty folder, so this runs the image directly on a plain folder.
  @Test("unwrap of a folder without files is NO_CHANGES and touches nothing", .timeLimit(.minutes(2)))
  func unwrapEmpty() throws {
    let dir = try temp.make("fs-empty")
    try fm.createDirectory(at: dir.appendingPathComponent("src/empty/inner"), withIntermediateDirectories: true)
    let run = try runCommand([
      "docker", "run", "--rm", "--network", "none", "--read-only", "--tmpfs", "/tmp",
      "-v", "\(dir.path):/workspace", "-w", "/workspace", FS, "unwrap", "--folder", "src/empty",
    ])
    #expect(run.exitCode == 1, "\(run.stdoutText)\n\(run.stderrText)")
    let last = try #require(run.stdoutText.split(separator: "\n").last)
    let report = try #require(try JSONSerialization.jsonObject(with: Data(last.utf8)) as? [String: Any])
    #expect(report["ok"] as? Bool == false)
    #expect(report["code"] as? String == "NO_CHANGES")
    #expect((report["instructions"] as? String)?.contains("\"src/empty\"") == true, "\(report)")
    #expect(fm.fileExists(atPath: dir.appendingPathComponent("src/empty/inner").path))
  }

  @Test("unwrap refuses when a name collides with one next to the folder", .timeLimit(.minutes(2)))
  func unwrapCollision() throws {
    let dir = try temp.fixture("fs")
    try commitFile(dir, "src/a.txt", "a\n")
    let err = try refused(dir, ["unwrap", "--folder", "src/old"])
    #expect(err.code == "INVALID_ARGS")
    #expect(err.instructions.contains("\"src/a.txt\""), "\(err.instructions)")
  }

  @Test("wrap refuses two paths with the same base name", .timeLimit(.minutes(2)))
  func wrapSameBaseName() throws {
    let dir = try temp.fixture("fs")
    try commitFile(dir, "src/a.txt", "a\n")
    let err = try refused(dir, ["wrap", "--paths", "src/old/a.txt,src/a.txt", "--into", "box"])
    #expect(err.code == "INVALID_ARGS")
    #expect(err.instructions.contains("\"a.txt\""), "\(err.instructions)")
  }

  @Test("an unknown command is UNKNOWN_ACTION and lists the commands", .timeLimit(.minutes(2)))
  func unknownCommand() throws {
    let dir = try temp.fixture("fs")
    let err = try refused(dir, ["nope"])
    #expect(err.code == "UNKNOWN_ACTION")
    #expect(err.instructions.contains("copy, move, remove, unwrap, wrap"), "\(err.instructions)")
  }

  @Test("no command at all is UNKNOWN_ACTION", .timeLimit(.minutes(2)))
  func noCommand() throws {
    let dir = try temp.fixture("fs")
    let err = try refused(dir, [])
    #expect(err.code == "UNKNOWN_ACTION")
    #expect(err.instructions.contains("copy, move, remove, unwrap, wrap"), "\(err.instructions)")
  }
}
