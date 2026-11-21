import Foundation

/// A content digest, `sha256:<64 lowercase hex>`: how registries, the store and the commit name a
/// manifest or a blob. Other algorithms are not accepted (registries use SHA-256 throughout).
public struct Digest: Hashable, Sendable, CustomStringConvertible, Codable {
  /// The 64 lowercase hex digits after `sha256:`.
  public let hex: String

  /// The digest in `text`, or nil when it is not exactly `sha256:` and 64 lowercase hex digits.
  public init?(_ text: String) {
    guard text.hasPrefix("sha256:") else { return nil }
    let hex = text.dropFirst("sha256:".count)
    guard hex.utf8.count == 64 else { return nil }
    guard hex.utf8.allSatisfy({ ($0 >= UInt8(ascii: "0") && $0 <= UInt8(ascii: "9")) || ($0 >= UInt8(ascii: "a") && $0 <= UInt8(ascii: "f")) }) else {
      return nil
    }
    self.hex = String(hex)
  }

  public var description: String { "sha256:\(hex)" }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    let text = try container.decode(String.self)
    guard let digest = Digest(text) else {
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "not a sha256 digest: \(text)")
    }
    self = digest
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(description)
  }
}

/// SHA-256 (FIPS 180-4), fed in pieces: `update` as the bytes arrive, `finalize` once at the end. Our
/// own, so the static binary needs no crypto package.
public struct SHA256Hasher {
  private var state: [UInt32] = [
    0x6a09_e667, 0xbb67_ae85, 0x3c6e_f372, 0xa54f_f53a, 0x510e_527f, 0x9b05_688c, 0x1f83_d9ab, 0x5be0_cd19,
  ]
  /// Bytes of an unfinished 64-byte block.
  private var pending: [UInt8] = []
  /// All bytes given so far.
  private var length: UInt64 = 0

  public init() {
    pending.reserveCapacity(64)
  }

  public mutating func update(_ data: Data) {
    length += UInt64(data.count)
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      var bytes = raw[...]
      // Fill the pending block first.
      if !pending.isEmpty {
        let take = min(64 - pending.count, bytes.count)
        pending.append(contentsOf: bytes.prefix(take))
        bytes = bytes.dropFirst(take)
        if pending.count < 64 { return }
        // A copy: `compress` changes `self`, so it cannot read from `self.pending` meanwhile.
        let block = pending
        block.withUnsafeBytes { block in compress(block) }
        pending.removeAll(keepingCapacity: true)
      }
      // Whole blocks straight from the input.
      while bytes.count >= 64 {
        compress(UnsafeRawBufferPointer(rebasing: bytes.prefix(64)))
        bytes = bytes.dropFirst(64)
      }
      pending.append(contentsOf: bytes)
    }
  }

  /// The digest of everything given to `update`. The hasher is used up afterwards.
  public mutating func finalize() -> Digest {
    let bitLength = length &* 8
    var tail = pending
    tail.append(0x80)
    while tail.count % 64 != 56 { tail.append(0) }
    for shift in stride(from: 56, through: 0, by: -8) {
      tail.append(UInt8(truncatingIfNeeded: bitLength >> UInt64(shift)))
    }
    tail.withUnsafeBytes { raw in
      var offset = 0
      while offset < raw.count {
        compress(UnsafeRawBufferPointer(rebasing: raw[offset..<offset + 64]))
        offset += 64
      }
    }
    pending.removeAll()
    let digits = Array("0123456789abcdef".utf8)
    var hex: [UInt8] = []
    hex.reserveCapacity(64)
    for word in state {
      for shift in stride(from: 28, through: 0, by: -4) {
        hex.append(digits[Int((word >> UInt32(shift)) & 0xf)])
      }
    }
    return Digest("sha256:" + String(decoding: hex, as: UTF8.self))!
  }

  /// The digest of `data`.
  public static func digest(_ data: Data) -> Digest {
    var hasher = SHA256Hasher()
    hasher.update(data)
    return hasher.finalize()
  }

  /// The digest of the file at `fileAt`, read in 1 MiB pieces (layers can be large).
  public static func digest(fileAt url: URL) throws -> Digest {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = SHA256Hasher()
    while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
      hasher.update(chunk)
    }
    return hasher.finalize()
  }

  /// One 64-byte block into `state`.
  private mutating func compress(_ block: UnsafeRawBufferPointer) {
    // On the stack: this runs once per 64 bytes of every layer.
    withUnsafeTemporaryAllocation(of: UInt32.self, capacity: 64) { w in
      compress(block, schedule: w)
    }
  }

  private mutating func compress(_ block: UnsafeRawBufferPointer, schedule w: UnsafeMutableBufferPointer<UInt32>) {
    for index in 0..<16 {
      w[index] =
        UInt32(block[index * 4]) << 24 | UInt32(block[index * 4 + 1]) << 16 | UInt32(block[index * 4 + 2]) << 8
        | UInt32(block[index * 4 + 3])
    }
    for index in 16..<64 {
      let s0 = rotateRight(w[index - 15], 7) ^ rotateRight(w[index - 15], 18) ^ (w[index - 15] >> 3)
      let s1 = rotateRight(w[index - 2], 17) ^ rotateRight(w[index - 2], 19) ^ (w[index - 2] >> 10)
      w[index] = w[index - 16] &+ s0 &+ w[index - 7] &+ s1
    }
    var a = state[0]
    var b = state[1]
    var c = state[2]
    var d = state[3]
    var e = state[4]
    var f = state[5]
    var g = state[6]
    var h = state[7]
    for index in 0..<64 {
      let s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      let choice = (e & f) ^ (~e & g)
      let temp1 = h &+ s1 &+ choice &+ sha256RoundConstants[index] &+ w[index]
      let s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      let majority = (a & b) ^ (a & c) ^ (b & c)
      let temp2 = s0 &+ majority
      h = g
      g = f
      f = e
      e = d &+ temp1
      d = c
      c = b
      b = a
      a = temp1 &+ temp2
    }
    state[0] = state[0] &+ a
    state[1] = state[1] &+ b
    state[2] = state[2] &+ c
    state[3] = state[3] &+ d
    state[4] = state[4] &+ e
    state[5] = state[5] &+ f
    state[6] = state[6] &+ g
    state[7] = state[7] &+ h
  }
}

