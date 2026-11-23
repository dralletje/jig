# jig

Run a mechanical refactor as a container image on a clean copy of the repo, and commit the result as a
**reproducible** commit co-authored by `jig <jig@dral.dev>`. Built for AI agents: one JSON object on stdout,
stable error codes.

```sh
pnpm install
sh scripts/build-images.sh  # builds localhost/jig/{typescript,prettier,codemod-react,fs}:local
sh scripts/build-binary.sh  # builds the static Swift binary dist/jig

dist/jig [--repo <path>] [--message <text>] [--sandbox docker|rootlesskit] <image> [args...]
dist/jig verify [--repo <path>] [--sandbox docker|rootlesskit] <commit-or-range>
dist/jig [--sandbox docker|rootlesskit] <image> [--help]           # the image's actions
dist/jig [--sandbox docker|rootlesskit] <image> <action> --help    # one action's flags
dist/jig --help                                                    # this usage

dist/jig localhost/jig/fs:local --help
dist/jig --repo <repo> localhost/jig/typescript:local rename --file src/a.ts --symbol foo --to bar
dist/jig --repo <repo> localhost/jig/typescript:local extract --file src/a.ts --symbols foo,keep --to src/foo.ts
dist/jig --repo <repo> localhost/jig/typescript:local lift-out --file src/a.ts --in outer --symbol inner [--to src/inner.ts]
dist/jig --repo <repo> localhost/jig/typescript:local move-file --file src/a.ts --to src/lib/a.ts
dist/jig --repo <repo> localhost/jig/typescript:local organize-imports --files "src/**/*.ts,src/**/*.tsx"
dist/jig --repo <repo> localhost/jig/typescript:local imports-to-alias --files "src/**" --targets "src/lib/**" --alias @/
dist/jig --repo <repo> localhost/jig/prettier:local format --files "src/**"
dist/jig --repo <repo> localhost/jig/codemod-react:local rename-unsafe-lifecycles --files "src/**"
dist/jig --repo <repo> localhost/jig/fs:local move --from src/old --to src/new
#   typescript actions also take --kind function|class|interface|type|enum|variable
#   every action, its flags and its limits: see "Actions" below, or ask the image (see "Help")
```

## Using jig in your project

jig is alpha: actions, flags and formats can still change between releases.

### Download

