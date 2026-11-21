// The export the image sees in /workspace, and what is captured from it.
import Foundation
import Testing

/// Every tracked regular file of the repo's HEAD, as base64: what the image must see.
private func headFiles(_ dir: URL) throws -> [String: String] {
  var out: [String: String] = [:]
  for line in try git(dir, ["ls-files", "-s", "-z"]).split(separator: "\0") {
    guard let tab = line.firstIndex(of: "\t") else { continue }
    let path = String(line[line.index(after: tab)...])
    if !line.hasPrefix("100") { continue }
    out[path] = try Data(contentsOf: dir.appendingPathComponent(path)).base64EncodedString()
  }
  return out
}

/// What the probe saw in `/workspace`, from the `tree.json` it committed.
private func seen(_ dir: URL) throws -> [String: String] {
  try decode([String: String].self, try git(dir, ["show", "HEAD:tree.json"]))
}

private func base64Text(_ value: String?) -> String? {
  value.flatMap { Data(base64Encoded: $0) }.map { String(decoding: $0, as: UTF8.self) }
}

@Suite(
  "the export the image sees, and what is captured (docker)", .serialized,
  .enabled(if: dockerAvailable, dockerMissing), .builtOnce)
struct ExportTests {
  let temp = TempDirs()

  @Test("ignores export-ignore and export-subst, and leaves the repo's index alone when nothing changes", .timeLimit(.minutes(1)))
  func exportAttributes() throws {
    let dir = try temp.fixture("simple")
    try fm.createDirectory(at: dir.appendingPathComponent("docs"), withIntermediateDirectories: false)
    try write(dir.appendingPathComponent("docs/guide.md"), "# guide\n")
    try write(dir.appendingPathComponent("version.txt"), "$Format:%H$\n")
    try write(
      dir.appendingPathComponent(".gitattributes"),
      "docs/ export-ignore\ndocs/** export-ignore\nversion.txt export-subst\n")
    try git(dir, ["add", "-A"])
    try git(dir, ["commit", "-q", "-m", "attributes"])
    let indexFile = dir.appendingPathComponent(".git/index")
    let index = try Data(contentsOf: indexFile)
    #expect(try failImage(repo: dir, image: PROBE, args: ["none"]).code == "NO_CHANGES")
    #expect(try Data(contentsOf: indexFile) == index)

    let expected = try headFiles(dir)
    _ = try runImage(repo: dir, image: PROBE, args: ["tree"])
    let files = try seen(dir)
    #expect(base64Text(files["docs/guide.md"]) == "# guide\n")
    #expect(base64Text(files["version.txt"]) == "$Format:%H$\n")
    #expect(files == expected)
  }

  @Test("holds the files of HEAD only: no .git, no ignored files", .timeLimit(.minutes(1)))
  func headOnly() throws {
    let dir = try temp.repo()
    let expected = try headFiles(dir)
    #expect(expected["node_modules/x.txt"] == nil)
    _ = try runImage(repo: dir, image: PROBE, args: ["tree"])
    #expect(try seen(dir) == expected)
  }

  @Test("modified, created and deleted files are committed and written into the repo", .timeLimit(.minutes(1)))
  func mix() throws {
    let dir = try temp.repo()
    let result = try runImage(repo: dir, image: PROBE, args: ["mix"])
    #expect(result.filesChanged == ["a.ts", "b.ts", "new/deep/n.ts"])
    let tree = try readTree(dir)
    #expect(tree["a.ts"] == "// changed\n")
    #expect(tree["new/deep/n.ts"] == "export {};\n")
    #expect(tree["b.ts"] == nil)
    #expect(try status(dir) == "")
  }

  @Test("an untouched binary file is exported byte for byte and not reported", .timeLimit(.minutes(1)))
  func binaryFile() throws {
    let dir = try temp.fixture("simple")
    let bytes = Data([0xff, 0x00, 0xfe])
    try bytes.write(to: dir.appendingPathComponent("bin.dat"))
    try git(dir, ["add", "bin.dat"])
    try git(dir, ["commit", "-q", "-m", "binary"])
    let result = try runImage(repo: dir, image: PROBE, args: ["tree"])
    #expect(result.filesChanged == ["tree.json"])
    #expect(try seen(dir)["bin.dat"] == bytes.base64EncodedString())
    #expect(try Data(contentsOf: dir.appendingPathComponent("bin.dat")) == bytes)
  }

  @Test("a gitlink survives unchanged, also when the image removes its empty folder", .timeLimit(.minutes(1)))
  func gitlink() throws {
    let dir = try temp.fixture("simple")
    let head = try headCommit(dir)
    try git(dir, ["update-index", "--add", "--cacheinfo", "160000,\(head),sub"])
    try git(dir, ["commit", "-q", "-m", "gitlink"])
    // An uninitialized submodule: an empty folder in the work tree.
    try fm.createDirectory(at: dir.appendingPathComponent("sub"), withIntermediateDirectories: false)
    #expect(try status(dir) == "")
    let gitlink = try git(dir, ["ls-tree", "HEAD", "sub"])
    #expect(gitlink.hasPrefix("160000 commit "))

    let result = try runImage(repo: dir, image: PROBE, args: ["write", "fresh.txt"])
    #expect(result.filesChanged == ["fresh.txt"])
    #expect(try git(dir, ["ls-tree", "HEAD", "sub"]) == gitlink)

    #expect(try failImage(repo: dir, image: PROBE, args: ["rm", "sub"]).code == "NO_CHANGES")

    let removed = try runImage(repo: dir, image: PROBE, args: ["rm", "sub", "a.ts"])
    #expect(removed.filesChanged == ["a.ts"])
    #expect(try git(dir, ["ls-tree", "HEAD", "sub"]) == gitlink)
  }
}
