# Help for images

## Why

An agent (and the owner, mostly through the agent) has no way to find out what an image can do. Today
`jig <image>` and `jig <image> --help` fail with `UNKNOWN_ACTION` and a bare list of action names, only
inside a git repo, and nothing says what an action does or which flags it takes. The owner wants
`jig <image>` and `jig <image> --help` to show the actions, and `jig <image> <action> --help` to show an
action's flags, without a repo.

Typed flags are a first step towards jig checking arguments itself one day (unknown flags, missing
required ones, path rules applied once for every image). This design only describes; it checks nothing.

## Goals

- `jig <image>` and `jig <image> --help`: every action of the image, each with its kinds and one line.
- `jig <image> <action> --help`: that action's flags (name, type, required, what it does).
- No repo needed and nothing changes: help never exports, commits or touches git.
- The image is the only place that knows its actions: it answers a help call with one JSON object, and
  jig turns that into what the caller needs. An agent (stdout is not a terminal) gets JSON; a person
  in a terminal gets readable text.
- **One action, one set of flags.** Each flag is required or optional; an action never takes "one of these
  flags". A case that would need it becomes two actions. The only such case today, fs `remove`
  (`--paths` or `--files`), is split.
- Flags are typed: `path`, `paths`, `globs`, `text`, or `choice` with its options.

## Non-goals

- jig checking arguments against the help. Images keep receiving every argument verbatim and parsing it
  exactly as today; an image that ignores an undeclared flag today still does.
- Help stored in image labels, read without running the image (approach B below). It may come later as a
  faster path that serves the same JSON.
- Help for `jig verify`, and a manual beyond flags (examples, long docs). The README stays the manual.
- Changing the report v1 or output v1 formats.

## Approaches

- **A. The image answers a help call (picked).** jig runs the image with `--help`, without the repo
  mounted and without network; the image prints one help object. The code that runs the actions describes
  them, any image can take part, and the cost is one container start (plus a download the first time).
- **B. Help in an image label.** Instant and needs no container, but the help is written at build time and
  can drift, labels are an awkward place for a document, and every build must produce one.

The owner picked A.

## The protocol: image side

- jig runs the image with exactly one argument, `--help`, and an empty temporary folder as `/workspace`
  (the sandbox contract always mounts one). Same sandbox rules as a run: no network, read-only root.
- The image prints, as the last line of stdout, one JSON object and exits 0:

```json
{
  "schema": "urn:jig:help:1",
  "summary": "Copies, moves and removes files and folders.",
  "actions": [
    {
      "name": "move",
      "kinds": ["rewrite"],
      "summary": "Moves a file or folder to a free destination.",
      "flags": [
        {"name": "--from", "type": "path", "required": true, "description": "The file or folder to move."},
        {"name": "--to", "type": "path", "required": true, "description": "Where it goes. It must be free."}
      ]
    }
  ]
}
```

- `summary` (image and action) is one line of plain text.
- `kinds` lists the kinds the action's commits can have (`refactor`, `sweep`, `rewrite`): at least one, no
  repeats. Most actions have one; the codemod action has the kinds of its transforms (some `sweep`, some
  `rewrite`), and each `--transform` choice carries its transform's kind.
- `flags` may be empty. Each flag has `name` (starting with `--`), `type`, `required` and `description`
  (plain text, may be several lines).
- `type` is one of:
  - `path`: one repo-relative path;
  - `paths`: comma-separated repo-relative paths;
  - `globs`: comma-separated globs;
  - `text`: anything else (a symbol name, `src/a.ts:12:20`, a comma-separated list of names);
  - `choice`: the name of one of `choices` (required for `choice`, at least one, and not allowed on any
    other type). A choice is an object `{name, description, kind?}`: `name` and `description` (one line)
    are non-empty strings, names are unique within the flag, and there are no other fields.
  - `kind` on a choice means picking it decides the commit's kind (codemod's `--transform`). When one
    choice of a flag has a kind, all of them do; at most one flag of an action has choices with kinds; and
    the action's `kinds` are exactly the kinds those choices use.
- jig checks the object strictly, like a report: unknown fields, a wrong type, an empty `actions`, two
  actions with the same name, two flags with the same name in one action, `choices` missing or misplaced,
  or a choice or its kind breaking the rules above are `IMAGE_FAILED`. core's help builder throws on the
  choice rules, so an image's own tests catch them.
- A schema file, `schemas/help-1.schema.json`, describes it, with an example in `schemas/examples/`.

## The protocol: jig side

- **When it is help.** After jig's own options, the image's arguments are exactly `[]`, `["--help"]` or
  `[<action>, "--help"]`. Anything else is a normal run, as today (so `--to --help` stays a value).
- **Options.** `--repo` and `--sandbox` are accepted and `--repo` is ignored (agents pass it by habit);
  `--message` with a help call is `INVALID_ARGS` (it has no meaning there).
- **What jig does.** Resolves the image as for a run (pulls a registry image, pins it), runs it with
  `["--help"]` on an empty temporary folder, removes the folder, and reads the last stdout line.
- **What jig prints**, exit 0:
  - stdout not a terminal: one JSON object, the image's help with `ok: true` (like every other object jig
    prints, so an agent can check `ok` first), `image` (the pinned reference), and `notes` when resolving the image had something to say (the same notes a run puts
    in its output, such as a cached image used because the registry could not be reached). For
    `<action> --help`, `actions` holds only that action. The schema stays `urn:jig:help:1`; `ok`, `image`
    and `notes` are optional in the schema (jig adds them, the image never sends them; jig refuses an image
    help object that has them). jig writes it with the same JSON writer as its other output.
  - stdout a terminal: text. Sketches:

