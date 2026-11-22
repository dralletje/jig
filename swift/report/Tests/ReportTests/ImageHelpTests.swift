import Foundation
import Testing

@testable import Report

/// The help object of the spec's example, on one line.
private func exampleHelp() throws -> String { try example("help-1.json") }

/// A help line built from `actions` (JSON, without the brackets) with the default image summary.
private func help(actions: String, extra: String = "") -> String {
  #"{"schema":"urn:jig:help:1","summary":"Does things.","actions":["# + actions + "]" + extra + "}"
}

/// One action with `flags` (JSON, without the brackets).
private func action(name: String = "move", kinds: String = #"["rewrite"]"#, flags: String = "") -> String {
  #"{"name":""# + name + #"","kinds":"# + kinds + #","summary":"Moves it.","flags":["# + flags + "]}"
}

private func refused(_ stdout: String, termination: Termination = .exited(0)) -> RefactorError {
  let answer = ImageHelpAnswer.parse(stdout: stdout, stderr: "", termination: termination)
  guard case .failed(let error) = answer else {
    Issue.record("expected a failure, got \(answer)")
    return RefactorError(code: .INTERNAL, instructions: "")
  }
  return error
}

private let move = ActionHelp(
  name: "move", kinds: [.rewrite], summary: "Moves a file or folder to a free destination.",
  flags: [
    FlagHelp(name: "--from", type: .path, required: true, description: "The file or folder to move.", choices: nil),
    FlagHelp(name: "--to", type: .path, required: true, description: "Where it goes. It must be free.", choices: nil),
  ])

@Test func theSpecExampleParses() throws {
  #expect(
    ImageHelpAnswer.parse(stdout: try exampleHelp(), stderr: "", termination: .exited(0))
      == .help(ImageHelp(summary: "Copies, moves and removes files and folders.", actions: [move])))
}

@Test func logsBeforeTheHelpLineAreFine() throws {
  let stdout = "starting\n{not json\n" + (try exampleHelp()) + "\n\n"
  guard case .help(let parsed) = ImageHelpAnswer.parse(stdout: stdout, stderr: "", termination: .exited(0)) else {
    Issue.record("expected help")
    return
  }
  #expect(parsed.actions == [move])
}

