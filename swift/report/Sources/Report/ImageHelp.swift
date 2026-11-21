import Foundation

/// The help version images answer `--help` with, and jig prints (`schemas/help-1.schema.json`).
public let helpSchema = "urn:jig:help:1"

/// What a flag's value is.
public enum FlagType: String, Encodable, Equatable, Sendable {
  /// One repo-relative path.
  case path
  /// Comma-separated repo-relative paths.
  case paths
  /// Comma-separated globs.
  case globs
  /// Anything else (a symbol name, `src/a.ts:12:20`, a list of names).
  case text
  /// One of the flag's `choices`.
  case choice
}

/// One flag of an action. `choices` is set exactly when `type` is `.choice`.
public struct FlagHelp: Encodable, Equatable, Sendable {
  public var name: String
  public var type: FlagType
  public var required: Bool
  /// Plain text, may be several lines.
  public var description: String
  /// Left out of the JSON when nil.
  public var choices: [String]?

  public init(name: String, type: FlagType, required: Bool, description: String, choices: [String]?) {
    self.name = name
    self.type = type
    self.required = required
    self.description = description
    self.choices = choices
  }
}

/// One action of an image: the kinds its commits can have, one line on what it does, and its flags.
public struct ActionHelp: Encodable, Equatable, Sendable {
  public var name: String
  public var kinds: [ActionKind]
  public var summary: String
  public var flags: [FlagHelp]

  public init(name: String, kinds: [ActionKind], summary: String, flags: [FlagHelp]) {
    self.name = name
    self.kinds = kinds
    self.summary = summary
    self.flags = flags
  }
}

/// A valid help v1 object, without its `schema`: what the image does, and its actions.
public struct ImageHelp: Equatable, Sendable {
  public var summary: String
  public var actions: [ActionHelp]

  public init(summary: String, actions: [ActionHelp]) {
    self.summary = summary
    self.actions = actions
  }
}

/// What the image answered `--help` with, or why that is not help.
public enum ImageHelpAnswer: Equatable, Sendable {
  case help(ImageHelp)
  case failed(RefactorError)

  /// The last non-empty stdout line that is a JSON object; logs before it are fine.
  static func findObject(_ stdout: String) -> [String: JSONValue]? {
    // Split on scalars, not Characters: "\r\n" is one Character and would not split on "\n".
    let lines = stdout.unicodeScalars.split(separator: "\n", omittingEmptySubsequences: false)
      .map { String(String.UnicodeScalarView($0)) }
      .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    for line in lines.reversed() {
      guard let value = try? JSONDecoder().decode(JSONValue.self, from: Data(line.utf8)),
        case .object(let fields) = value
      else { continue }
      return fields
    }
    return nil
  }

  private static func broken(_ problem: String) -> ImageHelpAnswer {
    .failed(
      RefactorError(
        code: .IMAGE_FAILED,
        instructions: "The image's help is not a valid \(helpSchema) object: \(problem). The image is broken; "
          + "report it to its maintainers, who can check its help against schemas/help-1.schema.json."))
  }

  /// The image's help, checked strictly against help v1. An image that answered with a failed report
  /// (every image from before help answers `UNKNOWN_ACTION`) gives no help; anything else that is not a
  /// valid help object is `IMAGE_FAILED` as for a broken report.
  public static func parse(stdout: String, stderr: String, termination: Termination) -> ImageHelpAnswer {
    guard let fields = findObject(stdout) else {
      return .failed(
        RefactorError(
          code: .IMAGE_FAILED,
          instructions: "The image printed no help (\(termination)): it answers --help with no \(helpSchema) "
            + "object. Report it to its maintainers, who can check its help against schemas/help-1.schema.json. "
            + "The end of its output:\n" + String((stdout + stderr).suffix(4000))))
    }

    if case .string(reportSchema) = fields["schema"], case .bool(false) = fields["ok"] {
      let code: String
      if case .string(let text) = fields["code"] { code = text } else { code = "no code" }
      let instructions: String
      if case .string(let text) = fields["instructions"] { instructions = text } else { instructions = "" }
      return .failed(
        RefactorError(
          code: .IMAGE_FAILED,
          instructions: "The image gives no help: it does not answer --help with a \(helpSchema) object (images "
            + "built before help do not describe their actions; see their documentation, or ask their maintainers "
            + "for a version that answers --help). It answered with a failed report, \(code): \(instructions)"))
    }

    guard case .string(helpSchema) = fields["schema"] else {
      let found: String
      if case .string(let text) = fields["schema"] { found = "the schema \"\(text)\"" } else { found = "no schema" }
      return broken("its last JSON line has \(found), not \"\(helpSchema)\"")
    }

    switch termination {
    case .exited(0): break
    case .exited(let code): return broken("it printed help but exited with \(code)")
    case .signaled(let signal): return broken("it printed help but was killed by signal \(signal)")
    }

    if let extra = unknownFields(fields, allowed: ["schema", "summary", "actions"]) { return broken(extra) }
    guard let summary = fields["summary"] else { return broken("summary is missing") }
    if let problem = lineProblem(summary, "summary") { return broken(problem) }
    guard case .string(let imageSummary) = summary else { return broken("summary is not a string") }
    guard case .array(let rawActions) = fields["actions"] else { return broken("actions is missing or not an array") }
    if rawActions.isEmpty { return broken("actions is empty") }

    var actions: [ActionHelp] = []
    for (index, raw) in rawActions.enumerated() {
      let at = "actions[\(index)]"
      switch parseAction(raw, at: at) {
      case .failure(let problem): return broken(problem.text)
      case .success(let action):
        if actions.contains(where: { $0.name == action.name }) {
          return broken("two actions are named \(javaScriptJSONString(action.name))")
        }
        actions.append(action)
      }
    }
    return .help(ImageHelp(summary: imageSummary, actions: actions))
  }

