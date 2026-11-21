import Foundation
import Report

/// One entry of a tar archive, as `TarReader` reads it. `path` and `linkTarget` are exactly what the
/// archive says (not checked, not made relative): the unpacker decides what they may mean.
struct TarEntry: Equatable {
  enum Kind: Equatable {
    case file
    case directory
    case symlink
    case hardLink
    /// Devices, FIFOs, sparse files and anything else: read past, never unpacked.
    case other
  }

  var path: String
  var kind: Kind
  /// The permission bits of the header (`0o7777` at most).
  var mode: UInt32
  /// The bytes of content that follow the header (a file's data).
  var size: Int64
  /// A symlink's target, or a hard link's path in the archive; empty for other kinds.
  var linkTarget: String
}

/// Reads a tar archive from a byte source in pieces, so an archive of any size needs only small
/// buffers: ustar, PAX extended headers (`path`, `linkpath`, `size`) and GNU long names (`L`, `K`).
/// After `next()` gives an entry, `readContent(upTo:)` gives its content; `next()` skips what is left.
struct TarReader {
  /// The next bytes of the archive, up to the count asked for; empty at its end.
  private let source: (Int) throws -> Data
  /// What the archive is, for errors: "the image's layer sha256:…".
  private let name: String
  /// Bytes read from `source` and not used yet: `buffer[offset...]`.
  private var buffer = Data()
  private var offset = 0
  /// Content of the current entry not read yet, and the padding after it to the next 512 bytes.
  private var contentLeft: Int64 = 0
  private var paddingLeft: Int64 = 0
  private var ended = false

  init(name: String, source: @escaping (Int) throws -> Data) {
    self.name = name
    self.source = source
  }

  /// The next entry, or nil at the end of the archive.
  mutating func next() throws -> TarEntry? {
    if ended { return nil }
    try skip(contentLeft + paddingLeft)
    contentLeft = 0
    paddingLeft = 0
    var paxPath: String?
    var paxLinkPath: String?
    var paxSize: Int64?
    var longName: String?
    var longLink: String?
    while true {
      guard let header = try readHeader() else {
        ended = true
        return nil
      }
      let typeflag = header[156]
      let headerSize = try number(header, 124, 12, field: "size")
      guard headerSize >= 0 else { throw invalid("an entry has a negative size") }
      // No layer has an entry of 1 TiB; the bound also keeps a size plus its padding from overflowing.
      guard headerSize <= 1 << 40 else { throw invalid("an entry is larger than 1 TiB") }
      // PAX headers, GNU long names and global headers describe the next entry: read them, go on.
      if typeflag == UInt8(ascii: "x") {
        let records = try readSmallContent(headerSize, what: "a PAX header")
        for (key, value) in try paxRecords(records) {
          if key == "path" { paxPath = value }
          if key == "linkpath" { paxLinkPath = value }
          if key == "size" {
            guard let size = Int64(value), size >= 0 else { throw invalid("a PAX size is not a number: \(value)") }
            guard size <= 1 << 40 else { throw invalid("an entry is larger than 1 TiB") }
            paxSize = size
          }
        }
        continue
      }
      if typeflag == UInt8(ascii: "g") {
        try skip(headerSize + padding(headerSize))
        continue
      }
      if typeflag == UInt8(ascii: "L") {
        longName = cString(try readSmallContent(headerSize, what: "a GNU long name"))
        continue
      }
      if typeflag == UInt8(ascii: "K") {
        longLink = cString(try readSmallContent(headerSize, what: "a GNU long link name"))
        continue
      }

      var path = cString(header[0..<100])
      let magic = header[257..<263]
      // POSIX ustar ("ustar\0") splits long names over `prefix` and `name`. GNU's old format
      // ("ustar  \0") uses those bytes for other things.
      if magic.elementsEqual("ustar\0".utf8) {
        let prefix = cString(header[345..<500])
        if !prefix.isEmpty { path = prefix + "/" + path }
      }
      if let longName { path = longName }
      if let paxPath { path = paxPath }
      var linkTarget = cString(header[157..<257])
      if let longLink { linkTarget = longLink }
      if let paxLinkPath { linkTarget = paxLinkPath }
      let size = paxSize ?? headerSize

      var kind = TarEntry.Kind.other
      if typeflag == UInt8(ascii: "0") || typeflag == 0 || typeflag == UInt8(ascii: "7") {
        // An old (pre-POSIX) archive marks a directory only by the `/` at the end of its name.
        kind = typeflag == 0 && path.hasSuffix("/") ? .directory : .file
      }
      if typeflag == UInt8(ascii: "1") { kind = .hardLink }
      if typeflag == UInt8(ascii: "2") { kind = .symlink }
      if typeflag == UInt8(ascii: "5") { kind = .directory }
      if kind != .symlink && kind != .hardLink { linkTarget = "" }

      let mode = UInt32(truncatingIfNeeded: try number(header, 100, 8, field: "mode")) & 0o7777
      contentLeft = size
      paddingLeft = padding(size)
      return TarEntry(path: path, kind: kind, mode: mode, size: size, linkTarget: linkTarget)
    }
  }

  /// Up to `upTo` bytes of the current entry's content; empty when all of it is read.
  mutating func readContent(upTo count: Int) throws -> Data {
    if contentLeft == 0 || count <= 0 { return Data() }
    let want = Int(min(Int64(count), contentLeft))
    if offset == buffer.count {
      buffer = try source(max(want, 64 * 1024))
      offset = 0
      if buffer.isEmpty { throw invalid("the archive ends inside an entry") }
    }
    let take = min(want, buffer.count - offset)
    let start = buffer.startIndex + offset
    let piece = buffer.subdata(in: start..<(start + take))
    offset += take
    contentLeft -= Int64(take)
    return piece
  }

