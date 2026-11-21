# Swift packages, monorepo style, with pluggable sandboxes

Status: approved in conversation ("Split it up in packages, ideally concurrently! Make a sandbox+docker
package … Make sandbox+rootlesskit that uses rootlesskit to spawn it ourselves, with all the pivot_root
and protection stuff. Write the sandbox findings somewhere there too, in their package if possible.").
Builds on `feat/host-hardening` (signal cleanup, exact git paths, stricter reports). See `AGENTS.md`.

## Layout

The single `host/` package becomes several Swift packages under `swift/`, each with its own
`Package.swift`, sources, unit tests and a short README, depending on each other with
`.package(path: "../<name>")` (like `workspace:*` in pnpm). Directory names as the owner wrote them:

| Package | Holds | Depends on |
|---|---|---|
| `swift/report` | error codes, `RefactorError`, image report v1 parsing/validation, canonical JSON, SHA-256, effect hash, commit message, output JSON | — |
| `swift/process` | child-process runner (argv only, process groups, raw-byte output, signal-aware exit status), signal lifecycle helpers | `report` |
| `swift/git` | git wrapper (cleaned `GIT_*` env, raw-byte `-z` paths), export of HEAD, capture, ignore/`.gitattributes`/`.git`/gitlink checks, commit + fast-forward | `report`, `process` |
| `swift/sandbox` | the `Sandbox` protocol and shared types (image reference, pinned image, run result, cleanup contract); no implementation | `report` |
| `swift/sandbox+docker` | `DockerSandbox`: today's `docker run --rm --network none --read-only --tmpfs /tmp …` with a named container and `docker rm -f` cleanup, flaws and all | `sandbox`, `process` |
| `swift/sandbox+rootlesskit` | `RootlesskitSandbox`: spawns the action itself with rootlesskit + namespaces (below) | `sandbox`, `process` |
| `swift/cli` | the `jig` executable: argument parsing, config, `runImage` wiring, choosing a sandbox; the docker integration tests (`IntegrationTests` + probe image) | all |

Module names are Swift identifiers (`Report`, `Process`→`ChildProcess` if needed to avoid clashing
with Foundation, `Git`, `Sandbox`, `SandboxDocker`, `SandboxRootlesskit`); directory names keep the `+`.
`scripts/build-binary.sh` builds `swift/cli`. A small `scripts/test-swift.sh` runs `swift test` in
every package (integration last). `host/` is removed. README and docs are updated to the new paths.

## The Sandbox interface (in `swift/sandbox`)

Shape decided by the builder within this contract:
- resolve an image reference to a pinned identity (what goes into `Refactor-Command`), failing with
  `IMAGE_NOT_FOUND` + instructions;
- run the pinned image with argv on a workspace directory (mounted as `/workspace`, the working
  directory), no network, read-only image, writable `/tmp`, returning exit status (or signal), stdout
  and stderr bytes;
- `cleanup()` that is idempotent and safe to call from the signal path, killing everything the run
  started; after it returns nothing of the run is left (process, container, mount, temp dir);
- the CLI picks the implementation with `--sandbox docker|rootlesskit` (before the image, like
  `--repo`), default `docker` for now. The pinned image recorded in commits is the same for both
  (`<name>@sha256:<image id>`), so a commit made with one sandbox replays with the other.

## sandbox+docker

The current behaviour, moved behind the interface. Its README lists its known flaws: the container is
owned by the Docker daemon, not by the binary, so a SIGKILL of the binary can leave it running (the
named container + `docker rm -f` covers SIGINT/SIGTERM/SIGHUP only); needs a running daemon.

## sandbox+rootlesskit

Spawns the action as a direct child, no daemon.
- Image files: the pinned image's filesystem as a plain folder, created once with
  `docker create` + `docker export` (Docker is only used to obtain the files) into a cache under
  `$XDG_CACHE_HOME/jig/rootfs/<image id>/` (default `~/.cache/…`), written atomically
  (temp dir + rename) and checked before use (a marker with the image id; a damaged entry is rebuilt).
- Entry: `/usr/bin/rootlesskit --net=none --pidns --disable-host-loopback …` (the AppArmor exception on
  Ubuntu 24.04 is for that path), then inside it a private mount namespace.
- Hard requirements inside (all of them; this is the point of the package):
  - `pivot_root` into a fresh mount of the image folder (bind, then remount read-only), and detach +
    unmount the old root, so no host path is mounted anywhere in the sandbox (no `chroot`);
  - `/workspace` bind-mounted read-write from the export dir; `/tmp` tmpfs; private `/proc`; minimal
    `/dev` (null, zero, urandom, random, plus `/dev/shm` tmpfs if Node needs it);
  - the action runs as a non-root uid/gid inside the user namespace (e.g. 1000:1000, mapped), with all
    capabilities dropped (inheritable, permitted, effective, ambient, bounding set) and
    `no_new_privs`, via `setpriv` or the equivalent syscalls — so it cannot remount, chroot, unshare,
    mount or ptrace;
  - a seccomp filter denying at least mount/umount2/pivot_root/unshare/setns/ptrace/keyctl/
    add_key/request_key/bpf/perf_event_open/kexec*/init_module/finit_module/delete_module/
    open_by_handle_at/userfaultfd (builder may implement it in Swift with the seccomp BPF syscall, or
    use an existing tool if present without installing anything);
  - files written to `/workspace` end up owned by the invoking user on the host;
  - SIGKILL of the binary or of rootlesskit leaves nothing running (pid namespace + parent-death).
- Escape tests (integration, must fail to escape): read a host file outside the workspace (e.g. a
  marker in `$HOME`), write outside `/workspace`, remount the image read-write, `chroot`/`pivot_root`
  breakout, network connect, create a user namespace, `mount` anything; plus the normal actions
  (typescript rename, prettier format) through the CLI with `--sandbox rootlesskit`, with the same
  results and the same `Refactor-Effect` as with docker.
- The package README holds the sandbox findings: the Ubuntu 24.04 userns restriction
  (`kernel.apparmor_restrict_unprivileged_userns=1`), why plain `unshare`/bwrap fail, the rootlesskit
  AppArmor exception (`/etc/apparmor.d/rootlesskit`), what the prototype showed (≈1 s per run, no
  network, files owned by the user, SIGKILL leaves nothing), why the prototype's `chroot` was unsafe
  (chroot escape reaches the host home; root in the userns can remount the image read-write) and how
  this package closes each hole, plus the remaining shared-kernel caveat.

## Order of work

1. Restructure (one agent): `report`, `process`, `git`, `sandbox`, `sandbox+docker`, `cli`; behaviour
   unchanged; all tests green, including the integration suite via `--sandbox docker`.
2. In parallel after 1: `sandbox+rootlesskit` (runtime, cache, escape tests, README findings) and the
   CLI `--sandbox` wiring + integration tests running both sandboxes.
