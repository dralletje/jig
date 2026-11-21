# sandbox+rootlesskit

`SandboxRootlesskit`: `RootlesskitSandbox`, the `Sandbox` (`swift/sandbox`) that runs an action image as
a direct child of the binary, with no daemon, using rootlesskit for the user namespace and a small
in-sandbox init (C, in this package) for everything else. Depends on `report`, `process`, `sandbox`,
`docker` and `oci`. Registry images come from jig's image store (`swift/oci`) without Docker; only
`localhost/...` images are taken from local Docker.
The CLI uses it with `--sandbox rootlesskit`.

## Sandbox findings on this machine (Ubuntu 24.04)

- **The user-namespace restriction.** Ubuntu 24.04 sets `kernel.apparmor_restrict_unprivileged_userns=1`:
  an unprivileged, unconfined process may create a user namespace, but it gets no capabilities in it.
  So plain `unshare --user --map-root-user …` and bubblewrap (`bwrap`) fail as soon as they try to mount
  anything (or are denied outright).
- **The rootlesskit exception.** `/etc/apparmor.d/rootlesskit` gives `/usr/bin/rootlesskit` (v3.3.0 here)
  an unconfined profile with the `userns` permission. Processes rootlesskit starts inherit that profile,
  so inside it user namespaces work fully, including the nested one this package creates. The exception
  is for that exact path: rootlesskit must be executed as `/usr/bin/rootlesskit`. (`/usr/bin/runc` is
  not covered; the exception for runc is for `/usr/sbin/runc`.)
- **What the chroot prototype showed** (`.superpowers/sdd/sandbox-prototype/`): about 1 s per action run
  (Node start-up dominates; the sandbox itself costs ~0.14 s, measured below), no network
  (`--net=none`: only a loopback), files written to `/workspace` owned by the invoking user, and SIGKILL
  of rootlesskit leaving nothing running (`--pidns`).
- **Why the prototype was unsafe**, and how each hole is closed here:
  1. *`chroot` escape reached the host's home.* `chroot` only changes the root of path lookups; the host
     filesystem stayed mounted, and a process root in the user namespace could chroot again with a
     cwd outside (the classic breakout) or walk `/proc/<pid>/root` of a process outside the chroot
     (rootlesskit's own child is PID 1 and its root is the host's). **Here:** `pivot_root` into a fresh
     bind of the image folder, then the old root is detached (`umount2(MNT_DETACH)`): no host path is
     mounted anywhere in the sandbox (the init checks `/proc/self/mountinfo` and refuses to run
     otherwise). The action is in a second PID namespace that contains only the sandbox's reaper and
     the action, so no outside process is visible in `/proc`. The action has no capabilities, and
     seccomp denies `chroot`/`pivot_root` anyway.
  2. *Root in the user namespace could remount the image read-write.* It held `CAP_SYS_ADMIN` there.
     **Here:** the action runs with every capability dropped (bounding, ambient, inheritable, permitted,
     effective), `no_new_privs`, locked securebits, and in a user namespace whose root is not mapped at
     all, so nothing can regain them; the mounts are additionally *locked* (they were created in a mount
     namespace of a more privileged user namespace than the action's), and seccomp denies `mount`,
     `umount2`, the new mount API, `unshare`, `setns` and namespace flags of `clone`.
- **The remaining caveat: the kernel is shared.** This is namespace isolation, not a VM: a kernel bug
  reachable from the allowed syscalls breaks it. The seccomp filter shrinks that surface (no `bpf`,
  `perf_event_open`, `userfaultfd`, `io_uring`, native AIO (`io_setup`, `io_submit`, `io_getevents`,
  `io_pgetevents`, `io_cancel`, `io_destroy`: `ENOSYS`, like `io_uring`, so programs fall back to plain
  reads and writes), keyrings, modules, …), but it is a deny list, not an
  allow list. Also inherent: the action runs as the invoking host user's kernel uid (that is what makes
  the workspace files theirs), so resource limits are shared with that user.

## How it works

