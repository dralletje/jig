import Foundation
import Testing

@testable import Git

@Test func lsTreeRecordsKeepPathsWithSpacesAndTabs() {
  let entry = TreeEntry(lsTreeRecord: "100755 blob 0123abcd\twith space\tand tab.sh")
  #expect(entry == TreeEntry(lsTreeRecord: "100755 blob 0123abcd\twith space\tand tab.sh"))
  #expect(entry?.mode == "100755")
  #expect(entry?.type == "blob")
  #expect(entry?.object == "0123abcd")
  #expect(entry?.path == GitPath("with space\tand tab.sh"))
  #expect(TreeEntry(lsTreeRecord: "160000 commit abc\tsub")?.mode == TreeEntry.gitlinkMode)
  #expect(TreeEntry(lsTreeRecord: "no tab here") == nil)
}

@Test func pathsSortByBytesLikeGit() {
  #expect(sortedPaths(["b", "a/c", "a.b", "a0", "é", "Z"]) == ["Z", "a.b", "a/c", "a0", "b", "é"])
}

@Test func nulSeparatedDropsTheTrailingTerminator() {
  #expect(nulSeparated(Data("a\0b c\0".utf8)) == [Array("a".utf8), Array("b c".utf8)])
  #expect(nulSeparated(Data()) == [])
}

@Test func mergeRefusalIsDirtyWorktreeOnlyWhenTheRepoChanged() {
  #expect(mergeRefusalCode(headMoved: true, dirty: false) == .DIRTY_WORKTREE)
  #expect(mergeRefusalCode(headMoved: false, dirty: true) == .DIRTY_WORKTREE)
  #expect(mergeRefusalCode(headMoved: false, dirty: false) == .IMAGE_FAILED)
}
