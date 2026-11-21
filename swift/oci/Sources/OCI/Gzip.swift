import CZlib
import Foundation
import Report

/// Reads the uncompressed bytes of a gzip file in pieces, so a layer of any size needs only small
/// buffers. Several gzip members one after another (as `cat a.gz b.gz` makes) read as one stream.
/// Damaged or cut-off data throws `IMAGE_FAILED`: the file is an image's layer.
public struct GzipReader {
  private let inflater: Inflater

  public init(fileAt url: URL) throws {
    inflater = try Inflater(url)
  }

  /// Up to `upTo` uncompressed bytes; empty at the end of the stream.
  public mutating func read(upTo count: Int) throws -> Data {
    try inflater.read(upTo: count)
  }
}

/// The zlib state, at a fixed address (zlib checks that it does not move), and the file it reads.
private final class Inflater {
  let url: URL
  let file: FileHandle
  let stream: UnsafeMutablePointer<z_stream>
  /// Compressed bytes read from `file`, of which `stream.avail_in` are not inflated yet.
  let input: UnsafeMutablePointer<UInt8>
  let inputCapacity = 64 * 1024
  /// The file has no more bytes to read.
  var fileEnded = false
  /// The last member ended and nothing follows it.
  var finished = false

  init(_ url: URL) throws {
    self.url = url
    file = try FileHandle(forReadingFrom: url)
    input = .allocate(capacity: inputCapacity)
    stream = .allocate(capacity: 1)
    stream.initialize(to: z_stream())
    // 16 + MAX_WBITS: a gzip header and trailer around the deflate data, not zlib's own.
    let status = inflateInit2_(stream, 16 + MAX_WBITS, zlibVersion(), Int32(MemoryLayout<z_stream>.size))
    guard status == Z_OK else {
      input.deallocate()
      stream.deallocate()
      try? file.close()
      throw RefactorError(
        code: .INTERNAL,
        instructions: "jig could not start zlib (inflateInit2 returned \(status)). Run again; if it fails "
          + "the same way, report it as a jig bug.")
    }
  }

  deinit {
    inflateEnd(stream)
    stream.deinitialize(count: 1)
    stream.deallocate()
    input.deallocate()
    try? file.close()
  }

  func read(upTo count: Int) throws -> Data {
    if finished || count <= 0 { return Data() }
    var out = Data(count: count)
    let produced = try out.withUnsafeMutableBytes { (buffer: UnsafeMutableRawBufferPointer) -> Int in
      stream.pointee.next_out = buffer.baseAddress!.assumingMemoryBound(to: UInt8.self)
      stream.pointee.avail_out = UInt32(count)
      while stream.pointee.avail_out > 0 {
        if stream.pointee.avail_in == 0 && !fileEnded {
          try refill()
        }
        let before = stream.pointee.avail_out
        let status = inflate(stream, Z_NO_FLUSH)
        if status == Z_STREAM_END {
          // One member is done; another may follow it.
          if stream.pointee.avail_in == 0 && !fileEnded {
            try refill()
          }
          if stream.pointee.avail_in == 0 {
            finished = true
            break
          }
          let reset = inflateReset(stream)
          guard reset == Z_OK else { throw damaged("inflateReset returned \(reset)") }
          continue
        }
        if status == Z_OK {
          continue
        }
        if status == Z_BUF_ERROR {
          // No progress: either more input is needed and there is none, or the output is full.
          if stream.pointee.avail_in == 0 && fileEnded {
            throw damaged("the data ends before the end of the gzip stream")
          }
          if stream.pointee.avail_out == before && stream.pointee.avail_in > 0 {
            throw damaged("zlib made no progress")
          }
          continue
        }
        let message = stream.pointee.msg.map { String(cString: $0) } ?? "zlib error \(status)"
        throw damaged(message)
      }
      return count - Int(stream.pointee.avail_out)
    }
    stream.pointee.next_out = nil
    stream.pointee.avail_out = 0
    return out.prefix(produced)
  }

  /// The next compressed bytes from the file into `input`; at its end, `fileEnded`.
  private func refill() throws {
    guard let chunk = try file.read(upToCount: inputCapacity), !chunk.isEmpty else {
      fileEnded = true
      return
    }
    chunk.copyBytes(to: input, count: chunk.count)
    stream.pointee.next_in = input
    stream.pointee.avail_in = UInt32(chunk.count)
  }

  private func damaged(_ reason: String) -> RefactorError {
    RefactorError(
      code: .IMAGE_FAILED,
      instructions: "An image layer is not valid gzip (\(url.path)): \(reason). The image is broken; "
        + "use another image or tag.")
  }
}
