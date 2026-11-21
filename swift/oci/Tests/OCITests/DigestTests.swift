import Foundation
import Testing

@testable import OCI

@Test func sha256OfKnownInputs() {
  #expect(
    SHA256Hasher.digest(Data()).description
      == "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  #expect(
    SHA256Hasher.digest(Data("abc".utf8)).description
      == "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  // Two blocks: the padding does not fit in the first one.
  #expect(
    SHA256Hasher.digest(Data("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq".utf8)).description
      == "sha256:248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1")
}

@Test func sha256FedInSmallChunks() {
  var hasher = SHA256Hasher()
  let chunk = Data(repeating: UInt8(ascii: "a"), count: 7)
  var left = 1_000_000
  while left > 0 {
    let count = min(7, left)
    hasher.update(chunk.prefix(count))
    left -= count
  }
  #expect(
    hasher.finalize().description
      == "sha256:cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0")
}

@Test func sha256OfAFile() throws {
  let file = FileManager.default.temporaryDirectory.appendingPathComponent("oci-digest-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: file) }
  // Over one 1 MiB chunk, so the file is read in more than one piece.
  let data = Data(repeating: UInt8(ascii: "a"), count: 1_000_000) + Data(repeating: UInt8(ascii: "a"), count: 1_000_000)
  try data.write(to: file)
  #expect(try SHA256Hasher.digest(fileAt: file) == SHA256Hasher.digest(data))
}

@Test func digestsParseOnlyLowercaseSHA256() throws {
  let hex = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  let digest = try #require(Digest("sha256:\(hex)"))
  #expect(digest.hex == hex)
  #expect(digest.description == "sha256:\(hex)")
  #expect(Digest("sha256:\(hex.uppercased())") == nil)
  #expect(Digest("sha512:\(hex)") == nil)
  #expect(Digest("sha256:\(hex.dropLast())") == nil)
  #expect(Digest("sha256:\(hex)0") == nil)
  #expect(Digest(hex) == nil)
  #expect(Digest("sha256:\(hex.dropLast())g") == nil)
}

@Test func digestsAreCodableAsTheirString() throws {
  let digest = try #require(Digest("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"))
  let json = try JSONEncoder().encode([digest])
  #expect(String(decoding: json, as: UTF8.self) == #"["sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"]"#)
  #expect(try JSONDecoder().decode([Digest].self, from: json) == [digest])
  #expect(throws: DecodingError.self) { try JSONDecoder().decode([Digest].self, from: Data(#"["sha256:abc"]"#.utf8)) }
}