  /// One entry of `actions`, checked.
  private static func parseAction(_ raw: JSONValue, at: String) -> Result<ActionHelp, Problem> {
    guard case .object(let fields) = raw else { return .failure(Problem("\(at) is not an object")) }
    if let extra = unknownFields(fields, allowed: ["name", "kinds", "summary", "flags"]) {
      return .failure(Problem("\(at): \(extra)"))
    }
    guard case .string(let name) = fields["name"], !name.isEmpty else {
      return .failure(Problem("\(at).name is missing, empty or not a string"))
    }
    guard case .array(let rawKinds) = fields["kinds"] else {
      return .failure(Problem("\(at).kinds is missing or not an array"))
    }
    if rawKinds.isEmpty { return .failure(Problem("\(at).kinds is empty")) }
    var kinds: [ActionKind] = []
    for rawKind in rawKinds {
      guard case .string(let text) = rawKind, let kind = ActionKind(rawValue: text) else {
        return .failure(Problem("\(at).kinds has something that is not refactor, sweep or rewrite"))
      }
      if kinds.contains(kind) { return .failure(Problem("\(at).kinds has \(kind.rawValue) twice")) }
      kinds.append(kind)
    }
    guard let summary = fields["summary"] else { return .failure(Problem("\(at).summary is missing")) }
    if let problem = lineProblem(summary, "\(at).summary") { return .failure(Problem(problem)) }
    guard case .string(let actionSummary) = summary else { return .failure(Problem("\(at).summary is not a string")) }
    guard case .array(let rawFlags) = fields["flags"] else {
      return .failure(Problem("\(at).flags is missing or not an array"))
    }
    var flags: [FlagHelp] = []
    for (index, rawFlag) in rawFlags.enumerated() {
      switch parseFlag(rawFlag, at: "\(at).flags[\(index)]") {
      case .failure(let problem): return .failure(problem)
      case .success(let flag):
        if flags.contains(where: { $0.name == flag.name }) {
          return .failure(Problem("\(at) has two flags named \(flag.name)"))
        }
        flags.append(flag)
      }
    }
    return .success(ActionHelp(name: name, kinds: kinds, summary: actionSummary, flags: flags))
  }

  /// One entry of an action's `flags`, checked.
  private static func parseFlag(_ raw: JSONValue, at: String) -> Result<FlagHelp, Problem> {
    guard case .object(let fields) = raw else { return .failure(Problem("\(at) is not an object")) }
    if let extra = unknownFields(fields, allowed: ["name", "type", "required", "description", "choices"]) {
      return .failure(Problem("\(at): \(extra)"))
    }
    guard case .string(let name) = fields["name"] else { return .failure(Problem("\(at).name is missing or not a string")) }
    let rest = name.unicodeScalars.dropFirst(2)
    guard name.hasPrefix("--"), !rest.isEmpty, !rest.contains(where: { $0.properties.isWhitespace }) else {
      return .failure(Problem("\(at).name must be -- and a name without spaces: \(javaScriptJSONString(name))"))
    }
    guard case .string(let rawType) = fields["type"], let type = FlagType(rawValue: rawType) else {
      return .failure(Problem("\(at).type must be path, paths, globs, text or choice"))
    }
    guard case .bool(let required) = fields["required"] else {
      return .failure(Problem("\(at).required is missing or not a boolean"))
    }
    guard case .string(let description) = fields["description"], !description.isEmpty else {
      return .failure(Problem("\(at).description is missing, empty or not a string"))
    }
    guard type == .choice else {
      if fields["choices"] != nil { return .failure(Problem("\(at) has choices but is not of type choice")) }
      return .success(FlagHelp(name: name, type: type, required: required, description: description, choices: nil))
    }
    guard case .array(let rawChoices) = fields["choices"] else {
      return .failure(Problem("\(at) is of type choice but has no choices list"))
    }
    if rawChoices.isEmpty { return .failure(Problem("\(at).choices is empty")) }
    var choices: [String] = []
    for rawChoice in rawChoices {
      guard case .string(let choice) = rawChoice, !choice.isEmpty else {
        return .failure(Problem("\(at).choices has something that is not a non-empty string"))
      }
      if choices.contains(choice) {
        return .failure(Problem("\(at).choices has \(javaScriptJSONString(choice)) twice"))
      }
      choices.append(choice)
    }
    return .success(FlagHelp(name: name, type: type, required: required, description: description, choices: choices))
  }
}

