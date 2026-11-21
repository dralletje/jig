# cli (the `jig` executable)

The binary: `jig [--repo <path>] [--message <text>] [--sandbox docker|rootlesskit]
<image> [args...]`, and `jig verify [--repo <path>] [--sandbox docker|rootlesskit]
<commit-or-range>`. Depends on every other package. `scripts/build-binary.sh` builds it as a static Linux
binary into `dist/jig`.

Library target `RefactorCLI` (used by `main.swift` and the unit tests):
- `parseCommand(_:) -> Command` (`.run(CLIArgs)`, or `.verify(VerifyArgs)` when the first argument is
  `verify`), `CLIArgs.parse(_:)`, `usage`, `SandboxKind` (`docker`, the default; `rootlesskit`).
- `makeSandbox(_:)`: `DockerSandbox` or `RootlesskitSandbox`. A rootlesskit sandbox this
  machine cannot run (no `/usr/bin/rootlesskit`) is `INTERNAL` with what to install; no docker on `PATH`
  is `INTERNAL` from `DockerSandbox` (or from the rootlesskit sandbox, which uses Docker to get
  `localhost/` images) with the same kind of instructions. Registry images come from `swift/oci`'s
  store, downloaded by the sandbox's `resolve`; the cli itself uses `OCI` only for `isLocalImage`.
- `Config`, `loadConfig(repo:)` (`.jig.json`, only `coAuthor`).
- `runImage(repo:image:args:message:sandbox:) -> RunResult`: clean repo → config → `sandbox.resolve` →
  export of HEAD → `sandbox.run` → report → checks → capture → commit (`commit-tree`, no hooks) →
  fast-forward → files changed. The export → run → report → checks → capture steps are
  `replay(git:base:pinned:args:sandbox:) -> Replayed`, shared with verify. `RunResult.notes` holds
  `PinnedImage.note` (a cached image used because its registry could not be reached), and
  `RunResult.json` prints it as the output's `notes`, left out when empty.
- `verifyCommits(repo:target:sandbox:) -> [CommitVerification]`: see Verify below.
- `interruptedJSON(signal:landed:leftovers:)`: the line printed when a run is interrupted (it names what
  was running: the container or the sandbox; `setInterruptedSandbox(_:)`).

`main.swift` installs the interrupt handlers, parses the arguments (`parseCommand`), makes the sandbox,
adds its `cleanup()` to the lifecycle (the same for a run and a verify), runs or verifies, and prints
exactly one JSON object. The rootlesskit sandbox's own
hidden modes (launcher, in-sandbox init) run before `main`, from a C constructor.

## Verify

`verifyCommits` resolves `<commit>` (`rev-parse --verify <x>^{commit}`) or lists `<range>` (`rev-list
--reverse --no-merges`), reads each commit's trailers (`readCommitTrailers`, git's own parse of the last
paragraph), resolves the recorded image with the sandbox and calls `replay` on the parent. Nothing is
committed and the repo's work tree, index, refs and config are not written (no `assertClean`, so a dirty
work tree is fine). The replayed tree is compared with the commit's (`diff-tree -r --no-renames
--name-only -z` gives `filesDiffering`), and `verdict(...)` in `Report` compares the trees, the kind and
the subject. Only `Refactor-Command` and `Refactor-Kind` are read; other trailers (such as the
`Refactor-Status` and `Refactor-Effect` an older jig wrote) are ignored. A single commit without
`Refactor-Command`, a root or merge commit, unreadable trailers or an unpinned recorded image
(`PinnedImage.split` is nil) throw `INVALID_ARGS`; in a range they are `skipped` (with `reason`) or
`invalid`; a range with no commits (or only merges) throws `INVALID_ARGS`. A failure to resolve or replay
is `failed` with its `code` and `instructions`, and a range goes on; an `IMAGE_NOT_FOUND` there gets
instructions for its kind of image (a `localhost/` image needs that exact local ID in this machine's
Docker; a registry image is downloaded by its pinned digest, which the registry must still have).
`main.swift` prints `verifyJSON(...).json` (`urn:jig:verify:1`) and exits 0 when it is `ok`, 1 otherwise.

Tests: `CLITests` (unit) and `IntegrationTests` (end to end: they build the action images, the probe
image in `Tests/IntegrationTests/probe` and the static binary once per run, then drive the binary with
git and docker; skipped without docker). The probe's modes fake the ways an image can behave; its
`status` mode reports a `status` key v1 no longer has, which must be `IMAGE_FAILED`. The rootlesskit
suite repeats the typescript rename and prettier format with `--sandbox rootlesskit` (same tree, report
and commit message as docker, and a docker commit replayed with rootlesskit) and the SIGTERM/SIGINT
interruption tests (skipped without `/usr/bin/rootlesskit`). The verify suites (`VerifyTests.swift`)
replay probe commits (the probe's `random` mode writes `r.txt` with random content, for `different`),
with one fresh-run verify for rootlesskit. The docker interruption suites (hardening, interruptions,
verify interruptions) run under one `.serialized` parent so they never overlap. The fs suite
(`FsTests.swift`) builds the fs image itself and runs every fs command on the `fs` fixture: each
commit verifies as identical, and each refusal leaves the repo untouched. `sh scripts/test-swift.sh`
runs this package last.