```
jig (Swift)                                     host user, host namespaces
└ /proc/self/exe __jig-sandbox-launch-v1 …      arms PDEATHSIG(SIGKILL), checks the parent,
  = /usr/bin/rootlesskit --net=none --pidns …                execs rootlesskit (same process)
    └ rootlesskit child (PID 1 of P1)                        user ns U1 (host user = 0), no network
      └ outer init (this binary, __…-sandbox-init-v1)        U1 root, sees the host fs; not dumpable;
        │                                                    watches the lifeline, writes the status file
        └ reaper (PID 1 of P2)                               builds the root, pivot_root, nested user
          │                                                  ns U2, drops everything, seccomp
          └ action (PID 2 of P2)                             uid/gid 1000 in U2, cwd /workspace
```

1. **Image folder.** `resolve` routes by the reference (`isLocalImage`, `swift/oci`):
   - a **registry image** (anything not starting with `localhost/`, including `localhost:<port>/…`) is
     resolved by `ImagePuller` into jig's image store (`$XDG_CACHE_HOME/jig/oci`, or `Options.ociRoot`):
     `PinnedImage.id` is the manifest for this machine's platform, `reference` what was typed plus the
     digest its tag points to (an index digest for a multi-platform image), `note` says when a cached
     tag was used because the registry could not be reached. The sandbox keeps what `resolve` returned
     per `id`, so `run` asks the registry nothing; a `PinnedImage` it did not resolve is resolved again
     from its `reference` (the store first) and must name the same manifest. The first `run` of the
     manifest unpacks its layers from the store (`unpackLayers`) into the folder, with the
     entrypoint/cmd/env of the image's config blob. Docker is never used.
   - a **local image** (`localhost/…`): `resolve` runs `docker image inspect`. The first `run` of an
     image ID creates its folder: `docker create` + `docker export` (Docker only provides the files;
     nothing runs in it), `tar -x -p --no-same-owner`.

   The folder is `$XDG_CACHE_HOME/jig/rootfs/<hex id>/rootfs/` (default
   `~/.cache/…`), with the entrypoint/cmd/env in `config.json` and a `marker` (`jig rootfs
   v1` + the image ID or manifest digest). It is built in `.tmp-<pid>-<random>/` and renamed into place when complete, the
   marker written last. Before use the marker, config and folders are checked; a damaged entry is moved
   aside and rebuilt; build folders of dead processes are swept. The mount points (`proc`, `tmp`, `dev`,
   `workspace`) are made real directories at build time, and the init refuses symlinks there. A pinned
   reference whose folder is cached resolves without Docker.
2. **Entry.** The binary re-executes itself (`/proc/self/exe`) with a hidden first argument. A C
   constructor in `CSandboxInit` sees it before the Swift runtime starts (so the process is still
   single-threaded, which `unshare(CLONE_NEWUSER)` requires) and never returns. First as a *launcher*
   that sets `PR_SET_PDEATHSIG(SIGKILL)` and execs `/usr/bin/rootlesskit --net=none
   --disable-host-loopback --pidns --utsns --ipcns --cgroupns --propagation=rprivate --state-dir <run
   folder>/rk -- <binary> <init marker> …`; rootlesskit then starts the binary again as the *outer
   init*.
