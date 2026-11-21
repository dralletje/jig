import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// One HTTP request to a registry or its token service.
public struct HTTPRequest: Sendable {
  public var url: URL
  /// `GET` or `HEAD`.
  public var method: String
  public var headers: [String: String]

  public init(url: URL, method: String = "GET", headers: [String: String] = [:]) {
    self.url = url
    self.method = method
    self.headers = headers
  }
}

/// The answer to an `HTTPRequest`, after redirects.
public struct HTTPResponse: Sendable {
  public var status: Int
  /// Header names in lowercase.
  public var headers: [String: String]
  /// The body; empty for `download`, which writes it to a file instead.
  public var body: Data

  public init(status: Int, headers: [String: String] = [:], body: Data = Data()) {
    self.status = status
    self.headers = headers
    self.body = body
  }
}

/// The network could not be used: no connection, a timeout, a TLS failure. An HTTP error status is
/// not a `TransportError`; it comes back as a response.
public struct TransportError: Error, Equatable, Sendable, CustomStringConvertible {
  public var message: String

  public init(message: String) {
    self.message = message
  }

  public var description: String { message }
}

/// A 2xx response body was longer than the caller allowed; the transfer was stopped. Not a network
/// failure: the server was reached and sent too much.
public struct ResponseTooLarge: Error, Equatable, Sendable, CustomStringConvertible {
  /// The most bytes the body was allowed.
  public var limit: Int64

  public init(limit: Int64) {
    self.limit = limit
  }

  public var description: String { "the response is larger than \(limit) bytes" }
}

/// How the registry client speaks HTTP. `URLSessionTransport` for real; tests give a fake.
public protocol HTTPTransport: Sendable {
  /// Sends `request` and returns the response with its whole body. For manifests and tokens, which
  /// are small. Throws `TransportError` when the network fails.
  func send(_ request: HTTPRequest) throws -> HTTPResponse

  /// Sends `request` and writes the response body to `file` as it arrives (replacing the file), so a
  /// large blob is never held in memory. Follows redirects: blob URLs redirect to storage elsewhere.
  /// The returned response has an empty body. Throws `TransportError` when the network fails.
  func download(_ request: HTTPRequest, to file: URL) throws -> HTTPResponse

  /// `send`, with a 2xx body of at most `limit` bytes: more throws `ResponseTooLarge`. The client uses
  /// this one. The default sends, then checks the body (a transport that streams should stop at the
  /// limit instead, as `URLSessionTransport` does).
  func send(_ request: HTTPRequest, limit: Int64) throws -> HTTPResponse

  /// `download`, with a 2xx body of at most `limit` bytes: more throws `ResponseTooLarge`, and `file`
  /// keeps what was written. The client uses this one. The default downloads, then checks the file
  /// (a transport that streams should stop at the limit instead, as `URLSessionTransport` does).
  func download(_ request: HTTPRequest, to file: URL, limit: Int64) throws -> HTTPResponse
}

extension HTTPTransport {
  public func send(_ request: HTTPRequest, limit: Int64) throws -> HTTPResponse {
    let response = try send(request)
    if (200..<300).contains(response.status) && Int64(response.body.count) > limit {
      throw ResponseTooLarge(limit: limit)
    }
    return response
  }

  public func download(_ request: HTTPRequest, to file: URL, limit: Int64) throws -> HTTPResponse {
    let response = try download(request, to: file)
    guard (200..<300).contains(response.status) else { return response }
    let written: Int
    do {
      written = try FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int ?? 0
    } catch {
      throw TransportError(message: "could not read the size of \(file.path): \(error)")
    }
    if Int64(written) > limit {
      throw ResponseTooLarge(limit: limit)
    }
    return response
  }
}

/// `HTTPTransport` over Foundation's `URLSession`, made synchronous with a semaphore. Requests time
/// out after 30 seconds without data; redirects are followed (`followedRedirect`): never from HTTPS to
/// plain HTTP, and an `Authorization` header is not passed on to another scheme, host or port (a
/// registry's token means nothing to its blob storage, and must not leak there).
public struct URLSessionTransport: HTTPTransport {
  public init() {}

