import Foundation
import Report

/// Whether `reference` names an image in local Docker rather than in a registry: exactly the prefix
/// `localhost/`. `localhost:<port>/...` is a registry (a local one, over plain HTTP).
public func isLocalImage(_ reference: String) -> Bool {
  reference.hasPrefix("localhost/")
}

/// An image reference as Docker reads it: `[<registry>/]<repository>[:<tag>][@sha256:<hex>]`, normalized
/// (`node` is `docker.io/library/node:latest`).
public struct ImageReference: Equatable, Sendable {
  public var registry: String
  public var repository: String
  /// nil only when the reference has a digest and no tag.
  public var tag: String?
  public var digest: Digest?

  public init(registry: String, repository: String, tag: String?, digest: Digest?) {
    self.registry = registry
    self.repository = repository
    self.tag = tag
    self.digest = digest
  }

  /// `<registry>/<repository>`.
  public var name: String { "\(registry)/\(repository)" }

  /// `<registry>/<repository>:<tag>`, when there is a tag.
  public var taggedName: String? {
    guard let tag else { return nil }
    return "\(name):\(tag)"
  }

  /// Registries on `localhost:<port>` are spoken to over plain HTTP; every other one over HTTPS.
  public var plainHTTP: Bool { registry.hasPrefix("localhost:") }

  /// Where the registry's `/v2/` API lives.
  public var apiBase: URL {
    if registry == "docker.io" { return URL(string: "https://registry-1.docker.io")! }
    if plainHTTP { return URL(string: "http://\(registry)")! }
    return URL(string: "https://\(registry)")!
  }

  /// Parses with Docker's rules: the first path component is a registry when it contains `.` or `:` or
  /// is `localhost`; otherwise the registry is `docker.io`, and a single-component repository gets
  /// `library/`. No tag and no digest means tag `latest`. Anything else throws `INVALID_ARGS`.
  public static func parse(_ text: String) throws -> ImageReference {
    func invalid(_ why: String) -> RefactorError {
      RefactorError(
        code: .INVALID_ARGS,
        instructions: "The image reference \"\(text)\" is not valid: \(why). Write it as "
          + "[<registry>/]<repository>[:<tag>][@sha256:<64 hex>], with a lowercase repository, "
          + "for example node:26 or ghcr.io/acme/tool:1.0.")
    }

    guard !text.isEmpty else { throw invalid("it is empty") }

    var rest = Substring(text)
    var digest: Digest? = nil
    if let at = rest.firstIndex(of: "@") {
      let digestText = String(rest[rest.index(after: at)...])
      guard let parsed = Digest(digestText) else {
        throw invalid("\"\(digestText)\" is not a digest of the form sha256:<64 lowercase hex>")
      }
      digest = parsed
      rest = rest[..<at]
    }

    var tag: String? = nil
    if let colon = rest.lastIndex(of: ":") {
      // A `:` before the last `/` is a registry port, not a tag.
      let lastSlash = rest.lastIndex(of: "/") ?? rest.startIndex
      if colon > lastSlash {
        let tagText = String(rest[rest.index(after: colon)...])
        guard tagText.wholeMatch(of: #/[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}/#) != nil else {
          throw invalid("the tag \"\(tagText)\" is not a valid tag")
        }
        tag = tagText
        rest = rest[..<colon]
      }
    }

    var components = rest.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    var registry = "docker.io"
    if components.count > 1 {
      let first = components[0]
      if first.contains(".") || first.contains(":") || first == "localhost" {
        guard
          first.wholeMatch(
            of: #/[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*(:[0-9]+)?/#)
            != nil
        else {
          throw invalid("the registry \"\(first)\" is not a valid host name")
        }
        registry = first == "index.docker.io" ? "docker.io" : first
        components.removeFirst()
      }
    }

    guard !components.isEmpty else { throw invalid("it has no repository") }
    for component in components {
      guard component.wholeMatch(of: #/[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*/#) != nil else {
        if component.isEmpty { throw invalid("the repository has an empty path component") }
        throw invalid("the repository part \"\(component)\" must be lowercase letters, digits and separators")
      }
    }
    if registry == "docker.io" && components.count == 1 {
      components.insert("library", at: 0)
    }
    let repository = components.joined(separator: "/")
    guard registry.count + 1 + repository.count <= 255 else {
      throw invalid("the name is longer than 255 characters")
    }

    if tag == nil && digest == nil { tag = "latest" }
    return ImageReference(registry: registry, repository: repository, tag: tag, digest: digest)
  }
}
