import Foundation
import Report
import Testing

@testable import OCI

/// One entry of a tar archive written byte by byte: for what `tar` will not write (`../evil`,
/// `/abs/evil`, a path through a symlink) or cannot write from files (a hard link to a lower layer).
struct RawEntry {
  var name: String
  /// `0` file, `1` hard link, `2` symlink, `5` folder.
  var type: Character = "0"
  var mode: Int = 0o644
  var content = Data()
  var link = ""
  /// The 12 bytes of the size field, when they are not the content's length in octal.
  var sizeField: [UInt8]? = nil
}

/// A ustar archive of `entries`, with the two zero blocks at its end.
func rawTar(_ entries: [RawEntry]) -> Data {
  var archive = Data()
  for entry in entries {
    var header = [UInt8](repeating: 0, count: 512)
    func put(_ text: String, at offset: Int) {
      for (index, byte) in text.utf8.enumerated() { header[offset + index] = byte }
    }
    put(entry.name, at: 0)
    put(String(format: "%07o", entry.mode), at: 100)
    put("0000000", at: 108)
    put("0000000", at: 116)
    put(String(format: "%011o", entry.content.count), at: 124)
    if let sizeField = entry.sizeField {
      for (index, byte) in sizeField.enumerated() { header[124 + index] = byte }
    }
    put("00000000000", at: 136)
    put("        ", at: 148)
    header[156] = entry.type.asciiValue!
    put(entry.link, at: 157)
    put("ustar", at: 257)
    put("00", at: 263)
    let checksum = header.reduce(0) { $0 + Int($1) }
    put(String(format: "%06o", checksum), at: 148)
    header[154] = 0
    archive += Data(header)
    archive += entry.content
    archive += Data(count: (512 - entry.content.count % 512) % 512)
  }
  return archive + Data(count: 1024)
}

/// Runs `command` with `/bin/sh` in `folder`, and expects it to succeed.
func shell(_ command: String, in folder: URL) throws {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/bin/sh")
  process.arguments = ["-c", command]
  process.currentDirectoryURL = folder
  try process.run()
  process.waitUntilExit()
  #expect(process.terminationStatus == 0, "\(command)")
}

/// A temporary parent folder: the layers go in `layers/`, the image in `x/rootfs`, so a symlink
/// `../..` in the image points at the parent itself.
struct Scene {
  let parent: URL
  let layers: URL
  let rootfs: URL

  init() throws {
    parent = FileManager.default.temporaryDirectory.appendingPathComponent("oci-unpack-\(UUID().uuidString)")
    layers = parent.appendingPathComponent("layers")
    rootfs = parent.appendingPathComponent("x/rootfs")
    try FileManager.default.createDirectory(at: layers, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: rootfs, withIntermediateDirectories: true)
  }

  func remove() {
    try? FileManager.default.removeItem(at: parent)
  }

  /// A plain tar layer of `data`, written to `layers/<name>`.
  func layer(_ name: String, _ data: Data) throws -> (descriptor: Descriptor, file: URL) {
    let file = layers.appendingPathComponent(name)
    try data.write(to: file)
    return try layer(file, mediaType: "application/vnd.oci.image.layer.v1.tar")
  }

  func layer(_ file: URL, mediaType: String) throws -> (descriptor: Descriptor, file: URL) {
    let size = try FileManager.default.attributesOfItem(atPath: file.path)[.size] as! Int
    let digest = try SHA256Hasher.digest(fileAt: file)
    return (Descriptor(mediaType: mediaType, digest: digest, size: Int64(size)), file)
  }

