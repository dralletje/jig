# sandbox+docker (module `SandboxDocker`)

`DockerSandbox`: the `Sandbox` that runs the image with the Docker daemon. Depends on `report`,
`process`, `sandbox`, `docker` (the daemon check and the container removal, shared with
`sandbox+rootlesskit`) and `oci` (registry images).

Public API: `DockerSandbox(puller: ImagePuller? = nil)`, with the `Sandbox` methods. The default puller
uses the store at `OCIStore.defaultRoot(environment:)` (`$XDG_CACHE_HOME/jig/oci`, else
`$HOME/.cache/jig/oci`) and the registries on the network; tests pass their own.
- `resolve` of a local image (`localhost/...`, `isLocalImage`): `docker image inspect --format {{.Id}}`;
  a pinned reference checks that its ID exists.
- `resolve` of a registry image (everything else): the `ImagePuller` resolves it into jig's store (the
  pin is the same as rootlesskit's: `id` = the manifest for this machine, `reference` = what was typed
  plus the digest the tag points to; `note` when the store's copy of a tag was used). When
  `docker image inspect jig-oci.invalid/<manifest hex>:image` (`dockerName(for:)`) does not find it,
  `writeDockerArchive` writes it to a temporary file in the store, `docker load -i` loads it and the file
  is deleted. Without `XDG_CACHE_HOME` or `HOME` there is no store: `INTERNAL` saying so.
- `run`: `docker run --rm --name jig-<uuid> --network none --read-only --tmpfs /tmp
  -v <workspace>:/workspace -w /workspace <image> <args...>`, where `<image>` is the local image ID, or
  the `jig-oci.invalid/...` name of a registry image. An image this instance did not resolve is resolved
  again from its `reference` first. `docker run`'s 128 + N (the container's process killed by signal N)
  is reported as `.signaled(N)`.
- `resolve` failing: `IMAGE_NOT_FOUND` only when the daemon (local images) or the registry answered; an
  unreachable daemon is `INTERNAL` with instructions about Docker; no `docker` on `PATH` is `INTERNAL`
  saying how to install it; an unreachable registry is `REGISTRY_UNAVAILABLE` (from the puller).
- `run`: exit 125–127 with docker's own error line (`docker: ...`) throws `INTERNAL` about Docker (docker
  failed, or could not invoke or find the image's command) instead of being read as the image's result.
- `cleanup`: deletes the archive of an interrupted load (it is recorded before it is created, under
  `Lifecycle.shared.gated`, so an interruption at any moment finds it); then `docker rm -f` of the run's
  container, then a look every 0.25 s for 3 s, removing a container the daemon creates late (from the
  killed client's request): `DockerCLI.removeContainer`. `leftovers` names the container (with
  `docker rm -f <name>`) when it is still listed afterwards, and the archive when it could not be deleted.

## Known flaws

- The container is owned by the Docker daemon, not by the binary. A SIGKILL of the binary (or anything
  else that skips its signal handlers) can leave the container running; the named container and
  `docker rm -f` cover SIGINT, SIGTERM and SIGHUP only.
- It needs a running Docker daemon (and `docker` on `PATH`).
- Registry images stay in Docker as `jig-oci.invalid/<manifest hex>:image` after the run; jig never
  removes them (`docker rmi` does; the next run loads them again from the store).
