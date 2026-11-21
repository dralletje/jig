import Foundation
import Report

#if canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#endif

/// Writes a tar archive to a file handle, entry by entry: POSIX ustar headers, with a PAX extended
/// header before an entry whose path does not fit in 100 bytes or whose size does not fit in 11
/// octal digits. Regular files (from `Data`, or streamed from a file in 1 MiB pieces) and
/// directories; owner 0:0 and modification time 0, so the same input gives the same bytes.
/// `finish()` writes the end of the archive; the handle stays the caller's to close.
struct TarWriter {
  private let handle: FileHandle
  /// What is written, for errors: "the Docker archive /tmp/x.tar".
  private let name: String

  init(handle: FileHandle, name: String) {
    self.handle = handle
    self.name = name
  }

  /// A directory entry; `path` gets a `/` at its end when it has none.
  mutating func addDirectory(_ path: String, mode: UInt32 = 0o755) throws {
    let entryPath = path.hasSuffix("/") ? path : path + "/"
    try writeHeader(path: entryPath, typeflag: UInt8(ascii: "5"), mode: mode, size: 0)
  }

  /// A regular file with the content `data`.
  mutating func addFile(_ path: String, data: Data, mode: UInt32 = 0o644) throws {
    try writeHeader(path: path, typeflag: UInt8(ascii: "0"), mode: mode, size: Int64(data.count))
    try write(data)
    try write(Data(count: Int(padding(Int64(data.count)))))
  }

  /// A regular file with the content of the file at `source`, read in 1 MiB pieces: never all of it
  /// in memory. Fails when the file's length changes while it is copied.
  mutating func addFile(_ path: String, contentsOf source: URL, mode: UInt32 = 0o644) throws {
    var st = stat()
    guard stat(source.path, &st) == 0 else {
      throw RefactorError(
        code: .INTERNAL,
        instructions: "jig could not read \(source.path) to write \(name): \(String(cString: strerror(errno))). "
          + "Run again; if it fails the same way, report it as a jig bug.")
    }
    let size = Int64(st.st_size)
    let input: FileHandle
    do {
      input = try FileHandle(forReadingFrom: source)
    } catch {
      throw RefactorError(
        code: .INTERNAL,
        instructions: "jig could not open \(source.path) to write \(name): \(error). Run again; if it fails the "
          + "same way, report it as a jig bug.")
    }
    defer { try? input.close() }
    try writeHeader(path: path, typeflag: UInt8(ascii: "0"), mode: mode, size: size)
    var copied: Int64 = 0
    while true {
      let chunk: Data
      do {
        chunk = try input.read(upToCount: 1 << 20) ?? Data()
      } catch {
        throw RefactorError(
          code: .INTERNAL,
          instructions: "jig could not read \(source.path) to write \(name): \(error). Run again; if it fails "
            + "the same way, report it as a jig bug.")
      }
      if chunk.isEmpty { break }
      copied += Int64(chunk.count)
      guard copied <= size else { break }
      try write(chunk)
    }
    guard copied == size else {
      throw RefactorError(
        code: .INTERNAL,
        instructions: "\(source.path) changed while jig copied it into \(name) (\(size) bytes before, \(copied) "
          + "read). Run again; if it fails the same way, report it as a jig bug.")
    }
    try write(Data(count: Int(padding(size))))
  }

  /// The end of the archive: two blocks of zeros.
  mutating func finish() throws {
    try write(Data(count: 1024))
  }

  /// A header for `path`, after a PAX header when `path` or `size` do not fit in ustar's fields.
  private mutating func writeHeader(path: String, typeflag: UInt8, mode: UInt32, size: Int64) throws {
    let pathBytes = Array(path.utf8)
    let sizeFits = size <= 0o77777777777
    var records = ""
    if pathBytes.count > 100 { records += paxRecord("path", path) }
    if !sizeFits { records += paxRecord("size", String(size)) }
    if !records.isEmpty {
      let content = Data(records.utf8)
      // The PAX header's own name only says what it is; readers take the path from its records.
      let paxName = "PaxHeaders/" + String(decoding: pathBytes.suffix(80), as: UTF8.self)
      try write(header(name: Array(paxName.utf8).suffix(100), typeflag: UInt8(ascii: "x"), mode: 0o644, size: Int64(content.count)))
      try write(content)
      try write(Data(count: Int(padding(Int64(content.count)))))
    }
    try write(header(name: pathBytes.prefix(100), typeflag: typeflag, mode: mode, size: sizeFits ? size : 0))
  }

  /// One 512-byte ustar header.
  private func header(name: ArraySlice<UInt8>, typeflag: UInt8, mode: UInt32, size: Int64) -> Data {
    var block = [UInt8](repeating: 0, count: 512)
    block.replaceSubrange(0..<name.count, with: name)
    putOctal(&block, 100, 8, Int64(mode & 0o7777))
    putOctal(&block, 108, 8, 0)
    putOctal(&block, 116, 8, 0)
    putOctal(&block, 124, 12, size)
    putOctal(&block, 136, 12, 0)
    block[156] = typeflag
    block.replaceSubrange(257..<263, with: Array("ustar\0".utf8))
    block.replaceSubrange(263..<265, with: Array("00".utf8))
    // The checksum is computed with its own field as spaces: six octal digits, a NUL, a space.
    block.replaceSubrange(148..<156, with: Array("        ".utf8))
    var sum = 0
    for byte in block { sum += Int(byte) }
    let digits = Array(String(sum, radix: 8).utf8)
    let field = [UInt8](repeating: UInt8(ascii: "0"), count: 6 - digits.count) + digits + [0, UInt8(ascii: " ")]
    block.replaceSubrange(148..<156, with: field)
    return Data(block)
  }

  /// `value` as `length - 1` octal digits (zero-padded) and a NUL.
  private func putOctal(_ block: inout [UInt8], _ start: Int, _ length: Int, _ value: Int64) {
    let digits = Array(String(value, radix: 8).utf8)
    let field = [UInt8](repeating: UInt8(ascii: "0"), count: length - 1 - digits.count) + digits + [0]
    block.replaceSubrange(start..<(start + length), with: field)
  }

  /// A PAX record, `<length> <key>=<value>\n`, where `<length>` counts the whole record, itself too.
  private func paxRecord(_ key: String, _ value: String) -> String {
    let rest = " \(key)=\(value)\n"
    var length = rest.utf8.count + 1
    while String(length).utf8.count + rest.utf8.count != length {
      length = String(length).utf8.count + rest.utf8.count
    }
    return String(length) + rest
  }

  private func padding(_ size: Int64) -> Int64 {
    (512 - size % 512) % 512
  }

  private func write(_ data: Data) throws {
    if data.isEmpty { return }
    do {
      try handle.write(contentsOf: data)
    } catch {
      throw RefactorError(
        code: .INTERNAL,
        instructions: "jig could not write \(name): \(error). Check that the disk is not full, then run again.")
    }
  }
}