A static Linux binary (x86-64) is attached to each [release](https://github.com/dralletje/jig/releases).
It needs `git`, and `docker` (the default sandbox) or `rootlesskit`:

```sh
curl -fsSL -o ~/.local/bin/jig https://github.com/dralletje/jig/releases/latest/download/jig
chmod +x ~/.local/bin/jig
```

### For your agent

Two snippets to paste into your project's `AGENTS.md` (or `CLAUDE.md`). The first tells an agent how to get
jig, the second how to use it.

````markdown
## jig: installing

If `jig` is not on PATH, download it (static Linux x86-64 binary, needs git and docker):

    curl -fsSL -o ~/.local/bin/jig https://github.com/dralletje/jig/releases/latest/download/jig
    chmod +x ~/.local/bin/jig
````

````markdown
## jig: mechanical refactors as reproducible commits

For a refactor one of these images covers, use `jig` instead of editing by hand: it runs the image on a
clean export of HEAD and commits the result as one commit that `jig verify` can replay.

Images (leave the tag off for the newest build):
- `ghcr.io/dralletje/jig/typescript-v1`: TypeScript refactors (rename, move-file, extract, organize-imports, …)
- `ghcr.io/dralletje/jig/prettier-v1`: prettier `format`
- `ghcr.io/dralletje/jig/codemod-react-v1`: react-codemod, one action per transform
- `ghcr.io/dralletje/jig/fs-v1`: copy, move, remove, remove-matching, wrap, unwrap

How to use it:
- `jig <image>` lists the image's actions; `jig <image> <action> --help` gives an action's flags. Both
  print JSON when piped. Ask before guessing flags.
- Run: `jig [--repo <path>] [--message <text>] <image> <action> <flags...>`. jig's own options go
  before the image; everything after it goes to the image.
- The working tree must be clean: commit or stash first.
- jig prints one JSON object. Check `ok`. On success it has `commit`, `subject` and `filesChanged`;
  on failure `code` and `instructions`: follow the instructions. `NO_CHANGES` means nothing matched.
- jig does not typecheck or test: run the project's checks after each jig commit.
- `jig verify <commit-or-range>` replays jig commits and checks they still produce the same tree.
- If it is unclear which action fits, run the candidates: a failed run commits nothing.
````

## Building the binary

The host binary is Swift (Foundation), in the Swift packages under
`swift/` (see [Layout](#layout-pnpm-workspace)), built from `swift/cli` as one static Linux binary that
needs nothing at runtime but `git` on `PATH`, plus what its [sandbox](#sandboxes) needs (`docker`, or
`/usr/bin/rootlesskit`, and `docker` for `localhost/` images). It needs Swift 6.4.2 and its Static Linux SDK,
`swift-6.4.2-RELEASE_static-linux-0.1.0`:

```sh
swiftly install 6.4.2
swift sdk install https://download.swift.org/swift-6.4.2-release/static-sdk/swift-6.4.2-RELEASE/swift-6.4.2-RELEASE_static-linux-0.1.0.artifactbundle.tar.gz --checksum 3786b179936d9cc9e266dd506bd1654176358d7b25288e243359f4d17cc4dc5a
scripts/build-binary.sh     # swift build -c release --swift-sdk x86_64-swift-linux-musl, stripped
```

`build-binary.sh` is plain POSIX `sh`; building the binary needs only Swift, no Node. It uses `$SWIFT`,
else `swift` on `PATH`, else the toolchain swiftly installed. `sh scripts/test-swift.sh` runs the unit
tests of every package and the end-to-end tests (see [Tests](#tests)).

Only `--repo`, `--message` and `--sandbox` before the image are the binary's own options. `--sandbox`
picks where the image runs (see [Sandboxes](#sandboxes)): `docker` (the default) or `rootlesskit`.
Everything after the image goes to the image verbatim, even values starting with `--`. The first
of them is the action name, which the commit subject names: an empty one, one starting with `-` (the
action is missing, or one of jig's own options was put after the image), or one with whitespace, is
`INVALID_ARGS` before anything runs (and `verify` refuses a recorded command like that as unreadable).
`verify` as the first argument selects [Verify](#verify) instead.

### Images

`<image>` is a registry image or a local one:

- A reference starting with exactly `localhost/` (`localhost/jig/typescript:local`) is an image in this
  machine's Docker, pinned by its local image ID (`docker image inspect`). A machine that verifies the
  commit must have that exact image too; rebuilding an image usually gives a new ID.
- Everything else is a registry image, named as Docker names them: no registry part means Docker Hub
  (`node:26` is `docker.io/library/node:26`), no tag means `latest`. jig downloads it itself, without
  Docker, into its own image store, and both sandboxes run it from there. `localhost:<port>/...` is a
  registry too (a local one, spoken to over plain HTTP); every other registry is HTTPS.

A registry image is pinned by the digest its tag points to. For a multi-platform image that is the
index digest, so the pin does not depend on the machine: each machine runs the `linux/<arch>` build
(amd64 or arm64) of that same pinned image (different files, the same pin). A single-platform image
on another architecture fails. A reference that already has a digest is used as typed.

A tag is asked from the registry on every run. When the registry cannot be reached (a network error,
a timeout, a 5xx or 429 answer), jig uses the digest it last saw for that tag, if the store still has
that image complete, and says so in the output's `notes` ([output v1](#output-v1)); without one the
run fails with `REGISTRY_UNAVAILABLE`. A pinned digest (a replay, `verify`) never falls back: it is
taken from the store, or downloaded by that digest.

Only public images: jig uses the registry's anonymous token flow and never reads
`~/.docker/config.json` or credential helpers. Anonymously, a private image and a missing one look
the same, so both are `IMAGE_NOT_FOUND`, with instructions to tag a local image `localhost/<name>`
or to push it. Every manifest and layer is checked against its SHA-256 before it enters the store.
Layers may be gzip-compressed or plain tar; zstd layers fail with an error.

The store is `$XDG_CACHE_HOME/jig/oci` (when `XDG_CACHE_HOME` is an absolute path), else
`~/.cache/jig/oci`, in the standard OCI image layout (`oci-layout`, `index.json`,
`blobs/sha256/<hex>`); `index.json` also records each tag's last digest. Several jig processes may
fill it at once. jig does not remove old images from it yet; deleting the folder frees the space, and
images are downloaded again when needed.

### Sandboxes

| `--sandbox` | Runs | Isolation | Needs | Use it when |
|---|---|---|---|---|
| [`docker`](swift/sandbox+docker/README.md) (default) | an image, `docker run --network none --read-only` | namespaces + cgroups + Docker's seccomp profile, owned by the Docker daemon; a SIGKILL of the binary can leave the container running | a running Docker daemon | Docker is there: the reference behaviour |
| [`rootlesskit`](swift/sandbox+rootlesskit/README.md) | the same images, as direct children of the binary | own user/PID/mount/network(none) namespaces, `pivot_root` into the read-only image, uid 1000 with no capabilities, `no_new_privs`, a seccomp deny list; nothing survives the binary | `/usr/bin/rootlesskit` (with its AppArmor profile on Ubuntu 24.04), and Docker only to copy a `localhost/` image's files out once (registry images are unpacked from jig's store) | no daemon should own the run, or the run must not outlive the binary |

The pinned reference recorded in `Refactor-Command` is what the sandbox resolved the image to: for
`docker` and `rootlesskit` the same `<name>@sha256:<digest>` (the registry digest the tag points to, or
a `localhost/` image's local ID), so a commit made with one replays with the other:

```sh
dist/jig --repo <repo> --sandbox rootlesskit localhost/jig/typescript:local rename --file src/a.ts --symbol foo --to bar
```

A sandbox this machine cannot run fails with `INTERNAL` and instructions saying what to install
(rootlesskit, Docker) or which other sandbox to use.

The binary has no time limit of its own. To bound a run, wrap it in `timeout`:

```sh
timeout 600 dist/jig --repo <repo> <image> [args...]
```

Use plain `timeout` (it sends SIGTERM), not `timeout -s KILL` or `-k`: a SIGKILL cannot be cleaned up
after, so a docker container would keep running. On SIGINT, SIGTERM or SIGHUP the binary stops and
removes its container (or rootlesskit sandbox) and temporary folders, prints an `INTERNAL` failure whose instructions start with
`interrupted`, and exits with 130, 143 or 129. A signal during the final fast-forward waits for it (the
repository is never left half-updated); the instructions then name the commit if it landed.

The working tree must be clean. It runs on whatever is checked out, including a detached HEAD. Placing
the commit elsewhere in history is up to the caller. It prints one JSON object, [output v1](#output-v1):
the commit and what the image reported.

## How a run works

1. Refuse a dirty working tree (`DIRTY_WORKTREE`), including files hidden from `git status` by
   assume-unchanged or skip-worktree, and a repository with a path that is not valid UTF-8.
2. Resolve and pin the image (see [Images](#images)): a registry image by the digest its tag points
   to, downloaded into jig's store when the store does not have it; a `localhost/` image by its local
   ID (`docker image inspect`). A reference pinned with `@sha256:<digest>` runs that digest, whatever
   the tag points at now. A missing image or digest is `IMAGE_NOT_FOUND`; a registry that cannot be
   reached, without a cached version of the tag, is `REGISTRY_UNAVAILABLE`.
3. Export `HEAD` into a temporary directory (`git read-tree` + `git checkout-index` through a temporary
   index): committed files only, no `.git`, nothing untracked or ignored. The container has no
   installed dependencies in the sense that nothing outside `HEAD` is present (a committed
   `node_modules` is just files); the image always uses its own tool versions.
   `.gitattributes` `export-ignore`/`export-subst` do not apply.
4. `docker run --rm --name jig-<random> --network none --read-only --tmpfs /tmp -v <tmp>:/workspace -w /workspace <image id> <args...>`.
   Only rootless docker is supported for now. The name lets an interruption remove exactly this container.
5. Read the image's [report](#image-report-v1) from the last JSON line of its stdout (logs before it are
   fine) and validate it. An image error is passed through with its code and instructions; no report, a
   report of another version or an invalid one is `IMAGE_FAILED`. A container killed by a signal is
   reported as "killed by signal N".
6. Before git reads the directory, reject (`IMAGE_FAILED`) a `.git` entry the image created anywhere,
   any `.gitattributes` it added, changed or deleted at any depth (so it can never select a host filter
   driver during the capture), and a name that is not valid UTF-8.
7. Let git capture the result: `git add -A` into the same temporary index with the directory as the
   work tree, then `git write-tree`. Git applies the repo's ignore rules, so new files at ignored paths
   are skipped. File modes (the executable bit) carry through for created and edited files, and shape
   changes such as a folder replaced by a file work.
8. Reject (`IMAGE_FAILED`, nothing written to the repo) any change to a `.gitignore` file and a new or
   changed gitlink. Submodule gitlinks stay as they
   are. A tree equal to `HEAD`'s is `NO_CHANGES`.
9. `git commit-tree` the tree on top of `HEAD`, then `git merge --ff-only --no-overwrite-ignore` it:
   that moves the branch (or detached `HEAD`) and updates the index and the files. Git refuses to
   overwrite ignored files and to write through symlinked folders.

**No validation: the caller validates.** The binary does not typecheck, test or check completeness. The
agent calling it runs its own typecheck and tests on the result. No git hooks run (`commit-tree`
bypasses them, and the fast-forward runs with `core.hooksPath=/dev/null`). Every git call runs without
the caller's `GIT_*` environment variables, so they cannot point it at another repository, index or
config. Nothing is written to the work tree, index or refs before the final fast-forward; a rejected run can leave unreachable objects that `git gc` prunes.

## What a commit looks like

```
refactor(typescript rename): foo → bar in a.ts

Renamed `foo` to `bar` in a.ts (9 places in 4 files).

Refactor-Command: {"args":["rename","--file","a.ts","--symbol","foo","--to","bar"],"image":"localhost/jig/typescript:local@sha256:<id>"}
Refactor-Kind: refactor
Co-Authored-By: jig <jig@dral.dev>
```

The message is the subject, a blank line, then the summary. The subject comes from the image, and names
the kind, the image and the action: `<kind>(<image> <action>): <description>`, where `<image>` is the
image's own name (`typescript`, `prettier`, `codemod-react`, `fs`), not the reference it was run as, so a
replay from any registry or tag gives the same subject. The image's summary follows it, and says what
a partial result left alone. An optional `--message` goes between the summary and the trailers.
The trailers are `Refactor-Command`, `Refactor-Kind` and the co-author.
`Refactor-Command` is canonical JSON (keys sorted by UTF-16 code units, no whitespace, strings escaped
as `JSON.stringify` does) of the pinned image and the args. To replay a commit, check out its parent and
run the recorded `image` with the recorded `args`, or let [`verify`](#verify) do it without touching the
repo. The tests check that this reproduces the identical tree. `Refactor-Kind` is the report's `kind`.

## Verify

```sh
dist/jig verify [--repo <path>] [--sandbox docker|rootlesskit] <commit-or-range>
dist/jig verify --repo <repo> HEAD
dist/jig verify --repo <repo> main..HEAD
```

`verify` replays refactor commits and says whether each is exactly what its recorded command makes, so a
reviewer only has to read the hand-written commits (it proves a commit matches its command, not that the
command was the right one). For each commit it reads the trailers, resolves the recorded image with the
chosen sandbox, exports the parent's tree through a temporary index, runs the image with the recorded
args, runs the same checks as a run and captures the tree. Nothing is committed: the repo's work tree,
index, refs and config are never written, so a dirty work tree is fine. Interruptions behave as for a run.

- `<commit>`: one commit. No `Refactor-Command` trailer (in the message's last paragraph), a root or merge
  commit, unreadable trailers, or a recorded image that is not pinned (`<name>@sha256:<64 hex>`) are an
  `INVALID_ARGS` error ([output v1](#output-v1)). A pinned registry image is downloaded by its digest
  when the store does not have it; a digest the registry no longer has is `failed` (`IMAGE_NOT_FOUND`).
  A pinned `localhost/` image this machine's Docker does not have is `failed` (`IMAGE_NOT_FOUND`): only
  a machine with that exact image ID or module hash can replay the commit.
- `<range>` (anything with `..`): `git rev-list --reverse --no-merges <range>`, oldest first (a range
  with no commits besides merges is an `INVALID_ARGS` error). Those
  commits are `skipped` (with a `reason`) or `invalid`, and a replay that fails is `failed` (with the
  error's `code` and `instructions`); the other commits are still verified.

The replay always runs on the commit's own parent, so a rebased or cherry-picked commit is `different`
(or `failed`) when its parent changed what the command makes, or no longer has what it acts on (the
symbol no longer exists).

Verdicts: `identical` (the replayed tree is the commit's tree, and the kind and subject equal its
`Refactor-Kind` and subject), `different` (anything else: a commit edited by hand after the run, or an
image whose output varies), `failed`, `skipped`, `invalid`.

It prints one JSON object, [`schemas/verify-1.schema.json`](schemas/verify-1.schema.json)
(`urn:jig:verify:1`):

```json
{"commits":[{"command":{"args":["write","a.txt"],"image":"…@sha256:…"},"commit":"<sha>","filesDiffering":[],"mismatches":[],"verdict":"identical"}],"ok":true,"schema":"urn:jig:verify:1"}
```

`filesDiffering` lists the paths where the replayed tree and the commit's tree differ, `mismatches` the
recorded values (`kind`, `subject`) that were not reproduced. `ok` is true when at least one commit was
verified (not skipped) and every verified one is `identical`; the exit code is 0 then, 1 otherwise.
Errors before any replay (bad arguments, an unknown commit, a range with no commits, a single commit
that cannot be verified) use the output v1 failure shape and exit 1.

## Help

```sh
dist/jig [--sandbox docker|rootlesskit] <image> [--help]
dist/jig [--sandbox docker|rootlesskit] <image> <action> --help
```

The image is the only place that knows its actions, so jig asks it: it resolves the image as for a run
(downloads and pins a registry image), runs it with exactly `--help` on an empty temporary folder (no
repo mounted, no network, same sandbox as a run), removes the folder and checks the answer. No repo is
needed and nothing is exported, committed or touched. It is help only when the image's arguments are
exactly none, `--help`, or `<action> --help`; anything else is a run (`move --to --help` passes `--help`
as the value of `--to`). `--repo` is accepted and ignored; `--message` is `INVALID_ARGS`.

When stdout is not a terminal (an agent), jig prints one JSON object, exit 0: the image's
[help](#writing-an-action) with `ok: true`, `image` (the pinned reference) and `notes` (as in a run's
output, only when there are some). With `<action> --help`, `actions` holds only that action.

```json
{"actions":[{"flags":[{"description":"The file or folder to move.","name":"--from","required":true,"type":"path"},{"description":"Where it goes. …","name":"--to","required":true,"type":"path"}],"kind":"rewrite","name":"move","summary":"Moves a file or folder to a free destination."}],"image":"localhost/jig/fs:local@sha256:<id>","ok":true,"schema":"urn:jig:help:1","summary":"Copies, moves and removes files and folders."}
```

In a terminal it prints text instead:

```
$ dist/jig localhost/jig/fs:local
localhost/jig/fs:local@sha256:<id>
Copies, moves and removes files and folders.

  copy             rewrite  Copies a file or folder to a free destination.
  move             rewrite  Moves a file or folder to a free destination.
  …

jig <image> <action> --help shows an action's flags.

$ dist/jig localhost/jig/fs:local move --help
move (rewrite)
Moves a file or folder to a free destination.

  jig <image> move --from <path> --to <path>

  --from <path>  required  The file or folder to move.
  --to <path>    required  Where it goes. …
```

Types show as `<path>`, `<path,path>`, `<glob,glob>`, `<text>` and `<choice>`; optional flags are in
brackets in the usage line. A choice flag's choices are a table
indented under it: the name and what it does:

```
  --parser <choice>    optional  The parser for every file. …
      tsx    TypeScript with JSX.
      ts     TypeScript without JSX.
      …
```

Failures use the output v1 failure shape and exit 1: an action the image does not have is
`UNKNOWN_ACTION`, listing the image's actions; an image that answers `--help` with a failed report (an
image built before help) is `IMAGE_FAILED` saying it gives no help and quoting what it said; any other
answer that is not valid help is `IMAGE_FAILED`, as for a broken report; resolving or running the image
fails as for a run (`IMAGE_NOT_FOUND`, …). `jig --help` prints jig's usage and exits 0.

## Image report v1

An image prints its report as the last line of its stdout. The JSON Schemas (draft 2020-12) are the
reference: [`schemas/report-1.schema.json`](schemas/report-1.schema.json) and
[`schemas/output-1.schema.json`](schemas/output-1.schema.json), with examples in
[`schemas/examples/`](schemas/examples). Every report carries `"schema": "urn:jig:report:1"`;
the binary refuses any other (or none) with `IMAGE_FAILED`, naming the version it supports.

Success (exit 0):

```json
{ "schema": "urn:jig:report:1", "ok": true,
  "kind": "refactor",
  "subject": "refactor(typescript rename): foo → bar in src/a.ts",
  "summary": "Renamed `foo` to `bar` in src/a.ts (3 references in 2 files)." }
```

These five fields, and no others (any other field is `IMAGE_FAILED`):

- `kind`: `refactor` | `sweep` | `rewrite` (see [Kinds](#kinds-refactors-sweeps-and-rewrites)).
- `subject`: `<kind>(<image> <action>): <description>`, one line. It must start with `<kind>(` for the
  reported `kind`, then the image's own name (not empty, without spaces, `(` or `)`), one space, the
  action jig ran (the first argument it passed to the image) and `): `. Anything else, the older
  `<kind>(<action>): ` form included, is `IMAGE_FAILED`, with the expected start in the instructions.
- `summary`: what happened, for people: plain text, may be several lines and hold an ASCII graph, not
  only whitespace. A partial result says here what it left alone and what to do about it. The binary
  drops trailing whitespace and blank lines at the ends, the same in the commit and its output.

Failure (non-zero exit):

```json
{ "schema": "urn:jig:report:1", "ok": false,
  "code": "REFACTOR_UNAVAILABLE",
  "instructions": "`sendEmail` is passed as a callback in src/jobs.ts:40. Wrap that use in an arrow function first, then run again." }
```

`code` is one of the [error codes](#errors); `instructions` say what the agent should do next.

## Output v1

The binary prints one JSON object on stdout and exits 0 on success, 1 on failure. Success:

```json
{"schema":"urn:jig:output:1","ok":true,
 "commit":"<sha>","parent":"<sha>",
 "image":"localhost/jig/typescript:local@sha256:<id>",
 "args":["rename","--file","a.ts","--symbol","foo","--to","bar"],
 "kind":"refactor",
 "subject":"refactor(typescript rename): foo → bar in a.ts",
 "summary":"Renamed `foo` to `bar` in a.ts (9 places in 4 files).",
 "filesChanged":["a.ts","b.ts","c.tsx","scripts/tool.ts"]}
```

(on one line; `kind`, `subject` and `summary` are the image's report; `notes`, a list of lines the agent
should know about such as a cached image used because its registry could not be reached, only when
there are some). Failure, for the image's errors and the
binary's own (dirty tree, image not found, …) alike:

```json
{"schema":"urn:jig:output:1","ok":false,"code":"DIRTY_WORKTREE","instructions":"The working tree has uncommitted changes:\n M a.ts\nCommit or stash them, then run again."}
```

## Writing an action

An action is an object with `id`, `kind`, `parseParams`, `describe` and `run` (`packages/core/src/types.ts`).
The image's `main` runs it and turns its result into the report with
`okReport(kind, "<image>", id, describe(params), result)`, `"<image>"` being the image's own name, written
out once in its `main` (`"typescript"`, `"prettier"`);
`runEntrypoint` prints that, or the failure report for a thrown error. What an action has to do:

- **`run` returns what it did**, `ActionResult` from `@jig/core`: only a `summary`.

  ```ts
  return {
    summary: `Renamed \`${p.symbol}\` to \`${p.to}\` in ${file} (${plural(n, "place")} in ${plural(files, "file")}).`,
  };
  ```

  `okReport` throws on an image bug (an image name that is empty or has a space or parenthesis, an empty
  summary, a subject with a line break). Write the summary
  of a long list with `listLines(items)` (one per line, capped at 20) and `plural(n, word)`.
- **A partial result** ends its summary with a `Not handled (N):` block, one entry per place left alone:
  `path:line: reason`, then the instructions indented two more spaces.

  ```
  Renamed `sendEmail` to `sendMail` in 3 places.

  Not handled (1):
    src/jobs.ts:12: `sendEmail` is passed as a callback
      pass tenantId by hand, or wrap the callback
  ```

  Actions in the typescript engine build the block with `notHandled(places)` from
  `packages/engine-typescript/src/shared.ts` (it is not exported from the package; other packages write
  the same format by hand).
- **Refusing**: `throw new RefactorError(code, instructions)`. The message is the `instructions` of the
  failure report: say what is wrong and what to do next ("… Pass --kind function|variable to pick one.",
  "… Pass n to scaled as parameters first, then run again."). There are no `details`: put the names,
  paths and positions the agent needs into the text. In the typescript engine `unavailable(instructions)`
  throws `REFACTOR_UNAVAILABLE`. Plan everything before writing, so a refusal leaves no half-done work.
- **Tests**: `assertReport(report)` from `@jig/test-utils` validates a report against the
  JSON Schema; check the `summary` of the action's report.
- **Help**: an action also has a one-line `summary` and its `flags`, exactly the flags `parseParams`
  reads. `runEntrypoint(main, help)` answers arguments that are exactly `["--help"]` by printing the help
  object and exiting 0. `help` is a function that returns it (or a promise of it), built with `imageHelp`
  and `actionHelp` from `@jig/core`: `runEntrypoint(main, () => imageHelp(summary, ACTIONS.map(actionHelp)))`.

### The help contract (`urn:jig:help:1`)

Any image, whatever it is written in, describes itself the same way: run with exactly one argument,
`--help` (on an empty `/workspace`, no network), it prints one JSON object as the last line of stdout
and exits 0. [`schemas/help-1.schema.json`](schemas/help-1.schema.json) is the reference, with an
example in [`schemas/examples/help-1.json`](schemas/examples/help-1.json):

```json
{ "schema": "urn:jig:help:1",
  "summary": "Copies, moves and removes files and folders.",
  "actions": [
    { "name": "move", "kind": "rewrite", "summary": "Moves a file or folder to a free destination.",
      "flags": [
        { "name": "--from", "type": "path", "required": true, "description": "The file or folder to move." },
        { "name": "--to", "type": "path", "required": true, "description": "Where it goes. It must be free." } ] } ] }
```

- `summary` (image and action): one line of plain text.
- `name` (action): what it is called on the command line; it does not start with `-` and has no whitespace.
- `kind`: the one kind the action's commits have, `refactor`, `sweep` or `rewrite` (a list, `kinds`, is an
  unknown field).
- `flags` may be empty. Each has `name` (`--` and a name), `type`, `required` and `description` (plain
  text, may be several lines). `type` is `path` (one repo-relative path), `paths` (comma-separated
  repo-relative paths), `globs` (comma-separated globs), `text` (anything else) or `choice` (the name of
  one of `choices`, a non-empty list present only on a `choice`).
- A choice is `{"name": "<value>", "description": "<one line>"}`, both required and nothing else, names
  unique within the flag. A choice never decides the commit's kind: what would need that is one action
  per choice (the codemod image's transforms).
- **One action, one set of flags.** Each flag is required or optional; an action never takes "one of
  these flags". A case that would need it is two actions (fs `remove` and `remove-matching`).
- **One action, one kind.** If an action's commits could be of more than one kind, it is split into
  actions, one per kind, whose behaviours do not overlap. Where it is truly ambiguous which action fits,
  an agent can run the candidates and see which succeeds.
- jig checks the object strictly: unknown fields (`ok`, `image` and `notes` included: jig adds those),
  wrong types, a missing or unknown `kind`, empty `actions`, two actions or two flags of one action with the same name, `choices`
  missing or misplaced, or a choice that is not such an object (one with a `kind` included) are
  `IMAGE_FAILED`. `imageHelp` in `packages/core` throws on the kind and choice rules too. jig does not
  check a run's arguments against the help: the image still parses them itself.

## Kinds: refactors, sweeps and rewrites

Every action has a kind, so the history tells targeted refactors from repo-wide or behaviour-changing
commits:

| Kind | Meaning | Actions |
|---|---|---|
| `refactor` | targeted, behaviour-preserving, the kind you do as part of other work | `rename`, `extract`, `lift-out`, `move-file`, `move-files`, `duplicate-files`, `remove-barrels`, `params-to-object`, `inline-function` (one call or the definition), `template-string`, `remove-unused-variable`, `convert-function` |
| `sweep` | a repo-wide or many-file mechanical convention change, behaviour-preserving | `format`, `organize-imports`, `add-import-extensions`, `subpath-imports`, `imports-to-relative`, `imports-to-alias`, `imports-to-subpath`, `default-to-named`, `infer-return-types`, `namespace-to-named`, `import-type`, `rename-files` |
| `rewrite` | changes behaviour in a simple, repetitive way (removing `console.log` calls, ...) | `remove-console`, the transforms of the codemod image (their kinds are in [Published codemods](#published-codemods)), and every command of the fs image (`copy`, `move`, `remove`, `remove-matching`, `unwrap`, `wrap`) |

The image reports it (`"kind"` in its ok report), the subject starts with it (`sweep(prettier format): src/**`),
the commit carries it in the `Refactor-Kind` trailer, and the binary's success JSON has it as `kind`.
Any other value is `IMAGE_FAILED`. To list the commits of one kind:

```sh
git log --grep '^Refactor-Kind: rewrite'
```

## Config: `.jig.json` (optional)

```json
{ "coAuthor": "jig <jig@dral.dev>" }
```

`coAuthor` is the only key. Any other key is an `INVALID_ARGS` error rather than being silently ignored.

## Errors

These come back as `{"schema":"urn:jig:output:1","ok":false,"code","instructions"}` with
exit code 1; `instructions` say what to do next:

`SYMBOL_NOT_FOUND`, `AMBIGUOUS_SYMBOL`, `DIRTY_WORKTREE`, `REFACTOR_UNAVAILABLE`, `NO_CHANGES`,
`UNKNOWN_ACTION`, `INVALID_ARGS`, `IMAGE_NOT_FOUND`, `IMAGE_FAILED`, `REGISTRY_UNAVAILABLE` (a registry
could not be reached, or sent bytes not matching their digest), and `INTERNAL` for anything else.
An image that reports `REGISTRY_UNAVAILABLE` or `INTERNAL` (it crashed) or a code not in this list is
`IMAGE_FAILED`.
A git or docker process (or the image's container) killed by a signal is reported as "killed by signal
N", not as an exit code. An interrupted run is `INTERNAL` with exit code 130, 143 or 129 (see above).

## Container images

Each tool is one image, `localhost/jig/<tool>:local`, for `typescript` (the typescript actions,
`rename`, `extract`, …, with TypeScript 6.0.3 bundled), `prettier` (`format`, with one pinned
prettier 3) and `codemod-react` (one action per react-codemod transform, see
[Published codemods](#published-codemods)). Each image states its own name, the `<image>` in its commit
subjects: `typescript`, `prettier`, `codemod-react`, `fs`. The base is `node:26.13.1-slim`, which runs the TypeScript source directly. The entrypoint is
`node /app/packages/<pkg>/src/bin.ts`.

The `fs` image ([fs](#fs)) is the exception: no Node. It is `busybox:1.38.0` plus the static (musl)
Nushell 0.117.0 release binary, checked against its SHA-256 at build time, and one script,
`containers/fs/fs.nu`, which writes the report itself. Its entrypoint is `nu --no-config-file /app/fs.nu`.

```sh
sh scripts/build-images.sh [tool...]  # builds every containers/*/Containerfile (or the named tools),
                                      # prints one line per image: <tool> <tag> <id>
sh scripts/update-lockfiles.sh [--fresh] [tool...]
                                      # regenerates containers/*/package-lock.json, prints <tool> <path>
```

The images install from the committed `containers/<tool>/package-lock.json` with `npm ci`, so run
`update-lockfiles.sh` after changing a manifest (a `package.json` of the packages an image copies, or
`containers/<tool>/package.json`) and commit the result. A lockfile has to come from the manifests *after* the
Containerfile's rewrite step (it drops `workspace:` dependencies and `devDependencies`), so the script
copies the manifests the Containerfile copies into a temporary directory, runs the Containerfile's own
`RUN node -e '...'` rewrite there, then `npm install --package-lock-only` (npm's user config is not read, so the
registry is the default npmjs one). By default the versions already pinned stay and only
what the manifests changed moves; `--fresh` resolves every range again. It uses `$NODE`'s npm, else the
Node 26 on `PATH`, else the one in `~/.local/share/node`, like `test-packages.sh`.

Image contract:

- `/workspace` is the working directory and holds only the files of `HEAD`: no `.git`, and no
  dependencies installed from outside `HEAD`.
- The args are passed verbatim; `args[0]` is the action name.
- The container has no network, a read-only root filesystem, and `/tmp` as its only writable place
  besides `/workspace`.
- Success: exit 0, and the last stdout line is a [report v1](#image-report-v1) with `"ok": true`.
- Failure: a non-zero exit, and the last stdout line is a report v1 with `"ok": false`, `code` and
  `instructions`.

## How the typescript image sees a project (best effort)

What it can see is rewritten; anything else stays as it is, and the caller's own typecheck afterwards
catches what was missed.

- The project for an action is the folder of the nearest `tsconfig.json` above `--file`, or the repo
  root when there is none. Every `.ts`/`.tsx`/`.mts`/`.cts` file under that folder is in the project,
  whatever the tsconfig's `include`/`exclude`/`files` say.
- The tsconfig's `compilerOptions` apply, so `paths` aliases inside the project are rewritten too. An
  `extends` that cannot be resolved (an npm package, absent without `node_modules`) is ignored.
- No workspace links, no `node_modules`, no other tsconfigs: in a monorepo, a rename in `packages/core`
  does not rewrite `packages/app`'s `@x/core` imports.
- For the sweeps (`organize-imports` and the others that take `--files`), each matched file uses
  its own nearest tsconfig the same way.

## lift-out

Moves a function or `const` nested (at any depth) inside the top-level declaration `--in` up to module
level, placing it right above that declaration and removing one level of indentation. **Every local it uses
moves with it**, transitively and in source order. With `--to`, all of them then move into that file the
way `extract` does, and the imports they use go with them. It all happens in one commit. It
refuses (`REFACTOR_UNAVAILABLE`) when:

- it uses a local that cannot move: a parameter, a type parameter, `let`/`var`, or a `const` with side
  effects (named in the instructions). `this`/`arguments` used from an arrow function also count. Pass
  them as parameters first;
- `--to` is given (or `extract` is used) and the moved code uses `import.meta`, whose meaning
  depends on the file;
- it is a `const` whose initializer is not a function or a literal (it could have side effects that
  would run at a different time);
- the name already exists at module level or as a global.

## Actions

Every action is `<image> <action> [flags]`. The tables give the kind, the flags and what it does, with
its main limits in a few words; what an action cannot handle is refused (`REFACTOR_UNAVAILABLE`, nothing
written, the instructions say what to do) or, for sweeps over many files, left alone and named in the
summary. `--files` is a comma-separated list of globs, matched against the files in `/workspace`, which are
the committed files, so a replay covers the same files. `--at <path>:<line>[:<column>]` (1-based) points at
a place: without a column it takes the one candidate that starts on that line (several is `INVALID_ARGS`,
asking for a column), a column picks the innermost one, and none is `REFACTOR_UNAVAILABLE`.

### refactor (typescript image)

| Action | Flags | What it does; limits |
|---|---|---|
| `rename` | `--file --symbol --to [--kind]` | renames a top-level declaration and all its references in the project; top-level only, no references across packages |
| `extract` | `--file --symbols a,b --to [--kind]` | moves top-level declarations to another file (TS "Move to file"), imports follow; refuses `import.meta`, re-exports not rewritten |
| `lift-out` | `--file --in --symbol [--to]` | lifts a nested function or `const` to module level, with the locals it uses ([details](#lift-out)); refuses parameters, `let`/`var`, side effects, name clashes |
| `move-file` | `--file --to` | moves or renames a file, rewriting the imports of and in it as `move-files` does (a group of one file); `--to` must be free |
| `move-files` | `--files --from --to` | moves the files `--files` matches (any type: `.ts`, `.css`, images) from the folder `--from` to the same place under `--to` (`src/old/x/y.ts` to `<to>/x/y.ts`); imports between them, from them and to them follow, each in its own style and extension form; files are moved byte for byte |
| `duplicate-files` | `--files --from --to` | copies them the same way; the copies' imports of each other point at the copies, their other imports are adjusted to the new place, and files outside the copies still import the originals |
| `remove-barrels` | `--files` | imports through a barrel (an `index.ts` that only re-exports) come from the defining module, barrels nothing imports any more are deleted; a barrel imported by non-TypeScript files stays, other packages' barrels are left, re-export cycles are refused |
| `params-to-object` | `--file --symbol` | a top-level function's positional parameters become one destructured object, every call passes an object (TS "Convert parameters to destructured object"); refuses overloads, no/rest/destructured parameters and uses that are not calls |
| `inline-function` | `--file --symbol [--at]` | unpacks calls of a top-level function or arrow `const`. With `--at`, only that call (the declaration stays); without, every call, and the declaration goes. All or nothing; same module only, no generics, async, generators, recursion, `this`, early returns, optional/rest/default parameters; comments inside the body are not carried over |
| `template-string` | `--at` | a `+` chain with a string literal becomes a template literal (TS "Convert to template string"); refuses operands that are not primitives (`valueOf` vs `toString`) and comments inside the chain |
| `remove-unused-variable` | `--at` | removes the unused `const`/`let`/`var` or destructured element at the name; refuses parameters, catch/loop variables, exports, side-effecting initializers, and destructuring that could run code |
| `convert-function` | `--at --to arrow\|function` | converts a function declaration or expression to a `const` arrow function, or the reverse; refuses `this`/`arguments`/generators/`new`/default exports, and uses before the `const` (only the same file is checked for hoisting) |

`move-files`, `duplicate-files`, `move-file` and `rename-files` share one core. It reads every reference
without building a program (`import`/`export … from`, `import()`, `require()`, `import x = require()`,
`import("…")` types, `/// <reference path>`, JSDoc `@import` and `import("…")` types in JavaScript, and
`new URL("…", import.meta.url)` with a plain string), resolves it with TypeScript under the importer's
nearest tsconfig, and touches it only when the importer or its target moves. A relative import stays
relative, an alias keeps its `paths` key, a subpath import keeps its package.json `imports` key, and the
extension form stays (`./a`, `./a.ts`, `./a.js`, `./dir`); the new specifier must resolve to the new place.
A `new URL` path is relative to its file (`./x`, `../x`, or a bare `x`, which stays without `./`) and names
the file exactly; other schemes (`https:`, `data:`) and absolute paths are left alone. Packages never change
(one that does not resolve is skipped). Every match of `--files` must be under `--from`, and `INVALID_ARGS`
refuses no match, a match outside `--from`, `--from` equal to `--to`, a new path that already exists, a
group holding a `tsconfig*.json`, `jsconfig.json` or `package.json`, and a group holding a file but not its
declaration file, or the reverse (`foo.js`/`foo.jsx` and `foo.d.ts`, `foo.mjs` and `foo.d.mts`, `foo.cjs`
and `foo.d.cts`, `foo.css` and `foo.d.css.ts`; a `.ts` file has none). Any reference that cannot follow
refuses the whole action (`REFACTOR_UNAVAILABLE`, nothing written, every problem listed with its file and
line): one that does not resolve, a package-style specifier (bare name, `baseUrl`, workspace package) or an
exact `paths`/`imports` key that reaches a moved file, one that reaches its file by another path than it
names, a new place outside the alias's or subpath's folder (or a project without that key), a new specifier
that would not resolve, a query import (`./icon.svg?react`) in a moved file or of a moved file from any
file (jig does not rewrite those yet), a `new URL` that would need to change but names no file (a folder URL whose files all move
included) or has a query, hash or percent-escape, and a moved source file that would leave the
`include`/`files` of its tsconfig. tsconfig.json and package.json are never edited, and nothing is
type-checked: the resolution check is the safety net.

### sweep

| Action | Flags | What it does; limits |
|---|---|---|
| `format` (prettier image) | `--files` | formats the matching files with the repo's own prettier config, or prettier's defaults when there is none or it fails to load; config plugins are ignored |
| `organize-imports` | `--files` | merges, sorts and drops unused imports (TS `organizeImports`) |
| `add-import-extensions` | `--files` | relative imports, re-exports and `import("...")` get the real extension (`./a` to `./a.ts`, `./dir` to `./dir/index.ts`), and the tsconfig gets `allowImportingTsExtensions` when needed (it must have `noEmit` or `emitDeclarationOnly`); refuses a file that would gain errors |
| `subpath-imports` | `--files [--alias @/]` | imports through a tsconfig `paths` alias become Node subpath imports (`#/x`) and the package.json gets `imports`; unresolved or outside-folder specifiers are left alone (named in the summary); `require()`, `import x = require()` and `.js` importers are not handled |
| `imports-to-relative` | `--files --targets` | alias and subpath imports in `--files` that resolve to a file matching `--targets` (`**` for all) become relative imports (`../lib/date`) resolving to the same file; targets outside the importer's project folder are left alone (named in the summary) |
| `imports-to-alias` | `--files --targets --alias @/` | relative and subpath imports become imports through the importer's tsconfig `paths` entry `@/*` (one `<folder>/*` target), which must exist (else `INVALID_ARGS`); targets outside that folder are left alone (named) |
| `imports-to-subpath` | `--files --targets --prefix #/` | relative and alias imports become subpath imports through the nearest package.json's `imports` entry `#/*` (a string `./<folder>/*`), which must exist (else `INVALID_ARGS`); extensionless and folder imports cannot be subpath imports and are left alone (named) |

The three `imports-to-*` sweeps resolve every specifier (`import`/`export … from`, type-only, `import()`,
`import x = require()`, `require()`, `import("…")` types) with TypeScript under the importer's project, and
write the new one in the same extension form (`./a`, `./a.ts`, `./a.js` for `a.ts`, `./dir` for its index
file), keeping it only when the old specifier names that same path (only the prefix changes) and the new
one resolves to the same file. Packages never change: bare specifiers, those matched only by a catch-all
`"*"` paths key, and anything resolving into `node_modules` (`"#dep": "dep"` too). Nor do imports already in
the target style (an alias stays an alias whatever its prefix, a `#` import stays as it is). Imports that do
not resolve, that use an exact (non-wildcard) `paths` or `imports` key, whose form is unclear, that reach
their file by another path than they name (a folder whose package.json `types` points at a declaration
file elsewhere), that would not resolve back to the same file, or whose file would gain errors are left
alone and named in the summary. tsconfig.json and
package.json are never changed; only TypeScript importers are looked at.
| `default-to-named` | `--files [--keep globs]` | `export default` of a named function, class, interface or value becomes a named export and importers switch; anonymous defaults, `import()`/namespace/`require`/mock users and name clashes are left alone (named in the summary); JavaScript importers are only scanned syntactically |
| `infer-return-types` | `--files [--exported-only true\|false]` | adds the inferred return type to functions without one (TS "Infer function return type"), exported ones only unless `false`; types holding an unwritten `any` or `import("...")`, or not in scope, are left alone (named in the summary) |
| `namespace-to-named` | `--files` | `import * as x` becomes `import { a, b }` (TS "Convert namespace import to named imports"); only when every use is `x.name`, else left alone (named in the summary) |
| `import-type` | `--files` | imports and specifiers used only as types become `import type` (TS type-only fix-all); a default import sharing its statement with named imports, or a file that would gain errors, is left alone (named in the summary) |
| `rename-files` | `--files --case kebab\|camel\|pascal\|snake` | renames files to the case (the part before the first dot) with move-file's import rewriting; collisions, `index.*` and odd names are left alone (named in the summary), path strings outside imports (`vi.mock("./x")`) are not rewritten |

### rewrite

| Action | Flags | What it does; limits |
|---|---|---|
| `remove-console` | `--files [--methods log,debug]` | removes `console.<method>(...)` statements (default `log`), with a same-line comment; a call whose value is used is left alone (named in the summary), and as the body of an `if` or loop it leaves `{}` (or drops an `if` with a pure condition) |
| the transforms (codemod-react image) | `--files [--parser]` | each react-codemod transform is an action of its own; kinds, parsers and limits in [Published codemods](#published-codemods) |

### fs

The fs image (`localhost/jig/fs:local`) changes the shape of the folder tree. Every command is a
`rewrite`: jig cannot promise that moving or removing files keeps a project working. It moves bytes
only; imports are not updated (that is `move-file`, `move-files` and `duplicate-files`).

| Command | Flags | What it does; limits |
|---|---|---|
| `copy` | `--from --to` | copies a file or a folder; symlinks stay links, file modes are kept |
| `move` | `--from --to` | moves or renames a file or a folder; `--to` must not be inside `--from` |
| `remove` | `--paths a,b` | removes files and folders (every path must exist) |
| `remove-matching` | `--files <glob,glob>` | removes every file and symlink a glob matches (dotfiles too, never folders; the summary lists them; no match is `NO_CHANGES`) |
| `unwrap` | `--folder` | moves everything in the folder (dotfiles too) up one level and removes the folder; any name that collides with one already there refuses the whole run; a folder with no files in it is `NO_CHANGES` |
| `wrap` | `--paths a,b --into` | moves the paths into a new folder; `--into` must not be inside a path, and two paths with the same base name are refused |

A destination must be free: nothing may exist there, a dangling symlink included. No command
overwrites or merges. Missing parent folders of a destination are created. Paths are relative to the
repo root; a leading `./` and a trailing `/` are dropped. Lists (`--paths`, `--files`) are split on
commas, each item trimmed, empty items dropped. Refused with `INVALID_ARGS`: an absolute path, an empty
one, the root itself (`.`), a `..` or `.git` part, a part made only of dots (`...`) or starting with `~`
(Nushell would expand them out of the repo; globs too), and a path that goes through a symlink or a
file. Every check runs before anything is touched, so a refusal changes nothing.

## Published codemods

`codemod-react` (`containers/codemod-react`) carries **react-codemod 5.4.4** run with **jscodeshift 0.11.0**
(both pinned, installed at build time, so it runs offline):

```sh
dist/jig --repo <repo> localhost/jig/codemod-react:local \
  <transform> --files <glob,glob> [--parser tsx|ts|babel|flow]
```

Every transform is an action of its own, named as the transform (`sort-comp`, `pure-component`,
`React-DOM-to-react-dom-factories`, …), with that transform's kind and its one-line description as its
summary. It runs the transform over the matching `.js/.jsx/.ts/.tsx` files (never `.d.ts`). The parser is
`--parser` if given, else `tsx`/`ts` by the file's extension, else the one the transform declares
(`flow` for `class` and `manual-bind-to-arrow`), else `babel`. Images install from a committed
`package-lock.json` (`npm ci`), so a rebuild resolves the same dependency versions. The commit subject
is `<kind>(codemod-react <transform>): <globs>` (for example `sweep(codemod-react sort-comp): src/**`),
and the summary names react-codemod's version and lists the changed files. An unknown action
(`codemod` included: it was the one action before the transforms became actions) is `UNKNOWN_ACTION`,
listing the transforms. A file a transform cannot parse is left alone, named in the summary. The kinds,
from what each transform does (`packages/action-codemod/src/catalog.ts`, which also has a one-line
description of each and the name of the image that carries the package; `--help` shows the kind and
description of every action):

| Kind | Transforms |
|---|---|
| `rewrite` | `rename-unsafe-lifecycles`, `class`, `error-boundaries`, `findDOMNode`, `pure-component`, `pure-render-mixin`, `react-to-react-dom`, `React-DOM-to-react-dom-factories`, `React-PropTypes-to-prop-types`, `ReactNative-View-propTypes` |
| `sweep` | `create-element-to-jsx`, `manual-bind-to-arrow`, `sort-comp`, `update-react-imports` |

`examples/react-app`'s `Counter` class component (legacy lifecycles) is what `rename-unsafe-lifecycles` changes.

## Layout (pnpm workspace)

| Path | What it holds |
|---|---|
| `swift/report` | Swift: error codes, the image report v1, the `Refactor-Command` JSON, commit message, output JSON, the verify verdict and its JSON |
| `swift/process` | Swift: the child-process runner and the signal lifecycle (module `ChildProcess`) |
| `swift/docker` | Swift: what the sandboxes that use the Docker CLI share (missing image or unreachable daemon; removing a container, also one the daemon creates late) |
| `swift/git` | Swift: git with a cleaned environment and exact paths, the export and capture (`Workspace`), the checks on what an image left, the fast-forward |
| `swift/sandbox` | Swift: the `Sandbox` protocol (resolve, run, cleanup) and its shared types; no implementation |
| `swift/oci` | Swift + zlib: registry images without Docker (references, manifests, the registry client, jig's OCI-layout store, layer unpacking, archives for `docker load`) |
| `swift/sandbox+docker` | Swift: `DockerSandbox`, the image run with `docker run` (its README lists its known flaws) |
| `swift/sandbox+rootlesskit` | Swift + C: `RootlesskitSandbox`, the image run as a direct child with rootlesskit, `pivot_root`, dropped capabilities and seccomp (its README holds the sandbox findings) |
| `swift/cli` | Swift: the `jig` executable (arguments, config, `RunImage.swift`: the flow, the choice of sandbox) |
| `swift/cli/Tests/IntegrationTests` | end-to-end tests that run `dist/jig`, and the test-only probe image (`probe/`) |
| `packages/core` | shared types (`Action`, `ActionResult`), errors, the report v1 (`okReport`) and entrypoint helper |
| `schemas/` | the JSON Schemas of the image report and the binary's output, and example documents |
| `packages/engine-typescript` | `TsEngine` (TypeScript 6 language service), the typescript actions and their image entrypoint |
| `packages/action-prettier` | the format action and its image entrypoint |
| `packages/action-codemod` | the published-codemod entrypoint (jscodeshift runner, one action per transform) and its table of transforms, their kinds and descriptions, and of the image carrying each package |
| `packages/test-utils` | `makeRepo`, `readTree`, fixtures |
| `examples/` | small example repos used by the tests and as CLI demos (see below) |
| `containers/` | one Containerfile per image |
| `scripts/` | `build-images.sh`, `update-lockfiles.sh`, `build-binary.sh`, `test-packages.sh`, `test-swift.sh` |

## Example repos

`examples/` holds small realistic repos. The tests copy one into a temporary git repo
(`makeRepo("examples/webapp")` in the package tests, `temp.fixture("examples/webapp")` in the Swift
end-to-end tests), and they work as demos: copy one out, `git init` and commit it, then run the binary on
it.

- `examples/webapp`: a single-package app with a `@/*` path alias, barrels (`export *`, named and
  renamed re-exports, a nested barrel), default exports (function, class, const), namespace imports,
  functions with positional parameters and without return types, small helpers worth inlining,
  type-only imports written as value imports, `console.log` calls, and file names in mixed cases.
- `examples/monorepo`: two packages, `packages/app` importing `packages/shared` through its barrel
  (a tsconfig `paths` entry), each its own TypeScript project.
- `examples/import-styles`: one package whose imports mix relative, `@/*` alias (tsconfig `paths`) and
  `#/*` subpath (package.json `imports`) specifiers, for the `imports-to-*` sweeps.
- `examples/react-app`: a few React components (a class component with legacy lifecycles,
  `ReactDOM.render`) for published React codemods. React is not installed, so it does not typecheck.

`webapp` and `monorepo` typecheck on their own with the bundled TypeScript (a package test checks it).

## Tests

```sh
pnpm install && pnpm typecheck
sh scripts/test-packages.sh   # unit tests of packages/*, with node --test on Node 26
sh scripts/test-swift.sh      # swift test in every swift/ package, the end-to-end tests (swift/cli) last
sh scripts/test-swift.sh --skip IntegrationTests   # the Swift unit tests alone
```

`test-packages.sh` uses `$NODE`, else `node` on `PATH` when it is Node 26, else the Node 26 install in
`~/.local/share/node`. The end-to-end tests (`swift/cli/Tests/IntegrationTests`) need docker, network access
to pull `node:26.13.1-slim` the first time the images are built, and the Static Linux SDK (they build
`dist/jig`; see above). Once per run they build the action images (`scripts/build-images.sh`), the test-only probe image (`docker build` of
`swift/cli/Tests/IntegrationTests/probe`) and the binary (`scripts/build-binary.sh`), then run the real images against temporary repos made from
`packages/test-utils/fixtures` and `examples/`. Without docker they are skipped, with a message saying so.
The rootlesskit suite runs the same typescript rename and prettier format with `--sandbox rootlesskit`
(the same tree and report as docker) and its interruption tests; it is skipped without
`/usr/bin/rootlesskit`. The verify suite replays probe commits: fresh (identical), amended by
hand or with random output (different), ranges with hand-written and failing commits, from a dirty
subdirectory (nothing in the repo changes) and interrupted; plus one fresh-run verify with rootlesskit.

## Known limits (POC)

- TypeScript's "Move to file" does not rewrite re-exports (`export { foo } from "./a"`).
- References across package boundaries (workspace packages, an `extends` from npm) are not rewritten.
- Tool versions are fixed (TypeScript 6.0.3, one prettier) rather than matched to the repo's own, even
  when the repo has a `node_modules` committed. Prettier plugins in a config are ignored.
- jig's own images are built locally (`localhost/jig/...`) and not pushed to a registry yet, so a
  commit made with them verifies only on a machine with the same local image.
- Registry images: public images only (no credentials), no zstd layers, and the image store is never
  cleaned up by jig (see [Images](#images)).
- The host's `.gitignore` rules are respected: new files an image creates at ignored paths are skipped
  (not committed, never written into the repo), and an image that changes a `.gitignore` or
  `.gitattributes` file is rejected (`IMAGE_FAILED`).
- Paths must be valid UTF-8, in the repository and in what an image creates.
- No git hooks run.
- The export applies the host's git eol/smudge filters (`core.autocrlf`, LFS), so a replay is
  reproducible per host config.

## TODO

See `TODO.md`.