@Test func choiceFlagsParse() {
  let flags =
    #"{"name":"--transform","type":"choice","choices":["#
    + #"{"name":"a","description":"Does a."},{"name":"b","description":"Does b."},"#
    + #"{"name":"c","description":"Does c."}"#
    + #"],"required":true,"description":"Which.\nTwo lines."},"#
    + #"{"name":"--files","type":"globs","required":false,"description":"Where."},"#
    + #"{"name":"--parser","type":"choice","choices":[{"name":"tsx","description":"TypeScript."}],"required":false,"description":"P."}"#
  let line = help(actions: action(name: "codemod", kinds: #"["rewrite","sweep"]"#, flags: flags))
  #expect(
    ImageHelpAnswer.parse(stdout: line, stderr: "", termination: .exited(0))
      == .help(
        ImageHelp(
          summary: "Does things.",
          actions: [
            ActionHelp(
              name: "codemod", kinds: [.rewrite, .sweep], summary: "Moves it.",
              flags: [
                FlagHelp(
                  name: "--transform", type: .choice, required: true, description: "Which.\nTwo lines.",
                  choices: [
                    ChoiceHelp(name: "a", description: "Does a."),
                    ChoiceHelp(name: "b", description: "Does b."),
                    ChoiceHelp(name: "c", description: "Does c."),
                  ]),
                FlagHelp(name: "--files", type: .globs, required: false, description: "Where.", choices: nil),
                FlagHelp(
                  name: "--parser", type: .choice, required: false, description: "P.",
                  choices: [ChoiceHelp(name: "tsx", description: "TypeScript.")]),
              ])
          ])))
}

/// A choice flag named `name` with `choices` (JSON, without the brackets).
private func choiceFlag(_ choices: String, name: String = "--a") -> String {
  #"{"name":""# + name + #"","type":"choice","choices":["# + choices + #"],"required":true,"description":"D."}"#
}

@Test(arguments: [
  ("a string choice", help(actions: action(flags: choiceFlag(#""x""#)))),
  ("a choice without description", help(actions: action(flags: choiceFlag(#"{"name":"x"}"#)))),
  ("a choice with an empty description", help(actions: action(flags: choiceFlag(#"{"name":"x","description":""}"#)))),
  ("a choice with a multi-line description", help(actions: action(flags: choiceFlag(#"{"name":"x","description":"A.\nB."}"#)))),
  ("a choice without name", help(actions: action(flags: choiceFlag(#"{"description":"D."}"#)))),
  ("a choice with an empty name", help(actions: action(flags: choiceFlag(#"{"name":"","description":"D."}"#)))),
  ("a choice with an unknown field", help(actions: action(flags: choiceFlag(#"{"name":"x","description":"D.","default":true}"#)))),
  ("a choice with a kind", help(actions: action(flags: choiceFlag(#"{"name":"x","description":"D.","kind":"rewrite"}"#)))),
  (
    "two choices with one name",
    help(actions: action(flags: choiceFlag(#"{"name":"x","description":"D."},{"name":"x","description":"E."}"#)))
  ),
])
func choiceChecksRefuse(problem: String, line: String) {
  let error = refused(line)
  #expect(error.code == .IMAGE_FAILED, "\(problem)")
  #expect(error.instructions.contains("schemas/help-1.schema.json"), "\(problem): \(error.instructions)")
}

@Test(arguments: [
  // Unknown fields, also those jig adds itself.
  ("unknown top-level field", help(actions: action(), extra: #","extra":1"#)),
  ("ok", help(actions: action(), extra: #","ok":true"#)),
  ("image", help(actions: action(), extra: #","image":"x@sha256:00""#)),
  ("notes", help(actions: action(), extra: #","notes":["n"]"#)),
  ("unknown action field", help(actions: #"{"name":"a","kinds":["rewrite"],"summary":"S.","flags":[],"x":1}"#)),
  (
    "unknown flag field",
    help(actions: action(flags: #"{"name":"--a","type":"text","required":true,"description":"D.","x":1}"#))
  ),
  // Wrong types and missing fields.
  ("summary not a string", #"{"schema":"urn:jig:help:1","summary":1,"actions":[]}"#),
  ("actions not an array", #"{"schema":"urn:jig:help:1","summary":"S.","actions":{}}"#),
  ("missing summary", #"{"schema":"urn:jig:help:1","actions":["# + action() + "]}"),
  ("required not a boolean", help(actions: action(flags: #"{"name":"--a","type":"text","required":"yes","description":"D."}"#))),
  ("missing description", help(actions: action(flags: #"{"name":"--a","type":"text","required":true}"#))),
  ("flags missing", help(actions: #"{"name":"a","kinds":["rewrite"],"summary":"S."}"#)),
  // The rules beyond the types.
  ("empty actions", #"{"schema":"urn:jig:help:1","summary":"S.","actions":[]}"#),
  ("duplicate action", help(actions: action() + "," + action())),
  (
    "duplicate flag",
    help(
      actions: action(
        flags: #"{"name":"--a","type":"text","required":true,"description":"D."},"#
          + #"{"name":"--a","type":"path","required":false,"description":"E."}"#))
  ),
  ("empty kinds", help(actions: action(kinds: "[]"))),
  ("repeated kind", help(actions: action(kinds: #"["rewrite","rewrite"]"#))),
  ("unknown kind", help(actions: action(kinds: #"["delete"]"#))),
  ("unknown flag type", help(actions: action(flags: #"{"name":"--a","type":"number","required":true,"description":"D."}"#))),
  ("choice without choices", help(actions: action(flags: #"{"name":"--a","type":"choice","required":true,"description":"D."}"#))),
  (
    "choices on text",
    help(
      actions: action(
        flags: #"{"name":"--a","type":"text","choices":[{"name":"x","description":"D."}],"required":true,"description":"D."}"#))
  ),
  (
    "empty choices",
    help(actions: action(flags: #"{"name":"--a","type":"choice","choices":[],"required":true,"description":"D."}"#))
  ),
  ("flag name without --", help(actions: action(flags: #"{"name":"-a","type":"text","required":true,"description":"D."}"#))),
  ("flag name with a space", help(actions: action(flags: #"{"name":"--a b","type":"text","required":true,"description":"D."}"#))),
  ("empty flag description", help(actions: action(flags: #"{"name":"--a","type":"text","required":true,"description":""}"#))),
  ("multi-line image summary", #"{"schema":"urn:jig:help:1","summary":"One.\nTwo.","actions":["# + action() + "]}"),
  ("multi-line action summary", help(actions: #"{"name":"a","kinds":["rewrite"],"summary":"One.\nTwo.","flags":[]}"#)),
  ("empty action summary", help(actions: #"{"name":"a","kinds":["rewrite"],"summary":"","flags":[]}"#)),
  ("empty action name", help(actions: action(name: ""))),
  ("action name that is a flag", help(actions: action(name: "--help"))),
  ("action name starting with -", help(actions: action(name: "-x"))),
  ("action name with a space", help(actions: action(name: "a b"))),
  ("action name with a line break", help(actions: action(name: #"a\nb"#))),
  ("action name with a tab", help(actions: action(name: #"a\tb"#))),
])
func strictChecksRefuse(problem: String, line: String) {
  let error = refused(line)
  #expect(error.code == .IMAGE_FAILED, "\(problem)")
  #expect(error.instructions.contains("schemas/help-1.schema.json"), "\(problem): \(error.instructions)")
}

@Test func validHelpButExitOneIsRefused() throws {
  let error = refused(try exampleHelp(), termination: .exited(1))
  #expect(error.code == .IMAGE_FAILED)
  #expect(error.instructions.contains("exited with 1"))
}

@Test func validHelpButKilledIsRefused() throws {
  let error = refused(try exampleHelp(), termination: .signaled(9))
  #expect(error.code == .IMAGE_FAILED)
}

@Test func aFailedReportGivesNoHelp() {
  let line =
    #"{"schema":"urn:jig:report:1","ok":false,"code":"UNKNOWN_ACTION","instructions":"Unknown action \"--help\". This image has: format."}"#
  let error = refused(line, termination: .exited(1))
  #expect(error.code == .IMAGE_FAILED)
  #expect(error.instructions.contains("gives no help"))
  #expect(error.instructions.contains("UNKNOWN_ACTION"))
  #expect(error.instructions.contains("This image has: format."))
}

@Test func anImageWhoseHelpCrashesFailedToAnswer() {
  let line = #"{"schema":"urn:jig:report:1","ok":false,"code":"INTERNAL","instructions":"the help crashed: boom"}"#
  let error = refused(line, termination: .exited(1))
  #expect(error.code == .IMAGE_FAILED)
  #expect(error.instructions.contains("failed to answer --help"))
  #expect(error.instructions.contains(#""the help crashed: boom""#))
  #expect(error.instructions.contains("report it to its maintainers"))
  #expect(!error.instructions.contains("gives no help"))
  #expect(!error.instructions.contains("built before help"))
}

@Test func noJSONLineAtAll() {
  let error = refused("usage: tool [options]\n", termination: .exited(2))
  #expect(error.code == .IMAGE_FAILED)
  #expect(error.instructions.contains("usage: tool [options]"))
}

@Test func anotherSchemaIsRefused() {
  let error = refused(#"{"schema":"urn:jig:help:2","summary":"S.","actions":[]}"#)
  #expect(error.code == .IMAGE_FAILED)
  #expect(error.instructions.contains("schemas/help-1.schema.json"))
}

// MARK: - What jig prints

private let convert = ActionHelp(
  name: "convert", kinds: [.sweep, .rewrite], summary: "Converts React code.",
  flags: [
    FlagHelp(
      name: "--to", type: .choice, required: true, description: "What to convert to.\nOne of these.",
      choices: [
        ChoiceHelp(name: "jsx", description: "Converts React.createElement calls to JSX."),
        ChoiceHelp(name: "function", description: "Converts stateless classes to function components."),
      ]),
    FlagHelp(name: "--files", type: .globs, required: true, description: "The files to run it on.", choices: nil),
    FlagHelp(
      name: "--parser", type: .choice, required: false, description: "The parser.",
      choices: [
        ChoiceHelp(name: "tsx", description: "TypeScript with JSX."),
        ChoiceHelp(name: "babel", description: "JavaScript with JSX."),
      ]),
  ])

private let sample = ImageHelp(
  summary: "Copies, moves and removes files and folders.",
  actions: [
    ActionHelp(name: "copy", kinds: [.rewrite], summary: "Copies a file or folder to a free destination.", flags: []),
    move,
    ActionHelp(name: "remove-matching", kinds: [.rewrite], summary: "Removes every file a glob matches.", flags: []),
    convert,
  ])

@Test func helpJSONAddsOkAndImage() throws {
  let printed = helpJSON(image: "localhost/x@sha256:abc", notes: [], help: ImageHelp(summary: "S.", actions: [move]))
  #expect(!printed.contains("\n"))
  let value = try JSONDecoder().decode(JSONValue.self, from: Data(printed.utf8))
  guard case .object(let fields) = value else {
    Issue.record("not an object: \(printed)")
    return
  }
  #expect(fields["schema"] == .string("urn:jig:help:1"))
  #expect(fields["ok"] == .bool(true))
  #expect(fields["image"] == .string("localhost/x@sha256:abc"))
  #expect(fields["notes"] == nil)
  #expect(fields["summary"] == .string("S."))
  // It is a valid help object again once jig's own fields are gone.
  let stripped = String(decoding: try JSONValue.object(fields.filter { $0.key != "ok" && $0.key != "image" }).encoded(), as: UTF8.self)
  #expect(
    ImageHelpAnswer.parse(stdout: stripped, stderr: "", termination: .exited(0))
      == .help(ImageHelp(summary: "S.", actions: [move])))
}

@Test func helpJSONKeepsChoicesAndNotes() throws {
  let printed = helpJSON(image: "i@sha256:abc", notes: ["Used the cached image."], help: ImageHelp(summary: "S.", actions: [convert]))
  #expect(printed.contains(#""notes":["Used the cached image."]"#))
  // The choices are carried through as objects, keys sorted.
  #expect(
    printed.contains(
      #""choices":[{"description":"Converts React.createElement calls to JSX.","name":"jsx"},"#
        + #"{"description":"Converts stateless classes to function components.","name":"function"}]"#))
  #expect(printed.contains(#""choices":[{"description":"TypeScript with JSX.","name":"tsx"},"#))
  #expect(printed.contains(#""kinds":["sweep","rewrite"]"#))
  // Keys sorted, as every other object jig prints.
  #expect(printed.hasPrefix(#"{"actions":[{"flags":[{"choices":"#))
  // A flag that is not a choice has no choices key.
  #expect(printed.contains(#"{"description":"The files to run it on.","name":"--files","required":true,"type":"globs"}"#))
}

@Test func helpTextImageView() {
  let text = helpText(image: "ghcr.io/dralletje/jig/fs-v1@sha256:abc", notes: [], help: sample, action: nil)
  #expect(
    text == """
      ghcr.io/dralletje/jig/fs-v1@sha256:abc
      Copies, moves and removes files and folders.

        copy             rewrite        Copies a file or folder to a free destination.
        move             rewrite        Moves a file or folder to a free destination.
        remove-matching  rewrite        Removes every file a glob matches.
        convert          sweep|rewrite  Converts React code.

      jig <image> <action> --help shows an action's flags.
      """)
}

@Test func helpTextImageViewWithNotes() {
  let text = helpText(
    image: "i@sha256:abc", notes: ["Used the cached image: the registry could not be reached."],
    help: ImageHelp(summary: "S.", actions: [move]), action: nil)
  #expect(
    text == """
      i@sha256:abc
      S.
      Used the cached image: the registry could not be reached.

        move  rewrite  Moves a file or folder to a free destination.

      jig <image> <action> --help shows an action's flags.
      """)
}

@Test func helpTextActionViewMatchesTheSketch() {
  let text = helpText(image: "i@sha256:abc", notes: [], help: ImageHelp(summary: "S.", actions: [move]), action: "move")
  #expect(
    text == """
      move (rewrite)
      Moves a file or folder to a free destination.

        jig <image> move --from <path> --to <path>

        --from <path>  required  The file or folder to move.
        --to <path>    required  Where it goes. It must be free.
      """)
}

@Test func helpTextActionViewWithChoicesOptionalFlagsAndNotes() {
  let text = helpText(
    image: "i@sha256:abc", notes: ["A note."], help: ImageHelp(summary: "S.", actions: [convert]), action: "convert")
  #expect(
    text == """
      convert (sweep|rewrite)
      Converts React code.
      A note.

        jig <image> convert --to <choice> --files <glob,glob> [--parser <choice>]

        --to <choice>        required  What to convert to.
                                       One of these.
            jsx       Converts React.createElement calls to JSX.
            function  Converts stateless classes to function components.
        --files <glob,glob>  required  The files to run it on.
        --parser <choice>    optional  The parser.
            tsx    TypeScript with JSX.
            babel  JavaScript with JSX.
      """)
}

@Test func helpJSONOfParsedHelpParsesAgain() throws {
  // What jig prints for a help with choices is a valid help object again, once its own fields are gone.
  let printed = helpJSON(image: "i@sha256:abc", notes: [], help: ImageHelp(summary: "S.", actions: [convert]))
  let value = try JSONDecoder().decode(JSONValue.self, from: Data(printed.utf8))
  guard case .object(let fields) = value else {
    Issue.record("not an object: \(printed)")
    return
  }
  let stripped = String(decoding: try JSONValue.object(fields.filter { $0.key != "ok" && $0.key != "image" }).encoded(), as: UTF8.self)
  #expect(
    ImageHelpAnswer.parse(stdout: stripped, stderr: "", termination: .exited(0))
      == .help(ImageHelp(summary: "S.", actions: [convert])))
}

@Test func helpTextActionViewWithoutFlagsAndOtherTypes() {
  let none = ActionHelp(name: "tidy", kinds: [.sweep], summary: "Tidies.", flags: [])
  #expect(
    helpText(image: "i@sha256:abc", notes: [], help: ImageHelp(summary: "S.", actions: [none]), action: "tidy") == """
      tidy (sweep)
      Tidies.

        jig <image> tidy
      """)
  let typed = ActionHelp(
    name: "remove", kinds: [.rewrite], summary: "Removes.",
    flags: [
      FlagHelp(name: "--paths", type: .paths, required: true, description: "What.", choices: nil),
      FlagHelp(name: "--symbol", type: .text, required: false, description: "Which.", choices: nil),
    ])
  #expect(
    helpText(image: "i@sha256:abc", notes: [], help: ImageHelp(summary: "S.", actions: [typed]), action: "remove") == """
      remove (rewrite)
      Removes.

        jig <image> remove --paths <path,path> [--symbol <text>]

        --paths <path,path>  required  What.
        --symbol <text>      optional  Which.
      """)
}
