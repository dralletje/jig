import Foundation
import Testing

@testable import Git
import Report

// MARK: - Git environment and exact paths

@Test func gitEnvironmentDropsEveryInheritedGitVariable() {
  let base = [
    "PATH": "/bin", "HOME": "/home/x", "GIT_DIR": "/elsewhere", "GIT_WORK_TREE": "/w", "GIT_INDEX_FILE": "/i",
    "GIT_OBJECT_DIRECTORY": "/o", "GIT_ALTERNATE_OBJECT_DIRECTORIES": "/a", "GIT_COMMON_DIR": "/c",
    "GIT_CONFIG_PARAMETERS": "'core.hooksPath'='/x'", "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "k",
    "GIT_CONFIG_VALUE_0": "v", "GIT_NAMESPACE": "n", "GIT_CEILING_DIRECTORIES": "/", "MY_GIT_THING": "kept",
  ]
  let env = gitEnvironment(base: base, explicit: ["GIT_INDEX_FILE": "/tmp/index", "GIT_DIR": "/repo/.git"])
  #expect(
    env == [
      "PATH": "/bin", "HOME": "/home/x", "MY_GIT_THING": "kept", "GIT_INDEX_FILE": "/tmp/index", "GIT_DIR": "/repo/.git",
      "GIT_OPTIONAL_LOCKS": "0",
    ])
}

@Test func pathsAreKeptAndComparedAsExactBytes() throws {
  let composed = GitPath("é.ts")
  let decomposed = GitPath("e\u{301}.ts")
  #expect("é.ts" == "e\u{301}.ts")  // Swift strings compare by canonical equivalence...
  #expect(composed != decomposed)  // ...paths do not.
  #expect(Set([composed, decomposed]).count == 2)
  #expect(GitPath("a/b/.gitignore").isNamed(".gitignore"))
  #expect(!GitPath("a/b.gitignore").isNamed(".gitignore"))
  #expect(GitPath("sub/x").isInside(GitPath("sub")))
  #expect(!GitPath("subx").isInside(GitPath("sub")))
  #expect(GitPath("Z") < GitPath("a") && GitPath("a/c") < GitPath("a0"))
}

@Test func nonUTF8PathsAreRefusedNotDecodedLossily() throws {
  let record: [UInt8] = Array("100644 blob 0123abcd\t".utf8) + [0x62, 0xff, 0x5c]
  let entry = try #require(TreeEntry(lsTreeRecord: record))
  #expect(entry.path.bytes == [0x62, 0xff, 0x5c])
  #expect(entry.path.utf8 == nil)
  #expect(entry.path.description == #"b\xff\x5c"#)
  #expect(throws: NonUTF8Path.self) { try nulSeparatedPaths(Data([0x61, 0, 0x62, 0xfe, 0])) }
  #expect(try nulSeparatedPaths(Data("a\0é\0".utf8)).map(\.description) == ["a", "é"])
  #expect(RefactorError.from(NonUTF8Path(path: entry.path)).code == .DIRTY_WORKTREE)
}

@Test func changedAttributesFindsAddedRemovedAndChanged() {
  let before: [GitPath: AttributesEntry] = [
    GitPath(".gitattributes"): .file(Data("* text\n".utf8), executable: false),
    GitPath("a/.gitattributes"): .file(Data("x\n".utf8), executable: false),
    GitPath("b/.gitattributes"): .file(Data("y\n".utf8), executable: false),
  ]
  var after = before
  after[GitPath("a/.gitattributes")] = .file(Data("x\n".utf8), executable: true)
  after[GitPath("b/.gitattributes")] = nil
  after[GitPath("c/.gitattributes")] = .symlink(Array("../x".utf8))
  #expect(changedAttributes(before: before, after: before) == [])
  #expect(
    changedAttributes(before: before, after: after)
      == [GitPath("a/.gitattributes"), GitPath("b/.gitattributes"), GitPath("c/.gitattributes")])
}
