# The `fs` image

## Why

Moving, copying and deleting files and folders is the most common hand-made change that a reviewer still
has to read file by file. Done through jig, it becomes a commit that `jig verify` proves did exactly
that and nothing else, so a reviewer reads one line instead of a hundred-file diff.

## Goals

- One image, `localhost/jig/fs:local`, with five commands that change the shape of the folder tree:
  `copy`, `move`, `remove`, `unwrap` and `wrap`.
- Every command either does all of its work or refuses with instructions and changes nothing.
- A destination must be free: no command overwrites or merges into something that exists.
- The image is small and quick to start: busybox plus one static Nushell binary and one script.

## Non-goals

- Merging into an existing folder (a `merge` command may come later).
- Renaming by pattern, the executable bit, text sweeps (final newline, CRLF) and `mkdir` (git keeps no
  empty folders). They may follow later as their own commands.
- Updating references to moved files (imports, paths in config). That is what `typescript-move-file`
  does; `fs` only moves bytes.

## Approaches

1. **busybox + a Nushell script (picked).** Nushell writes the JSON report natively (`to json`), matches
   globs (`glob`) and has path commands that return structured data, so the parts a shell script would
   get wrong are built in. About 122 MB (the Nushell binary is most of it), still smaller than the
   ~200 MB Node option. The cost: the nu script is a third place that writes the report
   format (after `packages/core` and the host), but jig checks every report strictly and each command
   writes one small object.
2. **A Node image on `packages/core`, like the others.** The report and error codes come for free, but
   it is about 200 MB for some file moves.
3. **A static Swift binary in an empty image.** A few MB, but no image is built that way today: it needs
   a Swift build stage and the static SDK in the Containerfile.

## The image

- `containers/fs/Containerfile`: `FROM busybox` at an exact version, plus the static (musl) Nushell
  0.117.0 release binary, downloaded at build time and checked against its SHA-256, and
  `containers/fs/fs.nu`. `ENTRYPOINT ["nu", "--no-config-file", "/app/fs.nu"]`, working directory
  `/workspace`.
- `scripts/build-images.sh` picks it up as `localhost/jig/fs:local` without changes.
- The script does all the file work with nu's own `cp`, `mv` and `rm`; busybox is the base system.
- It needs nothing at run time: no network, and a read-only root apart from `/workspace` and `/tmp`.

## Commands

The first argument is the command; anything else is `UNKNOWN_ACTION`.

- `copy --from A --to B`: copies a file or a folder (recursively). B must be free; missing parent
  folders of B are created. Symlinks are copied as links, and file modes are kept.
- `move --from A --to B`: B must be free, and must not be inside A. Missing parent folders of B are
  created.
- `remove --paths a,b`: removes files and folders. Every path must exist.
- `remove --files "<glob>,<glob>"`: removes every file (or symlink) any glob matches. Zero matches is
  `NO_CHANGES`. Exactly one of `--paths` and `--files` is given.
- `unwrap --folder A`: moves everything in A (dotfiles too) up one level and removes A. If any name in A
  collides with something already next to A, the whole run is refused. An item named like A itself
  (`src/lib/lib`) is fine, because A goes away.
- `wrap --paths a,b --into D`: moves the items into a new folder D. D must be free and must not be inside
  any of the paths; two paths with the same base name are refused. Missing parent folders of D are
  created.

**Paths** are relative to the repo root. Refused with `INVALID_ARGS`: an absolute path, a `..` part, a
`.git` part, an empty path, and the root itself (`.`). A missing source, a destination that is not free
(anything exists there, a dangling symlink included) and a collision are `INVALID_ARGS` too, with
instructions that name the paths. Unknown or missing flags are `INVALID_ARGS` with the command's usage.
Every check runs before anything is touched.

## The report

The minimal report v1 (`urn:jig:report:1`): `{schema, ok, kind, subject, summary}` on success, and
`{schema, ok: false, code, instructions}` with a non-zero exit on failure, as the last line of stdout.

- `kind` is `rewrite` for every command: jig cannot promise that moving or removing files keeps a
  project's behaviour.
- `subject` is `rewrite(<command>): <what>`, for example `rewrite(move): src/old → src/new` or
  `rewrite(remove): **/*.orig`.
- `summary` says what happened with file counts, for example `Moved src/old to src/new (42 files).`
  `remove --files` lists the removed files, one per line, capped at 20 as `listLines` in `packages/core`
  does. The replay proves the per-file detail, so other commands don't list every file.

## Tests

End to end through jig, in `swift/cli` (`FsTests`), against the built image: each command commits and
`jig verify` says `identical`; every refusal above gives its code and leaves the repo untouched;
unwrapping `src/lib` that holds `src/lib/lib` works.

## Docs

The README's image list, the `rewrite` row of the Kinds table and the Actions section gain the `fs`
image and its commands.

## Left to the builder

- The busybox version and how the Containerfile picks the nu archive per architecture (amd64, arm64).
- The exact summary and subject wording beyond the examples above, and the usage text.
- How the script is laid out inside `fs.nu`.

## Calls made while writing this down

These were not discussed and are open to correction:

- The subject label is the command name (`rewrite(move): …`), not `fs-move`.
- `remove --files` takes a comma-separated list of globs, like the other images' `--files`, and matches
  files and symlinks only; folders are removed with `--paths`.
- The root (`.`) is refused as a path.
- `move` into itself and `wrap` into one of its own paths are refused.
