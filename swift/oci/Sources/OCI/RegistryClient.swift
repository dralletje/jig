import Foundation

/// Why the registry did not give what was asked.
public enum RegistryError: Error, Equatable {
  /// The registry does not have it, or will not give it anonymously (a private image looks the same).
  case notFound(String)
  /// The registry could not be reached or did not work: a network failure, a timeout, 5xx, 429. The
  /// text is the short reason.
  case unavailable(String)
  /// The registry was reached but answered in a way a registry should not: an unexpected HTTP status,
  /// a token answer without a token. Not an outage, so a tag never falls back to its cached copy. The
  /// text is the short reason.
  case refused(String)
  /// The bytes the registry sent do not hash to the digest they were asked for or announced with.
  case digestMismatch(expected: Digest, actual: Digest)
}

/// Talks to an OCI distribution registry: manifests by tag or digest, blobs by digest. Public images
/// only: when the registry answers 401 it gets an anonymous pull token from the registry's token
/// service and asks once more. Never reads Docker's credentials.
public final class RegistryClient: Sendable {
  private let transport: any HTTPTransport
  /// Pull tokens by `<registry>/<repository>`, kept for the client's lifetime.
  private let tokens = TokenCache()

  public init(transport: any HTTPTransport = URLSessionTransport()) {
    self.transport = transport
  }

  /// The manifest (or index) `tagOrDigest` of `ref`'s repository: its digest (the hash of the body),
  /// its media type (from `Content-Type`, without parameters; may be generic) and its body.
  /// When `tagOrDigest` is a digest the body must hash to it; for a tag, the body must hash to the
  /// `Docker-Content-Digest` header when the registry sends one.
  public func manifest(_ ref: ImageReference, _ tagOrDigest: String) throws -> (
    digest: Digest, mediaType: String, data: Data
  ) {
    let url = ref.apiBase.appendingPathComponent("v2/\(ref.repository)/manifests/\(tagOrDigest)")
    let request = HTTPRequest(url: url, method: "GET", headers: ["Accept": MediaType.accept])
    let response: HTTPResponse
    do {
      response = try fetch(ref, request, to: nil, limit: 4 << 20, what: "manifest \(tagOrDigest)")
    } catch let error as ResponseTooLarge {
      throw RegistryError.refused("manifest \(tagOrDigest) is larger than \(error.limit) bytes")
    }
    let actual = SHA256Hasher.digest(response.body)
    if let expected = Digest(tagOrDigest) {
      guard expected == actual else { throw RegistryError.digestMismatch(expected: expected, actual: actual) }
    } else if let header = response.headers["docker-content-digest"], let announced = Digest(header) {
      guard announced == actual else { throw RegistryError.digestMismatch(expected: announced, actual: actual) }
    }
    var mediaType = response.headers["content-type"] ?? ""
    if let semicolon = mediaType.firstIndex(of: ";") {
      mediaType = String(mediaType[..<semicolon])
    }
    mediaType = mediaType.trimmingCharacters(in: .whitespaces)
    return (actual, mediaType, response.body)
  }

  /// Downloads the blob `digest` of `ref`'s repository to `file`, streamed to disk. `size` is the size
  /// its descriptor gives: the download stops once the registry sends more, and fewer is refused too.
  /// When the bytes are not `size` long or do not hash to `digest`, or the download fails, `file` is
  /// deleted.
  public func downloadBlob(_ ref: ImageReference, _ digest: Digest, size: Int64, to file: URL) throws {
    guard size >= 0 else {
      throw RegistryError.refused("blob \(digest) has a negative size (\(size)) in its descriptor")
    }
    let url = ref.apiBase.appendingPathComponent("v2/\(ref.repository)/blobs/\(digest)")
    let request = HTTPRequest(url: url, method: "GET", headers: [:])
    do {
      _ = try fetch(ref, request, to: file, limit: size, what: "blob \(digest)")
    } catch is ResponseTooLarge {
      try? FileManager.default.removeItem(at: file)
      throw RegistryError.refused("blob \(digest) is larger than the \(size) bytes its descriptor gives")
    } catch {
      try? FileManager.default.removeItem(at: file)
      throw error
    }
    let written: Int
    do {
      written = try FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int ?? 0
    } catch {
      try? FileManager.default.removeItem(at: file)
      throw RegistryError.unavailable("could not read the downloaded blob \(digest): \(error)")
    }
    guard Int64(written) == size else {
      try? FileManager.default.removeItem(at: file)
      throw RegistryError.refused("blob \(digest) is \(written) bytes, not the \(size) bytes its descriptor gives")
    }
    let actual: Digest
    do {
      actual = try SHA256Hasher.digest(fileAt: file)
    } catch {
      try? FileManager.default.removeItem(at: file)
      throw RegistryError.unavailable("could not read the downloaded blob \(digest): \(error)")
    }
    guard actual == digest else {
      try? FileManager.default.removeItem(at: file)
      throw RegistryError.digestMismatch(expected: digest, actual: actual)
    }
  }

