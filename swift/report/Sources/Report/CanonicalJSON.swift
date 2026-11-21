/// A JSON string literal escaped exactly as JavaScript's `JSON.stringify` does: `"` and `\`, the short
/// escapes `\b \f \n \r \t`, other control characters as lowercase `\u00xx`, and nothing else (`/` and
/// non-ASCII stay as they are).
func javaScriptJSONString(_ value: String) -> String {
  var out = "\""
  for scalar in value.unicodeScalars {
    switch scalar {
    case "\"": out += "\\\""
    case "\\": out += "\\\\"
    case "\u{8}": out += "\\b"
    case "\u{c}": out += "\\f"
    case "\n": out += "\\n"
    case "\r": out += "\\r"
    case "\t": out += "\\t"
    case "\u{0}"..."\u{1f}":
      let hex = String(scalar.value, radix: 16)
      out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
    default: out.unicodeScalars.append(scalar)
    }
  }
  return out + "\""
}

/// Canonical JSON: object keys sorted by UTF-16 code units (JavaScript's default sort), no whitespace,
/// strings escaped as `JSON.stringify` does, integers written as integers. Matches JavaScript's
/// `JSON.stringify` with keys sorted, for every value the binary writes (their numbers are integers;
/// anything else falls back to Swift's shortest representation).
func canonicalJSON(_ value: JSONValue) -> String {
  switch value {
  case .null: return "null"
  case .bool(let b): return b ? "true" : "false"
  case .number(let n): return safeInteger(n).map { String($0) } ?? "\(n)"
  case .string(let s): return javaScriptJSONString(s)
  case .array(let items): return "[" + items.map(canonicalJSON).joined(separator: ",") + "]"
  case .object(let fields):
    let keys = fields.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
    return "{" + keys.map { javaScriptJSONString($0) + ":" + canonicalJSON(fields[$0] ?? .null) }.joined(separator: ",") + "}"
  }
}

/// The `Refactor-Command` trailer's JSON: `{"args":[...],"image":"..."}`, keys sorted, no whitespace,
/// matches JavaScript's `JSON.stringify` of `{ args, image }` with keys sorted.
public func canonicalCommand(image: String, args: [String]) -> String {
  canonicalJSON(.object(["image": .string(image), "args": .array(args.map { .string($0) })]))
}