3. **Inside** (the reaper, in `sandbox_init.c`): new PID and mount namespaces; `/` made private; the image
   folder bind-mounted onto itself (not recursive); a private `/proc` (with `/proc/sys` and
   `/proc/sysrq-trigger` read-only); `/tmp` tmpfs (nosuid, nodev, noexec, like `docker --tmpfs`); a
   `/dev` tmpfs with `null`, `zero`, `urandom`, `random` bind-mounted, `fd`/`stdin`/`stdout`/`stderr`
   links, a `/dev/shm` tmpfs, then `/dev` remounted read-only; the workspace bind-mounted read-write
   (nosuid, nodev) at `/workspace`; the image remounted read-only (nosuid, nodev); `pivot_root(".", ".")`
   and `umount2(".", MNT_DETACH)`; the mount table verified. Then a nested user namespace in which only
   uid/gid 1000 exist, mapped to U1's 0 (= the host user), `setgroups` denied; another mount namespace
   (locks every mount); securebits, bounding set, ambient set, capset to zero (then read back and
   checked), `no_new_privs`, `RLIMIT_CORE` 0, the seccomp filter; fork the action (stdin `/dev/null`,
   cwd `/workspace`, only the image's environment plus `HOME`/`HOSTNAME` as docker adds them, the
   command looked up on the image's `PATH`). The reaper reports `exit N` / `signal N` / `error …` on a
   pipe; the outer init writes it to the run folder's status file. When the reaper exits, the kernel
   kills everything left in its PID namespace.

### Why uid 1000 inside, not 0 (and why files are still the user's)

rootlesskit maps the host user to uid 0 of its namespace and subordinate ids (100000+) to 1..65536; a
non-root uid *in rootlesskit's namespace* would be a subordinate id on the host and could not write the
workspace. Running the action as uid 0 there would satisfy ownership, but then the action is the
namespace's root (its capabilities are only one `execve` of a file with capabilities, or one mistake,
away). Instead the reaper creates a **nested** user namespace whose only uid, 1000, maps to rootlesskit's
0, i.e. the host user. The action is not root anywhere: uid 0 does not even exist in its namespace
(`setuid(0)` fails with `EINVAL`), and files it writes in `/workspace` belong to the invoking host user.

The flip side: every file of the image folder also belongs to the host user, so inside the sandbox
every image file appears owned by the action's uid 1000 (`/etc/shadow` of the image is readable, for
example; it is the image's own). File permissions therefore do not protect the image: the read-only,
locked mount does, and the escape tests check writes, `chmod` and `unlink` on image files and
remounting (all `EROFS`/`EPERM`).

### Nothing left behind

