import Foundation
import Report

public let configFile = ".jig.json"

/// `.jig.json` in the repo root. Its only key is `coAuthor`.
public struct Config: Equatable, Sendable {
  public var coAuthor: String

  public static let `default` = Config(coAuthor: "jig <jig@dral.dev>")
}

private func invalid(_ message: String) -> RefactorError {
  RefactorError(code: .INVALID_ARGS, instructions: "\(configFile): \(message). Fix the file, then run again.")
}

/// Reads the config over `Config.default`. No file is the default; any key other than `coAuthor` is an
/// error rather than being ignored without a word.
public func loadConfig(repo: URL) throws -> Config {
  let data: Data
  do {
    data = try Data(contentsOf: repo.appendingPathComponent(configFile))
  } catch CocoaError.fileReadNoSuchFile {
    return .default
  }

  let raw: JSONValue
  do {
    raw = try JSONDecoder().decode(JSONValue.self, from: data)
  } catch {
    throw invalid("invalid JSON: \(error)")
  }
  guard case .object(let fields) = raw else { throw invalid("must be a JSON object") }

  var config = Config.default
  for key in fields.keys.sorted() {
    guard key == "coAuthor" else { throw invalid("unknown key \"\(key)\"; the only key is \"coAuthor\"") }
    guard case .string(let value) = fields[key] else { throw invalid("coAuthor must be a string") }
    config.coAuthor = value
  }
  return config
}
