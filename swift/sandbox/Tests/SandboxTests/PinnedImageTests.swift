import Testing

import Sandbox

@Test func pinnedReferencesSplitIntoNameAndId() {
  let id = "sha256:" + String(repeating: "a1", count: 32)
  #expect(PinnedImage.split("localhost/x:local@\(id)")! == ("localhost/x:local", id))
  #expect(PinnedImage.split("a@b@\(id)")! == ("a@b", id))
  #expect(PinnedImage.split("localhost/x:local") == nil)
  #expect(PinnedImage.split("@\(id)") == nil)
  #expect(PinnedImage.split("x@sha256:" + String(repeating: "A", count: 64)) == nil)
  #expect(PinnedImage.split("x@sha256:" + String(repeating: "a", count: 63)) == nil)
  #expect(PinnedImage.split("x@sha512:" + String(repeating: "a", count: 64)) == nil)
}

@Test func aPinnedImageHasNoNoteUnlessGivenOne() {
  let id = "sha256:" + String(repeating: "a1", count: 32)
  #expect(PinnedImage(id: id, reference: "x@\(id)").note == nil)
  #expect(PinnedImage(id: id, reference: "x@\(id)", note: "cached") != PinnedImage(id: id, reference: "x@\(id)"))
}
