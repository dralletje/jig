# sandbox (module `Sandbox`)

The contract between the CLI and the places an image can run. No implementation (see
`../sandbox+docker`, `../sandbox+rootlesskit`). Depends on `report`.

```swift
public protocol Sandbox: AnyObject, Sendable {
  func resolve(_ reference: String) throws -> PinnedImage
  func run(_ image: PinnedImage, arguments: [String], workspace: URL) throws -> SandboxRun
  func cleanup()
  var leftovers: [String] { get }  // default: []
}
```

- `resolve`: an image reference to its pinned identity. A pinned reference (`<name>@sha256:<id>`, a
  replay) resolves to itself as long as what it pins exists here (a local image ID); anything else is
  pinned to the ID it names now. No such image:
  `RefactorError` `IMAGE_NOT_FOUND` with instructions.
- `run`: the pinned image with `arguments` as its argv (after its entrypoint, never through a shell);
  `workspace` read-write at `/workspace`; no network. The image sandboxes (docker, rootlesskit) also
  make `/workspace` the working directory, the image's filesystem read-only and `/tmp` a writable
  scratch folder. Returns `SandboxRun`: the action's own `Termination` (exit code, or the signal that killed it, not a wrapper's status) and its raw stdout and stderr bytes. A
  failing action is a result; only a failure of the sandbox itself throws.
- `cleanup`: kills and removes everything the current run started (processes, container, mounts,
  temporary folders); when it returns nothing of the run is left. Idempotent, callable from another
  thread at any time (also while `run` is in progress or returning, and when nothing ran); only
  ungated processes (`runProcess(..., gated: false)`); failures are a line on stderr.
- `leftovers`: what the last `cleanup()` could not remove, each naming it and how to remove it by hand
  (`the container X (remove it: docker rm -f X)`); the interruption's instructions list them instead of
  claiming a clean state. The default implementation returns `[]`.

How the CLI uses it: one instance per invocation, chosen with `--sandbox docker|rootlesskit`; `resolve`
once, `run` once on the exported workspace. On SIGINT, SIGTERM or SIGHUP the CLI's lifecycle first
stops every process group started through `ChildProcess.runProcess` (SIGTERM, 2 s, SIGKILL) and waits
for them, then calls `cleanup()`, then removes the workspace (the run itself never removes it once an
interruption started: the image may still be writing into it until `cleanup()` returns).

Shared types: `PinnedImage` (`id` = `sha256:<64 hex>`, `reference` = `<name>@sha256:<64 hex>`, the
`image` recorded in `Refactor-Command` and the output) with `PinnedImage.split(_:)`; `SandboxRun`.
Docker and rootlesskit pin the same thing (the local image ID), so a commit made with one replays with
the other.
