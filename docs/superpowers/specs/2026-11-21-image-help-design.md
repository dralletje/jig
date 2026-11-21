# Help for images

## Why

An agent (and the owner, mostly through the agent) has no way to find out what an image can do. Today
`jig <image>` and `jig <image> --help` fail with `UNKNOWN_ACTION` and a bare list of action names, only
inside a git repo, and nothing says what an action does or which flags it takes. The owner wants
`jig <image>` and `jig <image> --help` to show the actions, and `jig <image> <action> --help` to show an
action's flags, without a repo.

## Goals

- `jig <image>` and `jig <image> --help`: every action of the image, each with its kind and one line.
- `jig <image> <action> --help`: that action's flags (name, value, required, what it does).
- No repo needed and nothing changes: help never exports, commits or touches git.
- The image is the only place that knows its actions: it answers a help call with one JSON object, and
  jig turns that into what the caller needs. An agent (stdout is not a terminal) gets JSON; a person
  in a terminal gets readable text.
- The help cannot drift from what an action accepts: in the images built on `packages/core`, the flags an
  action declares for its help are the flags it parses.

## Non-goals

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
      "usage": ["move --from <path> --to <path>"],
      "flags": [
        {"name": "--from", "value": "<path>", "required": true, "description": "The file or folder to move."},
        {"name": "--to", "value": "<path>", "required": true, "description": "Where it goes. It must be free."}
      ]
    }
  ]
}
```

- `summary` (image and action) is one line of plain text.
- `kinds` lists the kinds the action's commits can have (`refactor`, `sweep`, `rewrite`), at least one,
  no repeats. Most actions have one; the codemod action has the kinds of its transforms (some are `sweep`,
  some `rewrite`), and its `--transform` description names each transform's kind.
- `usage` lists the ways to call the action, one line each, at least one. It is what says how flags go
  together: fs `remove` has two lines, `remove --paths <path,path>` and `remove --files <glob,glob>`,
  and both flags are `required: false`. A flag that every form needs is `required: true`.
- `flags` may be empty. `value` names the flag's value (`<path>`, `<glob,glob>`); every flag takes a value
  today, so `value` is required. `description` is plain text and may be several lines (the codemod image
  lists its transforms there).
- jig checks the object strictly, like a report: unknown fields, a wrong type, an empty `actions`, two
  actions with the same name or two flags with the same name in one action are `IMAGE_FAILED`.
- A schema file, `schemas/help-1.schema.json`, describes it, with an example in `schemas/examples/`.

## The protocol: jig side

- **When it is help.** After jig's own options, the image's arguments are exactly `[]`, `["--help"]` or
  `[<action>, "--help"]`. Anything else is a normal run, as today (so `--to --help` stays a value).
- **Options.** `--repo` and `--sandbox` are accepted and `--repo` is ignored (agents pass it by habit);
  `--message` with a help call is `INVALID_ARGS` (it has no meaning there).
- **What jig does.** Resolves the image as for a run (pulls a registry image, pins it), runs it with
  `["--help"]` on an empty temporary folder, removes the folder, and reads the last stdout line.
- **What jig prints**, exit 0:
  - stdout not a terminal: one JSON object, the image's help with `image` (the pinned reference) added
    after `schema`, and `notes` when resolving the image had something to say (the same notes a run puts
    in its output, such as a cached image used because the registry could not be reached). For
    `<action> --help`, `actions` holds only that action. The schema stays `urn:jig:help:1`; `image` and
    `notes` are optional in the schema (jig adds them, the image never sends them).
  - stdout a terminal: text. A sketch:

```
ghcr.io/dralletje/jig/fs-v1:0.1
Copies, moves and removes files and folders.

  copy    rewrite  Copies a file or folder to a free destination.
  move    rewrite  Moves a file or folder to a free destination.
  remove  rewrite  Removes files and folders, by path or by glob.

jig <image> <action> --help shows an action's flags.
```

```
move (rewrite)
Moves a file or folder to a free destination.

  jig <image> move --from <path> --to <path>

  --from <path>  required  The file or folder to move.
  --to <path>    required  Where it goes. It must be free.
```

  The terminal view prints the notes too, under the header. Kinds show as `sweep|rewrite` when there are
  several.

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

- **`packages/core`.** `Action` gains `summary: string` and `flags: Flag[]` (`{name, value, required,
  description}`); the action's `parseParams` receives only its declared flags, parsed from its declared
  list, so an undeclared flag is `INVALID_ARGS` for that action (today the typescript image accepts any of
  its 13 shared flags on every action). `runEntrypoint` takes the image's help as well as `main`, and
  answers `["--help"]` by printing it. A helper builds the help object from an image summary and actions.
- **typescript image.** Each of its 19 actions gets a summary and its flags; `main` parses each action's
  own flags. Usage strings in the README are the source for the wording.
- **prettier and codemod-react images.** Not built from `Action`s: each `main` declares its help object
  directly and passes it to `runEntrypoint`. The codemod `--transform` description lists the transforms
  of the pinned react-codemod.
- **fs image.** `fs.nu` answers `--help` with the help object, written out in the script.

## Tests

- `packages/core`: `runEntrypoint` with `["--help"]` prints the help object and exits 0; an undeclared
  flag is `INVALID_ARGS`.
- Each image package: its help object is valid against the schema, every action it dispatches is in its
  help (and no other), and for the typescript image every action's declared flags are exactly the ones its
  `parseParams` reads.
- `swift/report` (or wherever the help parser lives): valid help objects parse; each strict-check failure
  above is refused.
- `swift/cli` unit: which argument lists are help calls; `--message` with help is refused; the text
  rendering of a sample help object (both views).
- `swift/cli` end to end, outside any git repo: `jig <fs image> --help` gives JSON with `image` pinned and
  all five actions; `jig <fs image> move --help` gives one action; `jig <fs image> nope --help` is
  `UNKNOWN_ACTION`; an image without help (the test probe image) is `IMAGE_FAILED` with "gives no help";
  one test per other image that `--help` works.

## Docs

The README's usage block, a short "Help" section (what jig shows, the JSON for agents, the image's
`urn:jig:help:1` contract under "Writing an action"), and `jig --help`.

## Left to the builder

- The exact wording of summaries and flag descriptions, and of the text layout beyond the sketches.
- Where the help parser lives in Swift and how the renderer is split.
- How the terminal check is done (`isatty` on stdout).

## Calls made while writing this down

Open to correction:

- jig always sends only `--help` and filters to one action itself, so an image answers one call.
- `jig <image>` with no arguments is help and exits 0, the same as `--help`.
- An image without help is `IMAGE_FAILED`, not a new error code.
- `--message` with a help call is refused; `--repo` is accepted and ignored.
- The typescript image becomes stricter: a flag an action does not declare is refused instead of ignored.
- After this, the images are published again as new versions (`…-0.2`); that is a separate step.
- An action lists `kinds` (a list), not one `kind`, because the codemod action's kind depends on its
  transform.
- How flags go together (fs `remove` takes `--paths` or `--files`) is said by `usage` lines, not by a
  separate "one of" field.
- jig adds the resolve `notes` to help, as it does to a run's output.