private func rotateRight(_ value: UInt32, _ count: UInt32) -> UInt32 {
  (value >> count) | (value << (32 - count))
}

/// The first 32 bits of the fractional parts of the cube roots of the first 64 primes (FIPS 180-4).
private let sha256RoundConstants: [UInt32] = [
  0x428a_2f98, 0x7137_4491, 0xb5c0_fbcf, 0xe9b5_dba5, 0x3956_c25b, 0x59f1_11f1, 0x923f_82a4, 0xab1c_5ed5,
  0xd807_aa98, 0x1283_5b01, 0x2431_85be, 0x550c_7dc3, 0x72be_5d74, 0x80de_b1fe, 0x9bdc_06a7, 0xc19b_f174,
  0xe49b_69c1, 0xefbe_4786, 0x0fc1_9dc6, 0x240c_a1cc, 0x2de9_2c6f, 0x4a74_84aa, 0x5cb0_a9dc, 0x76f9_88da,
  0x983e_5152, 0xa831_c66d, 0xb003_27c8, 0xbf59_7fc7, 0xc6e0_0bf3, 0xd5a7_9147, 0x06ca_6351, 0x1429_2967,
  0x27b7_0a85, 0x2e1b_2138, 0x4d2c_6dfc, 0x5338_0d13, 0x650a_7354, 0x766a_0abb, 0x81c2_c92e, 0x9272_2c85,
  0xa2bf_e8a1, 0xa81a_664b, 0xc24b_8b70, 0xc76c_51a3, 0xd192_e819, 0xd699_0624, 0xf40e_3585, 0x106a_a070,
  0x19a4_c116, 0x1e37_6c08, 0x2748_774c, 0x34b0_bcb5, 0x391c_0cb3, 0x4ed8_aa4a, 0x5b9c_ca4f, 0x682e_6ff3,
  0x748f_82ee, 0x78a5_636f, 0x84c8_7814, 0x8cc7_0208, 0x90be_fffa, 0xa450_6ceb, 0xbef9_a3f7, 0xc671_78f2,
]