  /// Every path in the parent folder outside the image, with a file's content or a symlink's target.
  func outsideImage() throws -> [String: String] {
    var found: [String: String] = [:]
    func walk(_ folder: URL, _ relative: String) throws {
      for name in try FileManager.default.contentsOfDirectory(atPath: folder.path) {
        let path = relative.isEmpty ? name : relative + "/" + name
        if path == "x/rootfs" { continue }
        let url = folder.appendingPathComponent(name)
        let type = try FileManager.default.attributesOfItem(atPath: url.path)[.type] as! FileAttributeType
        if type == .typeDirectory {
          found[path] = "folder"
          try walk(url, path)
        } else if type == .typeSymbolicLink {
          found[path] = "-> " + (try FileManager.default.destinationOfSymbolicLink(atPath: url.path))
        } else {
          found[path] = String(decoding: try Data(contentsOf: url), as: UTF8.self)
        }
      }
    }
    try walk(parent, "")
    return found
  }
}

func fileType(_ url: URL) throws -> FileAttributeType {
  try FileManager.default.attributesOfItem(atPath: url.path)[.type] as! FileAttributeType
}

func exists(_ url: URL) -> Bool {
  (try? FileManager.default.attributesOfItem(atPath: url.path)) != nil
}

@Test func twoLayersWithWhiteoutsAndLinksUnpack() throws {
  let scene = try Scene()
  defer { scene.remove() }
  // Layer 1 with the system tar, gzip-compressed: bin/a, etc/x, d/1.
  let source = scene.parent.appendingPathComponent("layer1")
  try FileManager.default.createDirectory(at: source.appendingPathComponent("bin"), withIntermediateDirectories: true)
  try FileManager.default.createDirectory(at: source.appendingPathComponent("etc"), withIntermediateDirectories: true)
  try FileManager.default.createDirectory(at: source.appendingPathComponent("d"), withIntermediateDirectories: true)
  try Data("a\n".utf8).write(to: source.appendingPathComponent("bin/a"))
  try Data("x\n".utf8).write(to: source.appendingPathComponent("etc/x"))
  try Data("1\n".utf8).write(to: source.appendingPathComponent("d/1"))
  try shell("tar -C layer1 -cf layers/layer1.tar . && gzip -n layers/layer1.tar", in: scene.parent)
  let layer1 = try scene.layer(
    scene.layers.appendingPathComponent("layer1.tar.gz"), mediaType: "application/vnd.oci.image.layer.v1.tar+gzip")
  // Layer 2: whiteouts, a new file, a symlink and a hard link to a file of layer 1.
  let layer2 = try scene.layer(
    "layer2.tar",
    rawTar([
      RawEntry(name: "etc/.wh.x"),
      RawEntry(name: "d/", type: "5", mode: 0o755),
      RawEntry(name: "d/.wh..wh..opq"),
      RawEntry(name: "d/2", content: Data("2\n".utf8)),
      RawEntry(name: "link", type: "2", link: "bin/a"),
      RawEntry(name: "bin/b", type: "1", link: "bin/a"),
    ]))

  try unpackLayers([layer1, layer2], into: scene.rootfs)

  let root = scene.rootfs
  #expect(try Data(contentsOf: root.appendingPathComponent("bin/a")) == Data("a\n".utf8))
  let a = try FileManager.default.attributesOfItem(atPath: root.appendingPathComponent("bin/a").path)
  let b = try FileManager.default.attributesOfItem(atPath: root.appendingPathComponent("bin/b").path)
  #expect(a[.systemFileNumber] as? Int == b[.systemFileNumber] as? Int)
  #expect(try fileType(root.appendingPathComponent("link")) == .typeSymbolicLink)
  #expect(try FileManager.default.destinationOfSymbolicLink(atPath: root.appendingPathComponent("link").path) == "bin/a")
  #expect(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("d").path) == ["2"])
  #expect(try Data(contentsOf: root.appendingPathComponent("d/2")) == Data("2\n".utf8))
  #expect(exists(root.appendingPathComponent("etc")))
  #expect(!exists(root.appendingPathComponent("etc/x")))
  #expect(!exists(root.appendingPathComponent("etc/.wh.x")))
}