```
ghcr.io/dralletje/jig/fs-v1:0.1
Copies, moves and removes files and folders.

  copy             rewrite  Copies a file or folder to a free destination.
  move             rewrite  Moves a file or folder to a free destination.
  remove           rewrite  Removes files and folders by path.
  remove-matching  rewrite  Removes every file a glob matches.

jig <image> <action> --help shows an action's flags.
```

```
move (rewrite)
Moves a file or folder to a free destination.

  jig <image> move --from <path> --to <path>

  --from <path>  required  The file or folder to move.
  --to <path>    required  Where it goes. It must be free.
```

  Types show as `<path>`, `<path,path>`, `<glob,glob>`, `<text>`, and a choice as `<choice>` with its
  choices in a table indented under the flag: name, kind (only when the flag's choices have kinds), and
  description. Optional flags show in brackets in the usage line. The notes print under the header;
  several kinds show as `sweep|rewrite`.

```
  --transform <choice>  required  Which transform to run.
      create-element-to-jsx  sweep    Converts React.createElement calls to JSX.
      pure-component         rewrite  Converts classes that only render, without state or refs, to function components.
```

- **When it fails** (exit 1, the usual one-line error JSON on stdout in both cases):
  - `<action>` is not one of the image's: `UNKNOWN_ACTION`, listing the actions.
  - The image does not speak help: it answered with a failed report (every image today answers
    `UNKNOWN_ACTION` with its action names) → `IMAGE_FAILED` whose instructions say the image gives no help
    and quote what it said. Anything else that is not a valid help object → `IMAGE_FAILED` as for a
    broken report.
  - Resolving or running fails: the same errors as a run (`IMAGE_NOT_FOUND`, ...).
- `jig --help` prints jig's usage (the existing usage text plus a line on image help) as text and exits 0.
  Bare `jig` stays `INVALID_ARGS`.

## The images

- **`packages/core`.** `Action` gains `summary: string` and `flags: Flag[]` (`{name, type, required,
  description, choices?}`), the help types, and a helper that builds the help object from an image summary
  and actions. `runEntrypoint` takes the image's help as well as `main`, and answers exactly `["--help"]`
  by printing it and exiting 0. Parsing does not change.
- **typescript image.** Each of its 19 actions gets a summary and its flags, typed per action (`--to` is a
  `path` for `typescript-move-file` and `text` for `typescript-rename`). `main` and `parseParams` stay as
  they are. The README's usage lines are the source for the wording.
- **prettier and codemod-react images.** Not built from `Action`s: each declares its help object directly
  and passes it to `runEntrypoint`. Codemod's `--transform` is a `choice` of the pinned react-codemod's
  transforms, each with a one-line description and its kind (from the image's catalog).
- **fs image.** `fs.nu` answers `--help` with the help object, written out in the script. `remove` splits:
  - `remove --paths <path,path>` removes files and folders (every path must exist), as `remove --paths`
    does today; `--files` is no longer one of its flags.
  - `remove-matching --files <glob,glob>` removes every file or symlink a glob matches, as
    `remove --files` does today, with subject `rewrite(remove-matching): <globs>` and the same summary.
  - Both keep every other rule of today's `remove` (path rules, trimming, zero matches is `NO_CHANGES`).

## Tests

- `packages/core`: `runEntrypoint` with `["--help"]` prints the help object and exits 0; any other
  arguments run `main` as before.
- Each image package: its help object is valid against the schema, and the actions in its help are exactly
  the actions it dispatches. For the typescript image, each action's help flags are exactly the flags its
  `parseParams` reads (the way to observe that is the builder's).
- `swift/report` (or wherever the help parser lives): valid help objects parse; each strict-check failure
  above is refused.
- `swift/cli` unit: which argument lists are help calls; `--message` with help is refused; the text
  rendering of a sample help object (both views, a choice flag, an optional flag, several kinds).
- `swift/cli` end to end, outside any git repo: `jig <fs image> --help` gives JSON with `image` pinned and
  all six actions; `jig <fs image> move --help` gives one action; `jig <fs image> nope --help` is
  `UNKNOWN_ACTION`; an image without help (the test probe image) is `IMAGE_FAILED` with "gives no help";
  one test per other image that `--help` works.
- `FsTests`: the `remove --files` tests move to `remove-matching`; `remove --files` is now refused as an
  unknown flag.

## Docs

The README's usage block, a short "Help" section (what jig shows, the JSON for agents, the image's
`urn:jig:help:1` contract and the "one action, one set of flags" rule under "Writing an action"), the fs
section (`remove` and `remove-matching`), and `jig --help`.

## Left to the builder

- The exact wording of summaries and flag descriptions, and of the text layout beyond the sketches.
- The type of each existing flag, where the parse code leaves a choice.
- Where the help parser lives in Swift and how the renderer is split.
- How the terminal check is done (`isatty` on stdout).

## Calls made while writing this down

Open to correction:

- jig always sends only `--help` and filters to one action itself, so an image answers one call.
- `jig <image>` with no arguments is help and exits 0, the same as `--help`.
- An image without help is `IMAGE_FAILED`, not a new error code.
- `--message` with a help call is refused; `--repo` is accepted and ignored.
- An action lists `kinds` (a list), not one `kind`, because the codemod action's kind depends on its
  transform.
- A choice is an object with a one-line `description` and an optional `kind` (the commit's kind when it
  is picked), not a bare string; strings are refused, so there is one shape only.
- jig adds the resolve `notes` to help, as it does to a run's output, and `ok: true`.
- The split fs action is named `remove-matching`.
- After this, the images are published again as new versions (`…-0.2`); that is a separate step.
