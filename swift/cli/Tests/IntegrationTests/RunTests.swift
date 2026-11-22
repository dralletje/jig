// The binary end to end: real images (typescript, prettier) and the test-only probe image.
import Foundation
import Testing

/// What the binary says after an image broke one of its rules.
private let ruleBroken = "Nothing was committed. Run the image with arguments that leave these alone, or report the image."

/// What `could not remove <path>:` on stderr names: an export folder the host left behind.
private func leftBehind(_ stderr: String) throws -> String? {
  let regex = try Regex(#"could not remove (\S+):"#)
  guard let match = stderr.firstMatch(of: regex), let path = match.output[1].substring else { return nil }
  return String(path)
}

@Suite("jig (docker)", .serialized, .enabled(if: dockerAvailable, dockerMissing), .builtOnce)
struct RunTests {
  let temp = TempDirs()

  @Test("typescript rename is committed with the pinned image and args", .timeLimit(.minutes(2)))
  func typescriptRename() throws {
    let dir = try temp.repo()
    let parent = try headCommit(dir)
    let result = try runImage(repo: dir, image: TS, args: RENAME)
    #expect(result.parent == parent)
    #expect(result.commit == (try headCommit(dir)))
    #expect(result.filesChanged.contains("a.ts"))
    #expect(try git(dir, ["log", "-1", "--format=%s"]) == "refactor(rename): foo → bar in a.ts\n")
    let body = try git(dir, ["log", "-1", "--format=%B"])
    let command = parseRefactorCommand(body)
    let pinned = try Regex(#"^localhost/jig/typescript:local@sha256:[0-9a-f]{64}$"#)
    #expect(command?.image.wholeMatch(of: pinned) != nil)
    #expect(command?.args == RENAME)
    #expect(result.image == command?.image)
    #expect(result.args == RENAME)
    #expect(result.kind == "refactor")
    #expect(result.subject == "refactor(rename): foo → bar in a.ts")
    #expect(result.summary.hasPrefix("Renamed `foo` to `bar` in a.ts ("))
    #expect(body.hasPrefix("refactor(rename): foo → bar in a.ts\n\n\(result.summary)\n\nRefactor-Command: "))
    // The trailers are exactly these three lines, in this order, ending the message (`%B` adds a newline).
    let lines = body.trimmingCharacters(in: .newlines).split(separator: "\n", omittingEmptySubsequences: false)
    let trailers = lines.suffix(3).map(String.init)
    #expect(
      trailers.map { line in String(line.prefix(while: { $0 != ":" })) }
        == ["Refactor-Command", "Refactor-Kind", "Co-Authored-By"])
    #expect(trailers[1] == "Refactor-Kind: refactor")
    #expect(trailers[2] == "Co-Authored-By: codemodder <codemodder@users.noreply.github.com>")
    #expect(lines.dropLast(3).last == "")
    #expect(!body.contains("Refactor-Status") && !body.contains("Refactor-Effect"))
    #expect(try readTree(dir)["a.ts"]?.contains("export function bar()") == true)
    #expect(try status(dir) == "")
  }

  @Test("prettier format is committed", .timeLimit(.minutes(2)))
  func prettierFormat() throws {
    let dir = try temp.repo()
    try commitFile(dir, "ugly.ts", "const   x = {a:1}\n")
    let result = try runImage(repo: dir, image: PRETTIER, args: ["format", "--files", "ugly.ts"], message: "tidy")
    #expect(result.filesChanged == ["ugly.ts"])
    #expect(result.kind == "sweep")
    #expect(try readTree(dir)["ugly.ts"] == "const x = { a: 1 };\n")
    let body = try git(dir, ["log", "-1", "--format=%B"])
    #expect(body.hasPrefix("sweep(format): ugly.ts\n\n\(result.summary)\n\ntidy\n\nRefactor-Command: "))
    #expect(result.summary.hasPrefix("Formatted 1 file with prettier "))
    #expect(
      body.trimmingCharacters(in: .newlines)
        .hasSuffix("\nRefactor-Kind: sweep\nCo-Authored-By: codemodder <codemodder@users.noreply.github.com>"))
    #expect(try status(dir) == "")
  }

  @Test("a rename in the example webapp rewrites its importers", .timeLimit(.minutes(2)))
  func exampleWebappRename() throws {
    let dir = try temp.fixture("examples/webapp")
    let args = ["rename", "--file", "src/lib/math.ts", "--symbol", "clamp", "--to", "clampValue"]
    let result = try runImage(repo: dir, image: TS, args: args)
    #expect(result.filesChanged == ["src/lib/math.ts", "src/services/order-service.ts"])
    #expect(try git(dir, ["log", "-1", "--format=%s"]) == "refactor(rename): clamp → clampValue in src/lib/math.ts\n")
    #expect(try readTree(dir)["src/services/order-service.ts"]?.contains("math.clampValue(percent, 0, 100)") == true)
    #expect(try status(dir) == "")
  }

  @Test("remove-barrels in the example webapp is a refactor; a second run is NO_CHANGES", .timeLimit(.minutes(2)))
  func exampleWebappRemoveBarrels() throws {
    let dir = try temp.fixture("examples/webapp")
    let args = ["remove-barrels", "--files", "src/**"]
    let result = try runImage(repo: dir, image: TS, args: args)
    #expect(result.kind == "refactor")
    #expect(result.filesChanged == [
      "src/components/RoleBadge.ts", "src/components/UserCard.ts", "src/components/order-summary.ts",
      "src/lib/index.ts", "src/main.ts", "src/models/index.ts", "src/services/index.ts",
      "src/services/order-service.ts", "src/services/userService.ts", "src/utils/index.ts",
    ])
    #expect(try git(dir, ["log", "-1", "--format=%s"]) == "refactor(remove-barrels): src/**\n")
    #expect(try git(dir, ["log", "-1", "--format=%B"]).contains("\nRefactor-Kind: refactor\n"))
    let tree = try readTree(dir)
    #expect(tree["src/lib/index.ts"] == nil)
    #expect(tree["src/services/order-service.ts"]?.contains(#"import { formatCurrency as currency } from "@/lib/format";"#) == true)
    #expect(try status(dir) == "")
    #expect(try failImage(repo: dir, image: TS, args: args).code == "NO_CHANGES")
  }

  @Test("add-import-extensions in the example webapp is a sweep; a second run is NO_CHANGES", .timeLimit(.minutes(2)))
  func exampleWebappAddImportExtensions() throws {
    let dir = try temp.fixture("examples/webapp")
    let args = ["add-import-extensions", "--files", "src/**"]
    let result = try runImage(repo: dir, image: TS, args: args)
    #expect(result.kind == "sweep")
    #expect(result.filesChanged == [
      "src/lib/index.ts", "src/lib/strings/index.ts", "src/models/index.ts", "src/reports.ts",
      "src/services/index.ts", "src/services/userService.ts", "src/setup/index.ts", "src/widgets/index.ts",
      "tsconfig.json",
    ])
    #expect(try git(dir, ["log", "-1", "--format=%s"]) == "sweep(add-import-extensions): src/**\n")
    #expect(try git(dir, ["log", "-1", "--format=%B"]).contains("\nRefactor-Kind: sweep\n"))
    let tree = try readTree(dir)
    #expect(tree["src/lib/index.ts"]?.contains(#"export * from "./strings/index.ts";"#) == true)
    #expect(tree["src/reports.ts"]?.contains(#"await import("./lib/math.ts")"#) == true)
    #expect(tree["tsconfig.json"]?.contains(#""allowImportingTsExtensions": true"#) == true)
    #expect(try status(dir) == "")
    #expect(try failImage(repo: dir, image: TS, args: args).code == "NO_CHANGES")
  }

  @Test("replaying the recorded image and args on the parent gives the same tree", .timeLimit(.minutes(4)))
  func replay() throws {
    let cases: [(String, [String], (URL) throws -> Void)] = [
      (TS, RENAME, { _ in }),
      (PRETTIER, ["format", "--files", "**/*.ts"], { dir in try commitFile(dir, "ugly.ts", "const   x = {a:1}\n") }),
    ]
    for (image, args, prepare) in cases {
      let dir = try temp.repo()
      try prepare(dir)
      let first = try runImage(repo: dir, image: image, args: args)
      let recorded = try #require(parseRefactorCommand(try git(dir, ["log", "-1", "--format=%B"])))
      try git(dir, ["checkout", "-q", "--detach", first.parent])
      let replay = try runImage(repo: dir, image: recorded.image, args: recorded.args)
      #expect(replay.parent == first.parent)
      #expect(replay.image == recorded.image)
      #expect(try treeOf(dir, replay.commit) == (try treeOf(dir, first.commit)))
      #expect(try headCommit(dir) == replay.commit)
      #expect(try status(dir) == "")
    }
  }

  @Test(
    "replaying a rename after unrelated code moved above the symbol gives the same subject and summary and a different tree",
    .timeLimit(.minutes(3)))
  func replayAfterCodeMoved() throws {
    let dir = try temp.repo()
    let base = try headCommit(dir)
    let first = try runImage(repo: dir, image: TS, args: RENAME)
    let recorded = try #require(parseRefactorCommand(try git(dir, ["log", "-1", "--format=%B"])))

    // Back on the parent, unrelated code lands above `foo`; then the recorded command runs again.
    try git(dir, ["checkout", "-q", "--detach", base])
    let a = dir.appendingPathComponent("a.ts")
    try commitFile(dir, "a.ts", "export const unrelated = 1;\n\nexport function alsoUnrelated() {}\n\n" + (try readText(a)))
    let replay = try runImage(repo: dir, image: recorded.image, args: recorded.args)

    #expect(try treeOf(dir, replay.commit) != (try treeOf(dir, first.commit)))
    #expect(replay.subject == first.subject)
    #expect(replay.summary == first.summary)
    #expect(try readTree(dir)["a.ts"]?.contains("export function bar()") == true)
  }

  @Test("a partial result commits with the places it left alone in its summary", .timeLimit(.minutes(1)))
  func partial() throws {
    let dir = try temp.repo()
    let result = try runImage(repo: dir, image: PROBE, args: ["partial"], message: "why")
    #expect(result.filesChanged == ["p.txt"])
    #expect(result.kind == "rewrite")
    #expect(result.summary == "Changed p.txt.\n\nNot handled (1):\n  q.txt:3: q.txt is not handled\n    Change q.txt by hand.")
    let body = try git(dir, ["log", "-1", "--format=%B"])
    #expect(
      body.hasPrefix(
        """
        rewrite(probe): partial

        Changed p.txt.

        Not handled (1):
          q.txt:3: q.txt is not handled
            Change q.txt by hand.

        why
        """ + "\n\nRefactor-Command: "))
    #expect(
      body.trimmingCharacters(in: .newlines)
        .hasSuffix("\nRefactor-Kind: rewrite\nCo-Authored-By: codemodder <codemodder@users.noreply.github.com>"))
    #expect(try status(dir) == "")
  }

  @Test("a report with a key v1 no longer has (status) is IMAGE_FAILED and changes nothing", .timeLimit(.minutes(1)))
  func reportWithStatus() throws {
    let dir = try temp.repo()
    let before = try headCommit(dir)
    let err = try failImage(repo: dir, image: PROBE, args: ["status"])
    #expect(err.code == "IMAGE_FAILED")
    #expect(
      err.instructions.hasPrefix("The image's report is not a valid urn:jig:report:1 report: unknown field(s) status. "),
      "\(err.instructions)")
    #expect(try headCommit(dir) == before)
    #expect(try status(dir) == "")
  }

  @Test("a report without the v1 schema is IMAGE_FAILED and changes nothing", .timeLimit(.minutes(1)))
  func legacyReport() throws {
    let dir = try temp.repo()
    let before = try headCommit(dir)
    let err = try failImage(repo: dir, image: PROBE, args: ["legacy"])
    #expect(err.code == "IMAGE_FAILED")
    #expect(err.instructions.contains("this jig supports only \"urn:jig:report:1\""))
    #expect(try headCommit(dir) == before)
    #expect(try status(dir) == "")
  }

  @Test("the container sees no ignored files, no .git and no network; args are passed verbatim", .timeLimit(.minutes(1)))
  func containerSees() throws {
    let dir = try temp.repo()
    let args = ["check", "a b", "é", #""q""#]
    let result = try runImage(repo: dir, image: PROBE, args: args)
    #expect(result.filesChanged == ["probe.json"])
    let probe = try #require(try readTree(dir)["probe.json"])
    let expected: JSON = ["nodeModules": false, "git": false, "network": false, "args": ["a b", "é", #""q""#]]
    #expect(try decode(JSON.self, probe) == expected)
    #expect(parseRefactorCommand(try git(dir, ["log", "-1", "--format=%B"]))?.args == args)
  }

  @Test("logs before the JSON are fine", .timeLimit(.minutes(1)))
  func noisy() throws {
    let dir = try temp.repo()
    let result = try runImage(repo: dir, image: PROBE, args: ["noisy"])
    #expect(result.filesChanged == ["n.txt"])
    #expect(try git(dir, ["log", "-1", "--format=%s"]) == "refactor(probe): noisy\n")
    #expect(result.kind == "refactor")
    #expect(try git(dir, ["log", "-1", "--format=%B"]).contains("\nRefactor-Kind: refactor\n"))
  }

  @Test("an image error is passed through", .timeLimit(.minutes(1)))
  func imageError() throws {
    let dir = try temp.repo()
    let before = try headCommit(dir)
    let err = try failImage(repo: dir, image: PROBE, args: ["fail"])
    #expect(err.code == "SYMBOL_NOT_FOUND")
    #expect(err.instructions == "nope")
    #expect(try headCommit(dir) == before)
  }

  @Test("no JSON is IMAGE_FAILED", .timeLimit(.minutes(1)))
  func noJSON() throws {
    let dir = try temp.repo()
    let before = try headCommit(dir)
    let err = try failImage(repo: dir, image: PROBE, args: ["crash"])
    #expect(err.code == "IMAGE_FAILED")
    #expect(err.instructions.hasPrefix("The image printed no report (exit code 3); nothing was changed in the repository. "))
    #expect(err.instructions.contains(". The end of its output:\n"))
    #expect(err.instructions.contains("boom"))
    #expect(try headCommit(dir) == before)
  }

  @Test("no changes is NO_CHANGES", .timeLimit(.minutes(1)))
  func noChanges() throws {
    let dir = try temp.repo()
    #expect(try failImage(repo: dir, image: PROBE, args: ["none"]).code == "NO_CHANGES")
  }

  @Test("an edited executable keeps mode 100755", .timeLimit(.minutes(1)))
  func editedExecutable() throws {
    let dir = try temp.repo()
    try commitFile(dir, "run.sh", "#!/bin/sh\necho hi\n", mode: 0o755)
    let result = try runImage(repo: dir, image: PROBE, args: ["exec"])
    #expect(result.filesChanged == ["run.sh"])
    #expect(try git(dir, ["ls-tree", "HEAD", "run.sh"]).hasPrefix("100755 "))
    // git writes the file with 0777 minus the umask: executable for everyone it is readable by.
    #expect(try permissions(dir.appendingPathComponent("run.sh")) & 0o111 == 0o111)
    #expect(try readText(dir.appendingPathComponent("run.sh")) == "#!/bin/sh\necho hi\n# x\n")
  }

  @Test("a created executable keeps its mode", .timeLimit(.minutes(1)))
  func createdExecutable() throws {
    let dir = try temp.repo()
    let result = try runImage(repo: dir, image: PROBE, args: ["exec-new"])
    #expect(result.filesChanged == ["new.sh"])
    #expect(try git(dir, ["ls-files", "-s", "new.sh"]).hasPrefix("100755 "))
    #expect(try permissions(dir.appendingPathComponent("new.sh")) & 0o111 == 0o111)
    #expect(try status(dir) == "")
  }

  @Test("a folder replaced by a file commits", .timeLimit(.minutes(1)))
  func folderReplacedByFile() throws {
    let dir = try temp.repo()
    try commitFile(dir, "dir/x", "x\n")
    let result = try runImage(repo: dir, image: PROBE, args: ["replace-dir", "dir"])
    #expect(result.filesChanged == ["dir", "dir/x"])
    #expect(try readText(dir.appendingPathComponent("dir")) == "now a file\n")
    #expect(try git(dir, ["ls-tree", "HEAD", "dir"]).hasPrefix("100644 blob "))
    #expect(try status(dir) == "")
  }

  @Test("a cleanup failure after the commit is reported on stderr, not as a failure", .timeLimit(.minutes(1)))
  func cleanupFailure() throws {
    let dir = try temp.repo()
    let ran = try run(["--repo", dir.path, PROBE, "readonly-dir"])
    #expect(ran.output.ok)
    #expect(ran.output.commit == (try headCommit(dir)))
    let lines = ran.stderr.split(separator: "\n")
    #expect(lines.count == 1)
    let left = try #require(try leftBehind(String(lines.first ?? "")))
    try chmod(URL(fileURLWithPath: left).appendingPathComponent("ro"), 0o755)
    // The export is `<temporary folder>/workspace`; the temporary index next to it was removed.
    removeTree(URL(fileURLWithPath: left).deletingLastPathComponent())
  }

  @Test("an image subject that is empty or has a newline is IMAGE_FAILED", .timeLimit(.minutes(1)))
  func badSubject() throws {
    for subject in ["", #"one\ntwo"#, #"one\rtwo"#] {
      let dir = try temp.repo()
      let err = try failImage(repo: dir, image: PROBE, args: ["subject", subject])
      #expect(err.code == "IMAGE_FAILED")
      #expect(try status(dir) == "")
    }
  }

  @Test(
    "a created path that exists as an ignored file on the host is not committed and the host file is untouched", .timeLimit(.minutes(1)))
  func ignoredHostFile() throws {
    let dir = try temp.repo()
    let hostFile = dir.appendingPathComponent("node_modules/x.txt")
    let result = try runImage(repo: dir, image: PROBE, args: ["write", "node_modules/x.txt", "fresh.txt"])
    #expect(result.filesChanged == ["fresh.txt"])
    #expect(!(try git(dir, ["ls-tree", "-r", "--name-only", "HEAD"]).contains("node_modules")))
    #expect(try readText(hostFile) == "ignored\n")
    #expect(try status(dir) == "")

    let before = try headCommit(dir)
    let err = try failImage(repo: dir, image: PROBE, args: ["write", "node_modules/x.txt"])
    #expect(err.code == "NO_CHANGES")
    #expect(try readText(hostFile) == "ignored\n")
    #expect(try headCommit(dir) == before)
  }

  @Test("a created path under an ignored host symlink to a folder outside the repo is not committed or written", .timeLimit(.minutes(1)))
  func ignoredHostSymlink() throws {
    let dir = try temp.repo()
    try commitFile(dir, ".gitignore", "node_modules\nbuild\n")
    let outside = try temp.make("jig-outside-")
    try fm.createSymbolicLink(at: dir.appendingPathComponent("build"), withDestinationURL: outside)
    let result = try runImage(repo: dir, image: PROBE, args: ["write", "build/x", "fresh.txt"])
    #expect(result.filesChanged == ["fresh.txt"])
    #expect(!(try git(dir, ["ls-tree", "-r", "--name-only", "HEAD"]).contains("build/x")))
    #expect(try fm.contentsOfDirectory(atPath: outside.path) == [])
    #expect(try status(dir) == "")
  }

  @Test("a .gitignore change is IMAGE_FAILED", .timeLimit(.minutes(1)))
  func gitignoreChange() throws {
    let dir = try temp.repo()
    try commitFile(dir, "sub/keep.txt", "keep\n")
    let before = try headCommit(dir)
    for args in [["write", ".gitignore"], ["write", "sub/.gitignore"], ["rm", ".gitignore"], ["ignore-self", "sub"]] {
      let err = try failImage(repo: dir, image: PROBE, args: args)
      #expect(err.code == "IMAGE_FAILED")
      #expect(err.instructions.hasPrefix("the image changed a .gitignore file: "))
      #expect(try headCommit(dir) == before)
      #expect(try status(dir) == "")
    }
  }

  @Test("a .git folder created by the image is IMAGE_FAILED", .timeLimit(.minutes(1)))
  func gitFolderCreated() throws {
    let dir = try temp.repo()
    let before = try headCommit(dir)
    for path in [".git/x", "sub/.git/x", "sub/.git/HEAD"] {
      let err = try failImage(repo: dir, image: PROBE, args: ["write", path, "fresh.txt"])
      #expect(err.code == "IMAGE_FAILED")
      let folder = path[..<(path.lastIndex(of: "/") ?? path.endIndex)]
      #expect(err.instructions == "the image created a .git entry: \(folder). \(ruleBroken)")
      #expect(try headCommit(dir) == before)
      #expect(try status(dir) == "")
    }
  }

  @Test("a gitfile written by the image is rejected before git reads the repository it points at", .timeLimit(.minutes(1)))
  func gitfile() throws {
    let dir = try temp.repo()
    let before = try headCommit(dir)
    // A "repository" whose HEAD is a FIFO: any git command that opens it blocks forever.
    let outside = try temp.make("outside-repo-")
    let gitDir = outside.appendingPathComponent(".git")
    try fm.createDirectory(at: gitDir.appendingPathComponent("objects"), withIntermediateDirectories: true)
    try fm.createDirectory(at: gitDir.appendingPathComponent("refs"), withIntermediateDirectories: true)
    #expect(try runCommand(["mkfifo", gitDir.appendingPathComponent("HEAD").path]).exitCode == 0)
    let err = try failImage(repo: dir, image: PROBE, args: ["gitfile", "sub/.git", gitDir.path])
    #expect(err.code == "IMAGE_FAILED")
    #expect(err.instructions == "the image created a .git entry: sub/.git. \(ruleBroken)")
    #expect(try headCommit(dir) == before)
    #expect(try status(dir) == "")
  }

  @Test("a folder whose entries cannot be inspected is IMAGE_FAILED, not skipped", .timeLimit(.minutes(1)))
  func uninspectableFolder() throws {
    let dir = try temp.repo()
    let before = try headCommit(dir)
    let ran = try run(["--repo", dir.path, PROBE, "hidden-git"])
    #expect(!ran.output.ok)
    #expect(ran.output.code == "IMAGE_FAILED")
    #expect(ran.output.instructions?.hasPrefix("could not read what the image left at d/sub: ") == true)
    #expect(try headCommit(dir) == before)
    #expect(try status(dir) == "")
    // The host cannot remove the export without chmod either.
    if let left = try leftBehind(ran.stderr) {
      try chmod(URL(fileURLWithPath: left).appendingPathComponent("d"), 0o755)
      removeTree(URL(fileURLWithPath: left).deletingLastPathComponent())
    }
  }

  @Test("no git hooks run, post-merge included", .timeLimit(.minutes(1)))
  func noHooks() throws {
    let dir = try temp.repo()
    let marker = dir.appendingPathComponent(".git/hook-ran")
    let hook = dir.appendingPathComponent(".git/hooks/post-merge")
    try write(hook, "#!/bin/sh\ntouch '\(marker.path)'\n")
    try chmod(hook, 0o755)
    let result = try runImage(repo: dir, image: PROBE, args: ["write", "fresh.txt"])
    #expect(result.filesChanged == ["fresh.txt"])
    #expect(!fm.fileExists(atPath: marker.path))

    // The hook itself works: a plain fast-forward runs it.
    try git(dir, ["checkout", "-q", "--detach", result.parent])
    try git(dir, ["merge", "-q", "--ff-only", result.commit])
    #expect(fm.fileExists(atPath: marker.path))
  }

  @Test(".gitattributes export-ignore and export-subst do not change what the image sees or what is committed", .timeLimit(.minutes(2)))
  func gitattributes() throws {
    let dir = try temp.repo()
    try fm.createDirectory(at: dir.appendingPathComponent("docs"), withIntermediateDirectories: false)
    try write(dir.appendingPathComponent("docs/guide.md"), "# guide\n")
    try write(dir.appendingPathComponent("version.txt"), "$Format:%H$\n")
    try commitFile(dir, ".gitattributes", "docs/ export-ignore\ndocs/** export-ignore\nversion.txt export-subst\n")
    try git(dir, ["add", "-A"])
    try git(dir, ["commit", "-q", "-m", "attributes"])
    for (image, args) in [(PROBE, ["check"]), (TS, RENAME)] {
      let result = try runImage(repo: dir, image: image, args: args)
      #expect(!result.filesChanged.contains("docs/guide.md"))
      #expect(!result.filesChanged.contains("version.txt"))
      let tree = try readTree(dir)
      #expect(tree["docs/guide.md"] == "# guide\n")
      #expect(tree["version.txt"] == "$Format:%H$\n")
      #expect(try git(dir, ["show", "HEAD:version.txt"]) == "$Format:%H$\n")
    }
  }

  @Test("image-chosen names are literal paths, not pathspecs", .timeLimit(.minutes(1)))
  func literalPaths() throws {
    let dir = try temp.repo()
    let names = ["*.ts", ":(bogus)x.txt"]
    let result = try runImage(repo: dir, image: PROBE, args: ["write"] + names)
    #expect(result.filesChanged == names)
    let committed = try git(dir, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"])
      .split(separator: "\0").map(String.init)
    #expect(committed.sorted() == names.sorted())
    #expect(try status(dir) == "")
  }

  @Test("an unknown image is IMAGE_NOT_FOUND", .timeLimit(.minutes(1)))
  func unknownImage() throws {
    let dir = try temp.repo()
    let err = try failImage(repo: dir, image: "localhost/jig/nope:local", args: ["x"])
    #expect(err.code == "IMAGE_NOT_FOUND")
  }

  @Test("a pinned ID that no longer exists is IMAGE_NOT_FOUND", .timeLimit(.minutes(1)))
  func missingPinnedID() throws {
    let dir = try temp.repo()
    let err = try failImage(
      repo: dir, image: "localhost/x:local@sha256:\(String(repeating: "0", count: 64))", args: ["x"])
    #expect(err.code == "IMAGE_NOT_FOUND")
  }

  @Test("dirty tree is DIRTY_WORKTREE", .timeLimit(.minutes(1)))
  func dirtyTree() throws {
    let dir = try temp.repo()
    try write(dir.appendingPathComponent("a.ts"), "// dirty\n")
    let err = try failImage(repo: dir, image: TS, args: RENAME)
    #expect(err.code == "DIRTY_WORKTREE")
    #expect(err.instructions == "The working tree has uncommitted changes:\n M a.ts\nCommit or stash them, then run again.")

    try git(dir, ["checkout", "--", "."])
    try write(dir.appendingPathComponent("new.ts"), "export {};\n")
    let untracked = try failImage(repo: dir, image: TS, args: RENAME)
    #expect(untracked.code == "DIRTY_WORKTREE")
    #expect(untracked.instructions.contains("\n?? new.ts\n"))
  }

  @Test("edits hidden by assume-unchanged or skip-worktree are DIRTY_WORKTREE", .timeLimit(.minutes(1)))
  func hiddenEdits() throws {
    for flag in ["--assume-unchanged", "--skip-worktree"] {
      let dir = try temp.repo()
      try git(dir, ["update-index", flag, "a.ts"])
      try write(dir.appendingPathComponent("a.ts"), "// hidden edit\n")
      #expect(try status(dir) == "")
      let err = try failImage(repo: dir, image: TS, args: RENAME)
      #expect(err.code == "DIRTY_WORKTREE")
      #expect(err.instructions.contains("(assume-unchanged or skip-worktree):\na.ts\n"))
    }
  }

  @Test("cli prints the result JSON", .timeLimit(.minutes(2)))
  func cliPrintsJSON() throws {
    let dir = try temp.repo()
    let ran = try run(["--repo", dir.path, TS] + RENAME)
    #expect(ran.exitCode == 0)
    #expect(ran.output.ok)
    #expect(ran.output.commit == (try headCommit(dir)))
    #expect(ran.output.args == RENAME)
    guard case .object(let fields) = try decode(JSON.self, ran.stdout) else {
      throw TestFailure("the output is not a JSON object: \(ran.stdout)")
    }
    #expect(
      fields.keys.sorted() == ["args", "commit", "filesChanged", "image", "kind", "ok", "parent", "schema", "subject", "summary"])

    // Everything after the image goes to the image, even values that look like our own options.
    let bad = try run(["--repo", dir.path, TS] + RENAME + ["--repo", "x"])
    #expect(bad.exitCode == 1)
    #expect(!bad.output.ok)
    #expect(bad.output.code == "INVALID_ARGS")
  }
}