@Test func paxAndGnuLongNamesLandRight() throws {
  let scene = try Scene()
  defer { scene.remove() }
  let paxPath = "pax/" + String(repeating: "p", count: 146)
  let gnuPath = "gnu/" + String(repeating: "g", count: 146)
  #expect(paxPath.count == 150)
  let source = scene.parent.appendingPathComponent("source")
  try FileManager.default.createDirectory(at: source.appendingPathComponent("pax"), withIntermediateDirectories: true)
  try FileManager.default.createDirectory(at: source.appendingPathComponent("gnu"), withIntermediateDirectories: true)
  try Data("pax\n".utf8).write(to: source.appendingPathComponent(paxPath))
  try Data("gnu\n".utf8).write(to: source.appendingPathComponent(gnuPath))
  try shell(
    "tar -C source --format=pax -cf layers/pax.tar \(paxPath) && tar -C source --format=gnu -cf layers/gnu.tar \(gnuPath)",
    in: scene.parent)
  let pax = try scene.layer(scene.layers.appendingPathComponent("pax.tar"), mediaType: "application/vnd.oci.image.layer.v1.tar")
  let gnu = try scene.layer(scene.layers.appendingPathComponent("gnu.tar"), mediaType: "application/vnd.oci.image.layer.v1.tar")
  // The archives really use a PAX header and a GNU long name.
  #expect(try Data(contentsOf: pax.file)[156] == UInt8(ascii: "x"))
  #expect(try Data(contentsOf: gnu.file)[156] == UInt8(ascii: "L"))

  try unpackLayers([pax, gnu], into: scene.rootfs)

  #expect(try Data(contentsOf: scene.rootfs.appendingPathComponent(paxPath)) == Data("pax\n".utf8))
  #expect(try Data(contentsOf: scene.rootfs.appendingPathComponent(gnuPath)) == Data("gnu\n".utf8))
}

@Test func modesAreKeptWithoutSetuid() throws {
  let scene = try Scene()
  defer { scene.remove() }
  let layer = try scene.layer(
    "modes.tar",
    rawTar([
      RawEntry(name: "plain", mode: 0o755, content: Data("#!/bin/sh\n".utf8)),
      RawEntry(name: "setuid", mode: 0o4755, content: Data("#!/bin/sh\n".utf8)),
    ]))

  try unpackLayers([layer], into: scene.rootfs)

  let plain = try FileManager.default.attributesOfItem(atPath: scene.rootfs.appendingPathComponent("plain").path)
  let setuid = try FileManager.default.attributesOfItem(atPath: scene.rootfs.appendingPathComponent("setuid").path)
  #expect(plain[.posixPermissions] as? Int == 0o755)
  #expect(setuid[.posixPermissions] as? Int == 0o755)
}

/// Unpacks `layers` (each a list of raw entries) and expects `IMAGE_FAILED` naming an entry outside
/// the image, with nothing in the parent folder changed outside the image.
func expectEscapeRefused(_ layers: [[RawEntry]], prepare: (Scene) throws -> Void = { _ in }) throws {
  let scene = try Scene()
  defer { scene.remove() }
  try prepare(scene)
  var descriptors: [(descriptor: Descriptor, file: URL)] = []
  for (index, entries) in layers.enumerated() {
    descriptors.append(try scene.layer("layer\(index).tar", rawTar(entries)))
  }
  let before = try scene.outsideImage()

  #expect {
    try unpackLayers(descriptors, into: scene.rootfs)
  } throws: { error in
    guard let error = error as? RefactorError, error.code == .IMAGE_FAILED else { return false }
    return error.instructions.contains("has an entry outside the image")
  }

  #expect(try scene.outsideImage() == before)
  #expect(!exists(URL(fileURLWithPath: "/abs/evil")))
  #expect(!exists(URL(fileURLWithPath: "/evil")))
}

/// Unpacks one layer of `entries` and expects `IMAGE_FAILED` saying the layer is not a valid tar
/// archive: a crafted header fails, it does not crash jig.
func expectInvalidTar(_ entries: [RawEntry]) throws {
  let scene = try Scene()
  defer { scene.remove() }
  let layer = try scene.layer("layer.tar", rawTar(entries))

  #expect {
    try unpackLayers([layer], into: scene.rootfs)
  } throws: { error in
    guard let error = error as? RefactorError, error.code == .IMAGE_FAILED else { return false }
    return error.instructions.contains("is not a valid tar archive")
  }
}