/// Why a part of the help object is refused.
private struct Problem: Error {
  var text: String
  init(_ text: String) { self.text = text }
}

private func unknownFields(_ fields: [String: JSONValue], allowed: Set<String>) -> String? {
  let extra = fields.keys.filter { !allowed.contains($0) }.sorted()
  return extra.isEmpty ? nil : "unknown field(s) \(extra.joined(separator: ", "))"
}

/// Why `value` is not one line of plain text, or nil when it is.
private func lineProblem(_ value: JSONValue, _ at: String) -> String? {
  guard case .string(let text) = value else { return "\(at) is not a string" }
  if text.isEmpty { return "\(at) is empty" }
  if text.unicodeScalars.contains(where: { $0 == "\n" || $0 == "\r" }) {
    return "\(at) has a line break: \(javaScriptJSONString(text))"
  }
  return nil
}

// MARK: - What jig prints

private struct HelpOutput: Encodable {
  var schema = helpSchema
  var ok = true
  var image: String
  /// Left out of the JSON when nil.
  var notes: [String]?
  var summary: String
  var actions: [ActionHelp]
}

/// The help object jig prints, on one line: the image's help with `ok: true`, `image` (the pinned
/// reference) and `notes` (left out when there are none), written as every other object jig prints.
public func helpJSON(image: String, notes: [String], help: ImageHelp) -> String {
  encode(
    HelpOutput(image: image, notes: notes.isEmpty ? nil : notes, summary: help.summary, actions: help.actions))
}

/// How a flag's value shows in the text view.
private func placeholder(_ type: FlagType) -> String {
  switch type {
  case .path: return "<path>"
  case .paths: return "<path,path>"
  case .globs: return "<glob,glob>"
  case .text: return "<text>"
  case .choice: return "<choice>"
  }
}

private func padded(_ text: String, _ width: Int) -> String {
  text + String(repeating: " ", count: max(0, width - text.count))
}

/// The help as text for a person in a terminal. With `action` nil: the image, its summary, the notes and
/// one line per action. With `action`: that action's kinds, summary, the notes, a usage line (optional
/// flags in brackets) and one entry per flag, a choice's options listed under it. No trailing newline.
public func helpText(image: String, notes: [String], help: ImageHelp, action: String?) -> String {
  if let action, let shown = help.actions.first(where: { $0.name == action }) {
    var lines: [String] = []
    lines.append("\(shown.name) (\(shown.kinds.map(\.rawValue).joined(separator: "|")))")
    lines.append(shown.summary)
    lines += notes
    lines.append("")
    var usage = "  jig <image> \(shown.name)"
    for flag in shown.flags {
      let word = "\(flag.name) \(placeholder(flag.type))"
      usage += flag.required ? " \(word)" : " [\(word)]"
    }
    lines.append(usage)
    if shown.flags.isEmpty { return lines.joined(separator: "\n") }
    lines.append("")
    let nameWidth = shown.flags.map { "\($0.name) \(placeholder($0.type))".count }.max() ?? 0
    // "  " + name column + "  " + "required"/"optional" + "  ".
    let indent = String(repeating: " ", count: 2 + nameWidth + 2 + 8 + 2)
    for flag in shown.flags {
      let descriptionLines = flag.description.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
      let first = "  " + padded("\(flag.name) \(placeholder(flag.type))", nameWidth) + "  "
        + (flag.required ? "required" : "optional") + "  " + (descriptionLines.first ?? "")
      lines.append(first)
      for line in descriptionLines.dropFirst() { lines.append(indent + line) }
      if let choices = flag.choices {
        lines.append(indent + "One of:")
        for choice in choices { lines.append(indent + "  " + choice) }
      }
    }
    return lines.joined(separator: "\n")
  }

  var lines: [String] = [image, help.summary]
  lines += notes
  lines.append("")
  let nameWidth = help.actions.map(\.name.count).max() ?? 0
  let kindsWidth = help.actions.map { $0.kinds.map(\.rawValue).joined(separator: "|").count }.max() ?? 0
  for shown in help.actions {
    let kinds = shown.kinds.map(\.rawValue).joined(separator: "|")
    lines.append("  " + padded(shown.name, nameWidth) + "  " + padded(kinds, kindsWidth) + "  " + shown.summary)
  }
  lines.append("")
  lines.append("jig <image> <action> --help shows an action's flags.")
  return lines.joined(separator: "\n")
}