- SIGKILL of the binary: the kernel sends SIGKILL to rootlesskit (PDEATHSIG armed by the launcher before
  rootlesskit's exec, which nothing inside can clear). Independently, the outer init holds the read end
  of a *lifeline* pipe (rootlesskit's stdin) whose write end only the binary has; on EOF it kills the
  reaper. PDEATHSIG follows the *thread* that spawned: `run` is synchronous, so the spawning thread lives
  for the whole run.
- SIGKILL of rootlesskit: its child gets SIGKILL (rootlesskit's own PDEATHSIG), the outer init and the
  reaper have PDEATHSIG(SIGKILL) to their parents, and the reaper is PID 1 of the action's namespace.
- Anything inside that clears its own PDEATHSIG, double-forks and calls `setsid` still dies with the PID
  namespace.
- `cleanup()` SIGKILLs every run's process group, closes the lifelines, waits (`Options.reapWait`, 5 s)
  for the runs to reap, removes an export container in progress (`docker rm -f`, then a look every
  0.25 s for 3 s for one the daemon creates after its killed `docker create`: the same
  `DockerCLI.removeContainer` as `sandbox+docker`, from `swift/docker`) and removes run and build
  folders. `leftovers` names what it could not: a container still listed, processes not reaped in time,
  a folder still there, each with how to remove it by hand.
- The launcher is waited for with `WNOWAIT` and reaped under the registry's lock, the lock `cleanup()`
  signals launcher groups under, so a group ID the kernel has given to another process is never
  signalled.
- Run folders (status file, rootlesskit's `--state-dir`, which rootlesskit leaves behind when killed)
  of processes that no longer exist are swept at the start of the next run. All mounts live in private
  mount namespaces and disappear with them.

## API

```swift
let sandbox = RootlesskitSandbox(options: .init())        // Options: rootlesskit, docker, cacheRoot, ociRoot, registry, …
let image = try sandbox.resolve("localhost/jig/typescript:local")  // PinnedImage(id:, reference:, note:)
let pulled = try sandbox.resolve("ghcr.io/acme/tool:1.0")  // from jig's image store, downloaded when needed
let result = try sandbox.run(image, arguments: ["typescript-rename", …], workspace: dir)   // SandboxRun
// result.termination: .exited(Int32) | .signaled(Int32); result.stdout / result.stderr: Data
sandbox.cleanup()                                          // idempotent; afterwards runs are refused
RootlesskitSandbox.unavailableReason()                     // nil when /usr/bin/rootlesskit is usable
```

`run(image, command:, workspace:)` replaces the entrypoint (the tests run their probe that way). Errors
are `RefactorError` (`IMAGE_NOT_FOUND`, `REGISTRY_UNAVAILABLE`, `IMAGE_FAILED` (a layer that would
write outside the image folder) or `INTERNAL`, with instructions; no docker on `PATH` says to
install it; a daemon that cannot be reached is `INTERNAL` with Docker's instructions, as in
`sandbox+docker`; no `tar` says to install it); a failing *action* is not an error, it is a result with
its exit status.

**Requirement on the executable:** the binary that links this package is re-executed as the launcher and
the init. Nothing to call: linking is enough (the constructor runs before `main`), and an ordinary start
of the binary only pays one read of `/proc/self/cmdline`.

## Mapping onto `Sandbox` (`swift/sandbox`)

`RootlesskitSandbox` conforms to `Sandbox` directly and uses its types:

| `Sandbox` | here |
|---|---|
| resolve image reference → pinned identity | `resolve(_:) -> PinnedImage` (`reference` = `<name>@sha256:<id>`, the same string as `sandbox+docker`, so commits replay with either) |
| run pinned image with argv on a workspace | `run(_:arguments:workspace:) -> SandboxRun` |
| exit status or signal + stdout/stderr bytes | `Termination` (`report`), `stdout`, `stderr` (`Data`) |
| `IMAGE_NOT_FOUND` + instructions | `RefactorError(code: .IMAGE_NOT_FOUND, …)` |
| idempotent, signal-safe `cleanup()` | `cleanup()`; `leftovers`: what it could not remove |

Docker and tar run through `swift/process`'s `runProcess` (so the CLI's interruption stops them like its
other children; `cleanup()` kills them with `Lifecycle.shared.signalGroup`, which never signals a reaped
group). Only the launcher is started by this package's own `Spawner`: its stdin is the lifeline pipe and
its PID must be registered before anything else happens. In the CLI, an interruption first stops the
processes `runProcess` started, then calls `cleanup()`, which SIGKILLs rootlesskit's group (the PID
namespace goes with it) and removes the run folder.

## Tests

`swift test` runs the unit tests (argument building, status parsing, cache: atomic build, marker,
every kind of damage rebuilt, stale folders swept; registry images from a fake registry
(`RegistryImageTests`, an in-memory `HTTPTransport`): `resolve` pins the manifest and records the
index digest, the image folder is unpacked from the store with the image's config and no second
registry call, a pinned image is rebuilt from the store with the registry offline, a `localhost/`
reference still goes to Docker, and, with rootlesskit and `cc`, a static program in the image runs with
`docker` pointing nowhere) and the integration tests, which skip without
`/usr/bin/rootlesskit`, docker, the action images or `cc`:

- parity with `docker run`: typescript rename and prettier format on a copy of
  `packages/test-utils/fixtures/simple` give the same stdout, stderr and files; files belong to the user;
  exit codes, signals and binary output pass through; a damaged cache entry is rebuilt from Docker;
- escape tests with a static C probe (`Tests/SandboxRootlesskitIntegrationTests/probe/probe.c`): host
  files, writes outside `/workspace` and into the image, remounting, `chroot`/`pivot_root`, network,
  user namespaces, mounts, and other privileged calls, each asserting the exact errno; native AIO and
  `io_uring` answer `ENOSYS` inside (the same probe reaches them on the host);
- SIGKILL of the binary, of rootlesskit, of the reaper and of the action, with a payload that clears its
  PDEATHSIG and double-forks, and `cleanup()`: nothing survives.

The cache used by the tests is `$TMPDIR/jig-rootlesskit-test-cache-<uid>` (kept between
runs). `rootlesskit-sandbox-run [--cache <dir>] [--command] <workspace> <image> [args…]` is a small
front end for trying it by hand.
