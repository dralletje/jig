# docker (module `Docker`)

What the sandboxes that use the Docker CLI share (`sandbox+docker` runs images with it,
`sandbox+rootlesskit` copies images out with it). Depends on `report` and `process`.

- `DockerCLI(run:report:)`: docker commands through a runner of the caller's choosing (so each sandbox
  tracks its own processes; `DockerCLI(executable:)` uses `runProcess`). Failures it does not throw go to
  `report`, one line on stderr by default.
  - `daemonReachable()`: `docker version` needs the server.
  - `inspectFailure(reference:stderr:)`: a failed `docker image inspect` is `IMAGE_NOT_FOUND` when the
    daemon answered ("No such image", or it answers `docker version`), else `INTERNAL` with Docker's
    instructions.
  - `removeContainer(_:window:)`: `docker rm -f`, then a look every 0.25 s for `window` seconds
    (`lateCreationWindow`, 3 s), removing a container the daemon creates after its client was killed.
    Returns whether it is gone; a failed `docker rm` is reported.
  - `containerListed(_:)`.
- `inspectFailure(reference:stderr:daemonReachable:)`, `oneLine(_:)`, `dockerNextStep`.

Tests: a fake runner (late creation, a failing `docker rm`, no window, the daemon check).