  public func send(_ request: HTTPRequest) throws -> HTTPResponse {
    try perform(request, writingTo: nil, limit: nil)
  }

  public func download(_ request: HTTPRequest, to file: URL) throws -> HTTPResponse {
    try download(request, to: file, limit: nil)
  }

  /// Stops receiving as soon as a 2xx body passes `limit` (or announces more in `Content-Length`).
  public func send(_ request: HTTPRequest, limit: Int64) throws -> HTTPResponse {
    try perform(request, writingTo: nil, limit: limit)
  }

  /// Stops writing as soon as a 2xx body passes `limit` (or announces more in `Content-Length`).
  public func download(_ request: HTTPRequest, to file: URL, limit: Int64) throws -> HTTPResponse {
    try download(request, to: file, limit: Optional(limit))
  }

  private func download(_ request: HTTPRequest, to file: URL, limit: Int64?) throws -> HTTPResponse {
    guard FileManager.default.createFile(atPath: file.path, contents: nil) else {
      throw TransportError(message: "could not create \(file.path)")
    }
    let handle: FileHandle
    do {
      handle = try FileHandle(forWritingTo: file)
    } catch {
      throw TransportError(message: "could not open \(file.path): \(error)")
    }
    defer { try? handle.close() }
    return try perform(request, writingTo: handle, limit: limit)
  }

  private func perform(_ request: HTTPRequest, writingTo handle: FileHandle?, limit: Int64?) throws -> HTTPResponse {
    var urlRequest = URLRequest(url: request.url)
    urlRequest.httpMethod = request.method
    urlRequest.timeoutInterval = 30
    for (name, value) in request.headers {
      urlRequest.setValue(value, forHTTPHeaderField: name)
    }

    let delegate = TransferDelegate(handle: handle, originalURL: request.url, limit: limit)
    let task = SharedSession.session.dataTask(with: urlRequest)
    SharedSession.router.add(delegate, for: task)
    task.resume()
    delegate.done.wait()
    SharedSession.router.remove(task)
    return try delegate.result()
  }
}

/// One `URLSession` for the whole process, never invalidated. Creating and invalidating a session per
/// request crashes now and then on Linux: Foundation's `_MultiHandle` (libcurl) can be torn down while
/// it is still referenced ("deallocated with non-zero retain count"), which aborts the process. Each
/// task's callbacks go to its own `TransferDelegate` through `router`.
private enum SharedSession {
  static let router = SessionRouter()
  static let session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 30
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    return URLSession(configuration: configuration, delegate: router, delegateQueue: nil)
  }()
}

/// The shared session's delegate: hands each callback to the `TransferDelegate` of its task.
private final class SessionRouter: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private var transfers: [Int: TransferDelegate] = [:]

  func add(_ transfer: TransferDelegate, for task: URLSessionTask) {
    lock.lock()
    transfers[task.taskIdentifier] = transfer
    lock.unlock()
  }

  func remove(_ task: URLSessionTask) {
    lock.lock()
    transfers[task.taskIdentifier] = nil
    lock.unlock()
  }

  private func transfer(_ task: URLSessionTask) -> TransferDelegate? {
    lock.lock()
    defer { lock.unlock() }
    return transfers[task.taskIdentifier]
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
  ) {
    guard let transfer = transfer(task) else {
      completionHandler(nil)
      return
    }
    transfer.urlSession(
      session, task: task, willPerformHTTPRedirection: response, newRequest: request,
      completionHandler: completionHandler)
  }

  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    guard let transfer = transfer(dataTask) else {
      completionHandler(.cancel)
      return
    }
    transfer.urlSession(session, dataTask: dataTask, didReceive: response, completionHandler: completionHandler)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard let transfer = transfer(dataTask) else {
      dataTask.cancel()
      return
    }
    transfer.urlSession(session, dataTask: dataTask, didReceive: data)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
    guard let transfer = transfer(task) else { return }
    transfer.urlSession(session, task: task, didCompleteWithError: error)
  }
}

