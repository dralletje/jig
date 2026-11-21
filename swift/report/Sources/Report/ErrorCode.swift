/// Every error code the binary can print. The raw values are the strings in the output JSON.
public enum ErrorCode: String, Codable, CaseIterable, Sendable {
  case SYMBOL_NOT_FOUND
  case AMBIGUOUS_SYMBOL
  case DIRTY_WORKTREE
  case REFACTOR_UNAVAILABLE
  case NO_CHANGES
  case UNKNOWN_ACTION
  case INVALID_ARGS
  case IMAGE_NOT_FOUND
  case IMAGE_FAILED
  /// A registry could not be reached (network error, timeout, 5xx, 429) or sent bytes that do not match
  /// the digest asked for.
  case REGISTRY_UNAVAILABLE
  case INTERNAL

  /// A code an image may report as its own. `REGISTRY_UNAVAILABLE` and `INTERNAL` are the host's, so an
  /// image reporting one fails as `IMAGE_FAILED` (the TypeScript `ERROR_CODES` list does not contain them
  /// either).
  static func reportable(_ raw: String) -> ErrorCode? {
    guard let code = ErrorCode(rawValue: raw) else { return nil }
    guard code != .REGISTRY_UNAVAILABLE else { return nil }
    guard code != .INTERNAL else { return nil }
    return code
  }
}
