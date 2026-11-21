import Foundation

private struct ErrorOutput: Encodable {
  var schema = outputSchema
  var ok = false
  var code: ErrorCode
  var instructions: String
}

private struct SuccessOutput: Encodable {
  var schema = outputSchema
  var ok = true
  var commit: String
  var parent: String
  var image: String
  var args: [String]
  var kind: ActionKind
  var subject: String
  var summary: String
  var filesChanged: [String]
  /// Left out of the JSON when nil.
  var notes: [String]?
}

/// `value` as one line of JSON, keys sorted: how every object jig prints is written.
func encode(_ value: some Encodable) -> String {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
  // Encoding these value types cannot fail: no non-finite numbers ever reach them from JSON input.
  guard let data = try? encoder.encode(value) else {
    return #"{"code":"INTERNAL","instructions":"could not encode the output","ok":false,"schema":"\#(outputSchema)"}"#
  }
  return String(decoding: data, as: UTF8.self)
}

extension JSONValue {
  /// This value as compact JSON.
  public func encoded() throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(self)
  }
}

/// `{"schema":"urn:jig:output:1","ok":false,"code","instructions"}`, on one line.
public func errorJSON(_ e: RefactorError) -> String {
  encode(ErrorOutput(code: e.code, instructions: e.instructions))
}

/// The output v1 success object, on one line: the commit and what the image reported. `notes` (say,
/// that a cached image was used because its registry could not be reached) become the `notes` key, left
/// out when there are none.
public func successJSON(
  commit: String, parent: String, image: String, args: [String], report: Report, filesChanged: [String],
  notes: [String] = []
) -> String {
  encode(
    SuccessOutput(
      commit: commit, parent: parent, image: image, args: args, kind: report.kind, subject: report.subject,
      summary: report.summary, filesChanged: filesChanged, notes: notes.isEmpty ? nil : notes))
}
