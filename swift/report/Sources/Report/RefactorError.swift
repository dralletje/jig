/// Any JSON value: error details, and the image's report before we look inside it.
public enum JSONValue: Codable, Equatable, Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else if let value = try? container.decode([String: JSONValue].self) {
      self = .object(value)
    } else {
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "not a JSON value")
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .null: try container.encodeNil()
    case .bool(let value): try container.encode(value)
    case .number(let value):
      // Integers as integers (`2`, not `2.0`), as JavaScript writes them.
      if let integer = safeInteger(value) { try container.encode(integer) } else { try container.encode(value) }
    case .string(let value): try container.encode(value)
    case .array(let value): try container.encode(value)
    case .object(let value): try container.encode(value)
    }
  }
}

/// The value as an integer when it is one JavaScript represents exactly (|n| ≤ 2^53 − 1), else nil.
func safeInteger(_ value: Double) -> Int64? {
  guard value.rounded() == value, abs(value) <= 9_007_199_254_740_991 else { return nil }
  return Int64(value)
}

/// A failure with one of our codes; printed as `{"schema":…,"ok":false,"code","instructions"}`.
/// `instructions` say what went wrong and what the agent should do next, in plain words.
public struct RefactorError: Error, Equatable {
  public var code: ErrorCode
  public var instructions: String

  public init(code: ErrorCode, instructions: String) {
    self.code = code
    self.instructions = instructions
  }

  /// Our own errors as they are, and those that know their `RefactorError` (see
  /// `RefactorErrorConvertible`); anything else is `INTERNAL`, with instructions for what to do next.
  public static func from(_ error: any Error) -> RefactorError {
    if let error = error as? RefactorError { return error }
    if let convertible = error as? any RefactorErrorConvertible { return convertible.refactorError }
    return RefactorError(
      code: .INTERNAL,
      instructions: "jig failed unexpectedly: \(error). Check the repository with git status and "
        + "git log (the run may have stopped part way, but the work tree is only written by the final "
        + "fast-forward), then run again; if it fails the same way, report it as a jig bug.")
  }
}

/// An error of another package that knows which `RefactorError` it is printed as: a failed command, a
/// missing executable, a path that is not valid UTF-8. `RefactorError.from` asks it.
public protocol RefactorErrorConvertible: Error {
  var refactorError: RefactorError { get }
}