/// GNU base-256 for Int64.max: the largest size a 12-byte size field can say.
let base256Int64Max: [UInt8] = [0x80, 0, 0, 0, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]

@Test func aHugeBase256SizeOnASkippedEntryFails() throws {
  // A FIFO (`6`) is read past, never unpacked: the next header is after its size and padding.
  try expectInvalidTar([
    RawEntry(name: "fifo", type: "6", sizeField: base256Int64Max),
    RawEntry(name: "f", content: Data("f".utf8)),
  ])
}

@Test func aHugeGlobalHeaderFails() throws {
  try expectInvalidTar([
    RawEntry(name: "global", type: "g", sizeField: base256Int64Max),
    RawEntry(name: "f", content: Data("f".utf8)),
  ])
}

@Test func aHugePaxSizeFails() throws {
  try expectInvalidTar([
    RawEntry(name: "pax", type: "x", content: Data("28 size=9223372036854775807\n".utf8)),
    RawEntry(name: "fifo", type: "6"),
    RawEntry(name: "f", content: Data("f".utf8)),
  ])
}

@Test func aHugePaxRecordLengthFails() throws {
  try expectInvalidTar([
    RawEntry(name: "pax", type: "x", content: Data("9 path=x\n9223372036854775807 path=y\n".utf8)),
    RawEntry(name: "f", content: Data("f".utf8)),
  ])
}

@Test func aPaxSizeThatIsNotANumberFails() throws {
  try expectInvalidTar([
    RawEntry(name: "pax", type: "x", content: Data("29 size=99999999999999999999\n".utf8)),
    RawEntry(name: "f", content: Data("f".utf8)),
  ])
}

@Test func aFileReplacesASymlinkInsteadOfWritingThroughIt() throws {
  let scene = try Scene()
  defer { scene.remove() }
  try Data("outside".utf8).write(to: scene.parent.appendingPathComponent("outside"))
  let layer1 = try scene.layer("layer1.tar", rawTar([RawEntry(name: "f", type: "2", link: "../../outside")]))
  let layer2 = try scene.layer("layer2.tar", rawTar([RawEntry(name: "f", content: Data("inside".utf8))]))

  try unpackLayers([layer1, layer2], into: scene.rootfs)

  #expect(try fileType(scene.rootfs.appendingPathComponent("f")) == .typeRegular)
  #expect(try Data(contentsOf: scene.rootfs.appendingPathComponent("f")) == Data("inside".utf8))
  #expect(try Data(contentsOf: scene.parent.appendingPathComponent("outside")) == Data("outside".utf8))
}

@Test func escapesAreRefusedAndWriteNothingOutside() throws {
  // `../evil` would land in x/, next to the image.
  try expectEscapeRefused([[RawEntry(name: "../evil", content: Data("evil".utf8))]])
  try expectEscapeRefused([[RawEntry(name: "/abs/evil", content: Data("evil".utf8))]])
  // Through a symlink of the same layer.
  try expectEscapeRefused([
    [
      RawEntry(name: "s", type: "2", link: "/"),
      RawEntry(name: "s/evil", content: Data("evil".utf8)),
    ]
  ])
  // Through a symlink of an earlier layer: `../..` from x/rootfs is the parent folder.
  try expectEscapeRefused([
    [RawEntry(name: "s", type: "2", link: "../..")],
    [RawEntry(name: "s/evil", content: Data("evil".utf8))],
  ])
  // A hard link to a file outside the image (it exists, so only the check stops it).
  try expectEscapeRefused(
    [[RawEntry(name: "h", type: "1", link: "../../outside")]],
    prepare: { scene in
      try Data("outside".utf8).write(to: scene.parent.appendingPathComponent("outside"))
    })
}
