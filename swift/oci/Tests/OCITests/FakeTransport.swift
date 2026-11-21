import Foundation

@testable import OCI

/// One answer of the fake registry.
enum FakeReply: Sendable {
  /// An HTTP response; `bodyFile`, when set, is the body instead of `body` (for large blobs).
  case response(status: Int, headers: [String: String], body: Data, bodyFile: URL?)
  /// The network fails: `send`/`download` throw `TransportError(message:)`.
  case failure(String)

  static func status(_ status: Int, headers: [String: String] = [:], body: Data = Data()) -> FakeReply {
    .response(status: status, headers: headers, body: body, bodyFile: nil)
  }

  /// 200 with `body`.
  static func ok(_ body: Data, headers: [String: String] = [:]) -> FakeReply {
    .response(status: 200, headers: headers, body: body, bodyFile: nil)
  }

  /// 200 with the contents of `file` as the body, which `download` copies without reading it.
  static func okFile(_ file: URL, headers: [String: String] = [:]) -> FakeReply {
    .response(status: 200, headers: headers, body: Data(), bodyFile: file)
  }

  /// A manifest as registries send it: `Content-Type: mediaType` and the right `Docker-Content-Digest`.
  static func manifest(_ data: Data, mediaType: String) -> FakeReply {
    .ok(
      data,
      headers: ["content-type": mediaType, "docker-content-digest": SHA256Hasher.digest(data).description])
  }

  /// The 401 a registry sends before a token, pointing at `realm`.
  static func unauthorized(realm: String, service: String) -> FakeReply {
    .status(401, headers: ["www-authenticate": "Bearer realm=\"\(realm)\",service=\"\(service)\""])
  }

  /// A token service's answer.
  static func token(_ token: String) -> FakeReply {
    .ok(Data("{\"token\":\"\(token)\"}".utf8))
  }
}

/// An `HTTPTransport` with answers set by the test. `on(url, replies...)` registers answers for a URL:
/// each request takes the next one, and the last repeats (`on(url, .status(200), .status(503))`: the
/// first request gets 200, every later one 503). A URL is looked up as written (with its query), then
/// without its query; anything not registered gets `fallback` (404 unless changed). Every request is
/// recorded, with whether it came through `send` or `download`.
final class FakeTransport: HTTPTransport, @unchecked Sendable {
  struct Recorded: Sendable {
    var request: HTTPRequest
    /// Through `download` rather than `send`.
    var download: Bool
    /// The most bytes a 2xx body may have, when the caller set it.
    var limit: Int64?
  }

  private let lock = NSLock()
  private var routes: [String: [FakeReply]] = [:]
  private var recorded: [Recorded] = []
  private var fallbackReply: FakeReply = .status(404)

  init() {}

  /// Sets the answers for `url` (replacing earlier ones for it).
  func on(_ url: String, _ replies: FakeReply...) {
    lock.lock()
    defer { lock.unlock() }
    routes[url] = replies
  }

  /// The answer to every URL not registered with `on`.
  func fallback(_ reply: FakeReply) {
    lock.lock()
    defer { lock.unlock() }
    fallbackReply = reply
  }

  /// Forgets every registered URL (the fallback stays): with `fallback(.failure(...))`, a registry
  /// that cannot be reached at all.
  func removeAll() {
    lock.lock()
    defer { lock.unlock() }
    routes = [:]
  }

  /// Every request so far, in order.
  var requests: [Recorded] {
    lock.lock()
    defer { lock.unlock() }
    return recorded
  }

  /// The URLs of every request so far, in order.
  var urls: [String] { requests.map { $0.request.url.absoluteString } }

  func send(_ request: HTTPRequest) throws -> HTTPResponse {
    try send(request, limit: nil)
  }

  func download(_ request: HTTPRequest, to file: URL) throws -> HTTPResponse {
    try download(request, to: file, limit: nil)
  }

  /// As `URLSessionTransport` does: a 2xx body over `limit` throws `ResponseTooLarge`.
  func send(_ request: HTTPRequest, limit: Int64) throws -> HTTPResponse {
    try send(request, limit: Optional(limit))
  }

  /// As `URLSessionTransport` does: a 2xx body over `limit` throws `ResponseTooLarge`, leaving what was
  /// written in `file`.
  func download(_ request: HTTPRequest, to file: URL, limit: Int64) throws -> HTTPResponse {
    try download(request, to: file, limit: Optional(limit))
  }

  private func send(_ request: HTTPRequest, limit: Int64?) throws -> HTTPResponse {
    let reply = take(request, download: false, limit: limit)
    switch reply {
    case .failure(let message):
      throw TransportError(message: message)
    case .response(let status, let headers, let body, let bodyFile):
      var data = body
      if let bodyFile {
        data = try Data(contentsOf: bodyFile)
      }
      if let limit, (200..<300).contains(status), Int64(data.count) > limit {
        throw ResponseTooLarge(limit: limit)
      }
      return HTTPResponse(status: status, headers: headers, body: data)
    }
  }

  private func download(_ request: HTTPRequest, to file: URL, limit: Int64?) throws -> HTTPResponse {
    let reply = take(request, download: true, limit: limit)
    switch reply {
    case .failure(let message):
      throw TransportError(message: message)
    case .response(let status, let headers, let body, let bodyFile):
      try? FileManager.default.removeItem(at: file)
      if let bodyFile {
        try FileManager.default.copyItem(at: bodyFile, to: file)
      } else {
        try body.write(to: file)
      }
      let written = try FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int ?? 0
      if let limit, (200..<300).contains(status), Int64(written) > limit {
        throw ResponseTooLarge(limit: limit)
      }
      return HTTPResponse(status: status, headers: headers, body: Data())
    }
  }

  private func take(_ request: HTTPRequest, download: Bool, limit: Int64?) -> FakeReply {
    lock.lock()
    defer { lock.unlock() }
    recorded.append(Recorded(request: request, download: download, limit: limit))
    let full = request.url.absoluteString
    var key = full
    if routes[key] == nil, let question = full.firstIndex(of: "?") {
      key = String(full[..<question])
    }
    guard let replies = routes[key], let first = replies.first else { return fallbackReply }
    if replies.count > 1 { routes[key] = Array(replies.dropFirst()) }
    return first
  }
}
