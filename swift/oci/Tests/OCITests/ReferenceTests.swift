import Foundation
import Report
import Testing

@testable import OCI

let referenceHex = String(repeating: "0123456789abcdef", count: 4)

@Test func bareNameIsDockerHubLibraryLatest() throws {
  let reference = try ImageReference.parse("node")
  #expect(reference.registry == "docker.io")
  #expect(reference.repository == "library/node")
  #expect(reference.tag == "latest")
  #expect(reference.digest == nil)
  #expect(reference.name == "docker.io/library/node")
  #expect(reference.taggedName == "docker.io/library/node:latest")
  #expect(reference.plainHTTP == false)
  #expect(reference.apiBase == URL(string: "https://registry-1.docker.io")!)
}

@Test func nameWithTag() throws {
  let reference = try ImageReference.parse("node:26")
  #expect(reference.registry == "docker.io")
  #expect(reference.repository == "library/node")
  #expect(reference.tag == "26")
}

@Test func dockerHubUserRepository() throws {
  let reference = try ImageReference.parse("acme/tool")
  #expect(reference.registry == "docker.io")
  #expect(reference.repository == "acme/tool")
  #expect(reference.tag == "latest")
}

@Test func otherRegistryWithNestedRepository() throws {
  let reference = try ImageReference.parse("ghcr.io/acme/jig/typescript:0.1.0")
  #expect(reference.registry == "ghcr.io")
  #expect(reference.repository == "acme/jig/typescript")
  #expect(reference.tag == "0.1.0")
  #expect(reference.name == "ghcr.io/acme/jig/typescript")
  #expect(reference.taggedName == "ghcr.io/acme/jig/typescript:0.1.0")
  #expect(reference.plainHTTP == false)
  #expect(reference.apiBase == URL(string: "https://ghcr.io")!)
}

@Test func localhostPortRegistryIsPlainHTTP() throws {
  let reference = try ImageReference.parse("localhost:5000/x/y")
  #expect(reference.registry == "localhost:5000")
  #expect(reference.repository == "x/y")
  #expect(reference.tag == "latest")
  #expect(reference.plainHTTP == true)
  #expect(reference.apiBase == URL(string: "http://localhost:5000")!)
}

@Test func tagAndDigest() throws {
  let reference = try ImageReference.parse("ghcr.io/a/b:1@sha256:\(referenceHex)")
  #expect(reference.registry == "ghcr.io")
  #expect(reference.repository == "a/b")
  #expect(reference.tag == "1")
  #expect(reference.digest == Digest("sha256:\(referenceHex)"))
  #expect(reference.digest != nil)
}

@Test func digestWithoutTag() throws {
  let reference = try ImageReference.parse("ghcr.io/a/b@sha256:\(referenceHex)")
  #expect(reference.tag == nil)
  #expect(reference.taggedName == nil)
  #expect(reference.digest == Digest("sha256:\(referenceHex)"))
}

@Test func indexDockerIoIsDockerHub() throws {
  let reference = try ImageReference.parse("index.docker.io/library/node")
  #expect(reference.registry == "docker.io")
  #expect(reference.repository == "library/node")
  #expect(reference.tag == "latest")
}

@Test(arguments: ["", "UPPER/case", "a/b@sha256:short", "a//b"])
func invalidReferencesAreRejected(_ text: String) throws {
  let error = #expect(throws: RefactorError.self) { try ImageReference.parse(text) }
  #expect(error?.code == .INVALID_ARGS)
}

@Test func localImagesAreExactlyTheLocalhostSlashPrefix() {
  #expect(isLocalImage("localhost/jig/typescript:local"))
  #expect(!isLocalImage("localhost:5000/x"))
  #expect(!isLocalImage("node"))
}
