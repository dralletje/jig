import Foundation

/// Text without trailing whitespace on its lines and without blank lines at its ends.
func tidy(_ text: String) -> String {
  // Line endings normalised to \n first: "\r\n" and a lone "\r" each end a line.
  text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
    .split(separator: "\n", omittingEmptySubsequences: false)
    .map { line in String(line.reversed().drop(while: { $0 == " " || $0 == "\t" || $0 == "\r" }).reversed()) }
    .joined(separator: "\n")
    .trimmingCharacters(in: .newlines)
}

/// The commit message:
///
/// ```
/// <subject>
///
/// <summary>
///
/// <--message, when it has any text>
///
/// Refactor-Command: {...}
/// Refactor-Kind: <kind>
/// Co-Authored-By: <coAuthor>
/// ```
///
/// ending in a newline.
public func commitMessage(report: Report, message: String?, image: String, args: [String], coAuthor: String) -> String {
  var parts = [report.subject, ""]
  let summary = tidy(report.summary)
  if !summary.isEmpty { parts += [summary, ""] }
  if let body = message?.trimmingCharacters(in: .whitespacesAndNewlines), !body.isEmpty {
    parts += [body, ""]
  }
  parts += [
    "Refactor-Command: \(canonicalCommand(image: image, args: args))",
    "Refactor-Kind: \(report.kind.rawValue)",
    "Co-Authored-By: \(coAuthor)",
  ]
  return parts.joined(separator: "\n") + "\n"
}
