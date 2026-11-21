import Foundation
import Report
import Testing

@testable import OCI

// Made with `gzip -n` of "The quick brown fox jumps over the lazy dog.\n" and of "Second member.\n".
let foxGzip = Data(
  base64Encoded: "H4sIAAAAAAAAAwvJSFUoLM1MzlZIKsovz1NIy69QyCrNLShWyC9LLVIoAUrnJFZVKqTkp+txAQBqzFDrLQAAAA==")!
let secondGzip = Data(base64Encoded: "H4sIAAAAAAAAAwtOTc7PS1HITc1NSi3S4wIAKgdOhA8AAAA=")!

/// Writes `data` to a temporary file, and reads it back through a `GzipReader` in pieces of `upTo`.
func gunzip(_ data: Data, upTo: Int = 5) throws -> Data {
  let file = FileManager.default.temporaryDirectory.appendingPathComponent("oci-gzip-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: file) }
  try data.write(to: file)
  var reader = try GzipReader(fileAt: file)
  var out = Data()
  while true {
    let piece = try reader.read(upTo: upTo)
    if piece.isEmpty { break }
    #expect(piece.count <= upTo)
    out += piece
  }
  #expect(try reader.read(upTo: upTo).isEmpty)
  return out
}

@Test func gzipRoundTrips() throws {
  #expect(String(decoding: try gunzip(foxGzip), as: UTF8.self) == "The quick brown fox jumps over the lazy dog.\n")
  #expect(String(decoding: try gunzip(foxGzip, upTo: 1 << 20), as: UTF8.self) == "The quick brown fox jumps over the lazy dog.\n")
}

@Test func concatenatedMembersReadAsOneStream() throws {
  #expect(
    String(decoding: try gunzip(foxGzip + secondGzip), as: UTF8.self)
      == "The quick brown fox jumps over the lazy dog.\nSecond member.\n")
}

@Test func aTruncatedFileFailsTheImage() throws {
  #expect {
    _ = try gunzip(foxGzip.prefix(foxGzip.count - 6))
  } throws: { error in
    (error as? RefactorError)?.code == .IMAGE_FAILED
  }
  #expect {
    _ = try gunzip(Data("not gzip at all".utf8))
  } throws: { error in
    (error as? RefactorError)?.code == .IMAGE_FAILED
  }
}

@Test func aLargeStreamComesOutInBoundedPieces() throws {
  let dir = FileManager.default.temporaryDirectory.appendingPathComponent("oci-gzip-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: dir) }
  // Pseudo-random bytes barely compress, so the compressed file is read in many pieces too.
  var state: UInt64 = 42
  var bytes = [UInt8](repeating: 0, count: 3_000_000)
  for index in bytes.indices {
    state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
    bytes[index] = UInt8(truncatingIfNeeded: state >> 33)
  }
  let data = Data(bytes)
  try data.write(to: dir.appendingPathComponent("big"))
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/bin/sh")
  process.arguments = ["-c", "gzip -n big"]
  process.currentDirectoryURL = dir
  try process.run()
  process.waitUntilExit()
  let gzipped = try Data(contentsOf: dir.appendingPathComponent("big.gz"))
  #expect(gzipped.count > 2_000_000)
  #expect(try gunzip(gzipped, upTo: 64 * 1024) == data)
}