/// The request to follow a redirect with, or nil to refuse it (the redirect response then comes back as
/// the answer). A redirect to plain `http` is refused unless `original` was plain `http` already (a
/// `localhost:<port>` registry): a token or a blob must not cross the network unencrypted after the
/// registry asked for TLS. A redirect to any other scheme is refused too. `Authorization` goes along
/// only when scheme, host and port all stay the same.
func followedRedirect(_ next: URLRequest, from original: URL) -> URLRequest? {
  guard let url = next.url else { return nil }
  let scheme = url.scheme?.lowercased()
  let originalScheme = original.scheme?.lowercased()
  if scheme == "http" && originalScheme != "http" {
    return nil
  }
  if scheme != "http" && scheme != "https" {
    return nil
  }
  var followed = next
  if scheme != originalScheme || url.host?.lowercased() != original.host?.lowercased() || url.port != original.port {
    followed.setValue(nil, forHTTPHeaderField: "Authorization")
  }
  return followed
}

/// Collects one transfer: the response, the body (in memory, or into a file), and how it ended. With a
/// `limit`, a 2xx body is stopped once it passes the limit (the transfer then throws
/// `ResponseTooLarge`), and an error status's body, which nobody reads, is cut at 4 MiB (the response
/// then comes back with what arrived).
private final class TransferDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  let done = DispatchSemaphore(value: 0)
  private let lock = NSLock()
  private let handle: FileHandle?
  private let originalURL: URL
  private let limit: Int64?
  private var response: HTTPURLResponse?
  private var body = Data()
  /// Bytes of the current response's body so far.
  private var received: Int64 = 0
  /// The most bytes the current response's body may have; nil for no limit.
  private var allowed: Int64?
  /// The current response has a 2xx status.
  private var successBody = false
  private var tooLarge = false
  private var errorBodyCut = false
  private var failure: String?

  init(handle: FileHandle?, originalURL: URL, limit: Int64?) {
    self.handle = handle
    self.originalURL = originalURL
    self.limit = limit
  }

  func result() throws -> HTTPResponse {
    lock.lock()
    defer { lock.unlock() }
    // Before `failure`: stopping the transfer is what failed it.
    if tooLarge, let limit { throw ResponseTooLarge(limit: limit) }
    if let failure, !errorBodyCut { throw TransportError(message: failure) }
    guard let response else { throw TransportError(message: "no response") }
    var headers: [String: String] = [:]
    for (name, value) in response.allHeaderFields {
      headers[String(describing: name).lowercased()] = String(describing: value)
    }
    return HTTPResponse(status: response.statusCode, headers: headers, body: handle == nil ? body : Data())
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(followedRedirect(request, from: originalURL))
  }

  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    lock.lock()
    let httpResponse = response as? HTTPURLResponse
    var success = false
    if let httpResponse, (200..<300).contains(httpResponse.statusCode) {
      success = true
    }
    self.response = httpResponse
    body = Data()
    received = 0
    successBody = success
    allowed = nil
    if let limit {
      allowed = success ? limit : 4 << 20
    }
    var stop = false
    // A body that announces more than it may have is not waited for.
    if success, let limit, response.expectedContentLength > limit {
      tooLarge = true
      stop = true
    }
    lock.unlock()
    if stop {
      completionHandler(.cancel)
      return
    }
    // A response before a redirect never reaches here, but start the file afresh all the same.
    if let handle {
      do {
        try handle.truncate(atOffset: 0)
      } catch {
        fail("could not write the download: \(error)")
        completionHandler(.cancel)
        return
      }
    }
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    lock.lock()
    received += Int64(data.count)
    var over = false
    if let allowed, received > allowed {
      over = true
      if successBody {
        tooLarge = true
      } else {
        errorBodyCut = true
      }
    }
    lock.unlock()
    if over {
      dataTask.cancel()
      return
    }
    if let handle {
      do {
        try handle.write(contentsOf: data)
      } catch {
        fail("could not write the download: \(error)")
        dataTask.cancel()
      }
      return
    }
    lock.lock()
    body.append(data)
    lock.unlock()
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
    if let error {
      fail(error.localizedDescription)
    }
    done.signal()
  }

  /// Records the first failure; a later one (the cancellation it caused) does not replace it.
  private func fail(_ message: String) {
    lock.lock()
    if failure == nil { failure = message }
    lock.unlock()
  }
}
