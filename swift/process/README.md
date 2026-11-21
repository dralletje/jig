# process (module `ChildProcess`)

Child processes and the signal lifecycle. The module is `ChildProcess` so it does not clash with
Foundation's `Process`. Depends on `report`.

Public API:
- `runProcess(_:_:cwd:environment:stdin:gated:onStart:) -> ProcessOutput`: argv only (never a shell),
  the executable found on `PATH` (or a path), a process group of its own, stdout and stderr as raw
  bytes read concurrently, stdin written on a thread of its own, SIGINT/SIGTERM/SIGHUP/SIGPIPE back to
  their defaults in the child. `onStart` gets the PID (= process group) once it started.
  `ProcessOutput` has `termination`, `stdout`, `stderr` (and `*Text`).
- `Lifecycle.shared.signalGroup(_:_:)`: signals a group `runProcess` started, only while its leader is
  unreaped (what a sandbox's own `cleanup()` uses to stop its child).
- `Termination(waitStatus:)`; `CommandFailed` and `ExecutableNotFound` (both `RefactorErrorConvertible`:
  `INTERNAL` with what to check next); `findExecutable(_:)`.
- `installInterruptHandlers(report:)`: SIGINT, SIGTERM and SIGHUP are handled on a queue of their own.
  Outside the merge window an interruption stops gated spawns (their thread parks), sends SIGTERM to
  every process group `runProcess` started, SIGKILL to those still there after 2 s, and waits for them
  (a group is only signalled while its leader is unreaped, so a reused PID is never hit), runs the
  cleanups in the order they were added, prints `report(signal, landed, leftovers)` (`leftovers`: what
  the cleanups could not remove) and exits with 128 + the signal number.
- `Lifecycle.shared`: `addCleanup(_:)` and `addCleanup(reporting:)` (returns what it could not remove;
  the CLI adds the sandbox's `cleanup()`, then the workspace's removal), `gated(_:)` (runs a body unless
  interrupted, else parks: for making what a cleanup removes), `unlessInterrupted(_:)` (skips a body
  once the interruption's cleanup owns the work), `mergeWindow(commit:landed:_:)` (an interruption during the fast-forward waits for it and
  learns whether the commit landed), `isInterrupted`.
- `finishRun(_:status:)`: prints the one JSON line and exits, unless an interruption is being handled.
- `signalName(_:)`.