  /// Sends `request` (to `file` when given, else into memory) with the cached token; on 401 gets a
  /// fresh anonymous token and sends once more. Returns only a 2xx response; anything else throws. A
  /// 2xx body over `limit` bytes throws `ResponseTooLarge`, for the caller to say what was too large.
  private func fetch(_ ref: ImageReference, _ request: HTTPRequest, to file: URL?, limit: Int64, what: String)
    throws -> HTTPResponse
  {
    let key = ref.name
    var response = try transfer(withToken: tokens.get(key), request, to: file, limit: limit)
    if response.status == 401 {
      guard let challenge = response.headers["www-authenticate"], let token = try anonymousToken(ref, challenge)
      else {
        throw RegistryError.notFound("\(ref.name): \(what) needs credentials (HTTP 401)")
      }
      tokens.set(key, token)
      response = try transfer(withToken: token, request, to: file, limit: limit)
    }

    if (200..<300).contains(response.status) { return response }
    if response.status == 404 || response.status == 401 || response.status == 403 {
      throw RegistryError.notFound("\(ref.name): \(what) not found (HTTP \(response.status))")
    }
    if response.status == 429 || response.status >= 500 {
      throw RegistryError.unavailable("HTTP \(response.status)")
    }
    throw RegistryError.refused("unexpected HTTP \(response.status) for \(what)")
  }

  private func transfer(withToken token: String?, _ request: HTTPRequest, to file: URL?, limit: Int64) throws
    -> HTTPResponse
  {
    var request = request
    if let token { request.headers["Authorization"] = "Bearer \(token)" }
    do {
      if let file { return try transport.download(request, to: file, limit: limit) }
      return try transport.send(request, limit: limit)
    } catch let error as TransportError {
      throw RegistryError.unavailable(error.message)
    }
  }

  /// An anonymous pull token for `ref`'s repository from the token service a `WWW-Authenticate:
  /// Bearer realm="…",service="…"` challenge names; nil when the challenge is not Bearer.
  private func anonymousToken(_ ref: ImageReference, _ challenge: String) throws -> String? {
    guard challenge.lowercased().hasPrefix("bearer ") else { return nil }
    let parameters = challengeParameters(String(challenge.dropFirst("bearer ".count)))
    guard let realm = parameters["realm"], var components = URLComponents(string: realm) else { return nil }
    var query = components.queryItems ?? []
    if let service = parameters["service"] {
      query.append(URLQueryItem(name: "service", value: service))
    }
    query.append(URLQueryItem(name: "scope", value: "repository:\(ref.repository):pull"))
    components.queryItems = query
    guard let url = components.url else { return nil }

    let response: HTTPResponse
    do {
      response = try transport.send(HTTPRequest(url: url, method: "GET", headers: [:]), limit: 4 << 20)
    } catch let error as TransportError {
      throw RegistryError.unavailable(error.message)
    } catch let error as ResponseTooLarge {
      throw RegistryError.refused("the token service's answer is larger than \(error.limit) bytes")
    }
    if response.status == 429 || response.status >= 500 {
      throw RegistryError.unavailable("HTTP \(response.status) from the token service")
    }
    guard response.status == 200 else {
      throw RegistryError.notFound("\(ref.name): the token service refused an anonymous token (HTTP \(response.status))")
    }
    struct TokenAnswer: Decodable {
      var token: String?
      var access_token: String?
    }
    guard let answer = try? JSONDecoder().decode(TokenAnswer.self, from: response.body),
      let token = answer.token ?? answer.access_token, !token.isEmpty
    else {
      throw RegistryError.refused("the token service sent no token")
    }
    return token
  }
}

/// The `key="value"` (or `key=value`) pairs of a challenge, keys lowercased. Commas inside quotes
/// belong to the value (`scope="repository:a:pull,push"`).
func challengeParameters(_ text: String) -> [String: String] {
  var parameters: [String: String] = [:]
  var rest = Substring(text)
  while true {
    rest = rest.drop(while: { $0 == " " || $0 == "," })
    guard let equals = rest.firstIndex(of: "=") else { return parameters }
    let key = rest[..<equals].trimmingCharacters(in: .whitespaces).lowercased()
    rest = rest[rest.index(after: equals)...]
    var value = ""
    if rest.first == "\"" {
      rest = rest.dropFirst()
      while let character = rest.first {
        rest = rest.dropFirst()
        if character == "\\", let escaped = rest.first {
          value.append(escaped)
          rest = rest.dropFirst()
          continue
        }
        if character == "\"" { break }
        value.append(character)
      }
    } else {
      let end = rest.firstIndex(of: ",") ?? rest.endIndex
      value = rest[..<end].trimmingCharacters(in: .whitespaces)
      rest = rest[end...]
    }
    parameters[key] = value
  }
}

/// Tokens by repository, shared by the threads using one client.
private final class TokenCache: @unchecked Sendable {
  private let lock = NSLock()
  private var tokens: [String: String] = [:]

  func get(_ key: String) -> String? {
    lock.lock()
    defer { lock.unlock() }
    return tokens[key]
  }

  func set(_ key: String, _ token: String) {
    lock.lock()
    defer { lock.unlock() }
    tokens[key] = token
  }
}