  /// The next 512-byte header, or nil at the end: a block of zeros, or the archive ending where a
  /// header would start.
  private mutating func readHeader() throws -> Data? {
    if try !fill(512) {
      if offset == buffer.count { return nil }
      throw invalid("the archive ends inside a header")
    }
    let start = buffer.startIndex + offset
    let header = buffer.subdata(in: start..<(start + 512))
    offset += 512
    if header.allSatisfy({ $0 == 0 }) { return nil }
    let stored = try number(header, 148, 8, field: "checksum")
    var unsigned: Int64 = 0
    var signed: Int64 = 0
    for (index, byte) in header.enumerated() {
      let value = index >= 148 && index < 156 ? UInt8(ascii: " ") : byte
      unsigned += Int64(value)
      signed += Int64(Int8(bitPattern: value))
    }
    guard stored == unsigned || stored == signed else { throw invalid("a header's checksum is wrong") }
    return header
  }

  /// The content of a PAX header or GNU long name: at most 1 MiB, so names cannot use up memory.
  private mutating func readSmallContent(_ size: Int64, what: String) throws -> Data {
    guard size <= 1024 * 1024 else { throw invalid("\(what) is larger than 1 MiB") }
    let count = Int(size)
    guard try fill(count) else { throw invalid("the archive ends inside \(what)") }
    let start = buffer.startIndex + offset
    let content = buffer.subdata(in: start..<(start + count))
    offset += count
    try skip(padding(size))
    return content
  }

  /// Makes `buffer` hold at least `count` unread bytes; false when the archive ends first.
  private mutating func fill(_ count: Int) throws -> Bool {
    while buffer.count - offset < count {
      let more = try source(max(count, 64 * 1024))
      if more.isEmpty { return false }
      buffer = buffer.subdata(in: (buffer.startIndex + offset)..<buffer.endIndex) + more
      offset = 0
    }
    return true
  }

  /// Reads past `count` bytes.
  private mutating func skip(_ count: Int64) throws {
    var left = count
    while left > 0 {
      if offset == buffer.count {
        buffer = try source(Int(min(left, 1024 * 1024)))
        offset = 0
        if buffer.isEmpty { throw invalid("the archive ends inside an entry") }
      }
      let take = Int(min(left, Int64(buffer.count - offset)))
      offset += take
      left -= Int64(take)
    }
  }

  private func padding(_ size: Int64) -> Int64 {
    (512 - size % 512) % 512
  }

  /// A numeric header field: octal digits (spaces and NULs around them), or GNU's base-256 when the
  /// first byte has its high bit set.
  private func number(_ header: Data, _ start: Int, _ length: Int, field: String) throws -> Int64 {
    let bytes = Array(header[(header.startIndex + start)..<(header.startIndex + start + length)])
    if bytes[0] & 0x80 != 0 {
      guard bytes[0] & 0x40 == 0 else { throw invalid("a header's \(field) is negative") }
      var value: Int64 = Int64(bytes[0] & 0x3f)
      for byte in bytes.dropFirst() {
        guard value <= (Int64.max >> 8) else { throw invalid("a header's \(field) is too large") }
        value = value << 8 | Int64(byte)
      }
      return value
    }
    var value: Int64 = 0
    var started = false
    for byte in bytes {
      if byte == 0 || byte == UInt8(ascii: " ") {
        if started { break }
        continue
      }
      guard byte >= UInt8(ascii: "0") && byte <= UInt8(ascii: "7") else {
        throw invalid("a header's \(field) is not an octal number")
      }
      guard value <= (Int64.max >> 3) else { throw invalid("a header's \(field) is too large") }
      value = value << 3 | Int64(byte - UInt8(ascii: "0"))
      started = true
    }
    return value
  }

  /// PAX records: `<length> <key>=<value>\n`, one after another.
  private func paxRecords(_ data: Data) throws -> [(String, String)] {
    let bytes = Array(data)
    var records: [(String, String)] = []
    var index = 0
    while index < bytes.count {
      guard let space = bytes[index...].firstIndex(of: UInt8(ascii: " ")),
        let length = Int(String(decoding: bytes[index..<space], as: UTF8.self)),
        // Compared with what is left, not added to `index`: a huge length must not overflow.
        length > space - index + 1, length <= bytes.count - index, bytes[index + length - 1] == UInt8(ascii: "\n"),
        let equals = bytes[(space + 1)..<(index + length)].firstIndex(of: UInt8(ascii: "="))
      else {
        throw invalid("a PAX header is malformed")
      }
      let key = String(decoding: bytes[(space + 1)..<equals], as: UTF8.self)
      let value = String(decoding: bytes[(equals + 1)..<(index + length - 1)], as: UTF8.self)
      records.append((key, value))
      index += length
    }
    return records
  }

  /// The text up to the first NUL.
  private func cString(_ bytes: Data) -> String {
    String(decoding: bytes.prefix(while: { $0 != 0 }), as: UTF8.self)
  }

  private func invalid(_ reason: String) -> RefactorError {
    RefactorError(
      code: .IMAGE_FAILED,
      instructions: "\(name) is not a valid tar archive: \(reason). The image is broken; use another image or tag.")
  }
}
