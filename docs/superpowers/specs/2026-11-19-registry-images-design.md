# Registry images: jig downloads images itself

Status: draft for the owner's approval.

## Intent

Today jig only runs images that already exist in local Docker, and pins them by Docker's local image
ID. So a commit made on one machine can only be verified on a machine with that exact local image.
The owner wants jig to download images from container registries itself, so anyone can verify a
commit, while keeping local images for development.

"Docker" and "Docker Hub" in the owner's words mean container registries in general: ghcr.io,
Docker Hub, Quay, a self-hosted registry. Anything that speaks the OCI distribution protocol.

## Goals

- `jig <registry image> ...` downloads the image from its registry when needed and records it pinned
  by its registry digest, so `jig verify` on any machine downloads exactly that image.
- A tag resolves to what the registry has now. When the registry cannot be reached, jig uses the
  version it last saw for that tag and says so in its output (the owner: "it is fine if jig
  sometimes uses the cached version").
- jig keeps its own image store, independent of the sandbox ("runner"): one download place that
  both sandboxes take images from.
- The registry code lives in a new package `swift/oci`, written by us, not tied to Docker.
- `localhost/...` references keep working as today: taken from local Docker, pinned by local image
  ID. The user knows the verifying machine must also have that image.

## Non-goals (left out on purpose, the owner's decision)

- Building and pushing jig's own images from CI.
- Signing and signature checks (cosign).
- Multi-arch builds of jig's images.

## Anti-goals

- No new program to install. The binary needs nothing at runtime but `git` and its sandbox's needs.
  No `skopeo`, `crane` or similar.
- No borrowed registry library (apple/containerization, swift-container-plugin): the owner chose to
  write our own. Its heavy dependencies would also bring back the slow builds.
- A replay must never run something other than what the commit pinned. Falling back to a cached
  version applies to *tags* only, never to a pinned digest.

## Approaches considered

- **A. Own registry client and own store (picked).** `swift/oci` talks to registries, saves images
  in the standard OCI image layout under jig's cache folder; rootlesskit unpacks from the store
  itself, the docker sandbox loads from the store into Docker. One download place, no new runtime
  dependency. Costs the most code: the client, the store and layer unpacking.
- **B. Own client only to resolve tags, then `docker pull` by digest.** Little code, but images
  live in Docker's storage, and rootlesskit keeps needing Docker. Misses "own place,
  runner-independent".
- **C. Call `skopeo`/`crane` to fill the store.** Less code than A, but adds a program every machine
  must install.
- Existing Swift packages were checked first: `ContainerizationOCI` (apple/containerization) is a
  real library but pulls in swift-nio, AsyncHTTPClient and more, declares macOS only, and does not
  unpack to a folder; `ContainerRegistry` (apple/swift-container-plugin) is small but not exported
  as a library. The owner chose to write our own.

## Design

### Which references go where

- A reference starting with exactly `localhost/` is a **local image**: resolved with
  `docker image inspect` and pinned by local image ID, as today, in both sandboxes.
- Everything else is a **registry image**, with Docker's naming rules: no registry part means
  Docker Hub (`node:26` is `docker.io/library/node:26`); no tag means `latest`.
- `localhost:<port>/...` is a registry (a local one, over plain HTTP), not a local image.
  *(My call: it is what local registries use, and it lets the tests run a registry container.)*
- A registry reference that does not exist in its registry, but exists in local Docker (built
  locally under a non-`localhost/` name), fails with `IMAGE_NOT_FOUND` and instructions: tag it
  `localhost/<name>` to use it locally, or push it.

### Pinning

- A registry image is pinned by **the digest the tag points to**, platform-independent: for a
  multi-platform image that is the index digest, for a single-platform image its manifest digest.
  When it runs, jig picks the `linux/<host arch>` (amd64 or arm64) manifest from the index. So a
  replay on another architecture runs that architecture's build of the same pinned image: different
  files, which the owner accepts. A single-platform image replayed on another architecture fails
  with a clear error. (jig's own images are single-platform until multi-arch builds, which are out
  of scope.)
- The recorded reference keeps the shape it has today: the reference as the user typed it, plus
  `@sha256:<manifest digest>`, e.g. `ghcr.io/acme/jig/typescript:0.1.0@sha256:…`. The tag is for
  readers only; replay uses the digest. *(My call: same shape as today, so the trailer and output
  schemas do not change.)*
- `PinnedImage.id` stays "what the sandbox runs and caches by": for registry images the
  platform manifest chosen for this machine (the rootfs cache and the Docker load are keyed by it),
  for local ones the local image ID. Both are `sha256:<64 hex>`. The recorded reference carries the
  pinned (possibly index) digest.

### `swift/oci`: the client

- Speaks the OCI distribution API over HTTPS (HTTP for `localhost:<port>`): manifest by tag or
  digest, blob by digest. Accepts OCI and Docker v2 manifest and index media types.
- Authentication: the registry's anonymous bearer-token flow (`WWW-Authenticate: Bearer realm=…`),
  which covers public images on ghcr.io and Docker Hub. **Public images only** (the owner's
  decision): no credentials, no `~/.docker/config.json`, no credential helpers. Private images are
  a later addition; until then they go through `localhost/`.
- Anonymously, registries answer 401/"denied" both for a repository that does not exist and for a
  private one. jig maps that to `IMAGE_NOT_FOUND` with instructions: tag it `localhost/<name>` to
  use a local image, or push it; and that private images are not supported yet.
- Every downloaded blob and manifest is checked against its SHA-256 before it enters the store.
- Layers: gzip-compressed and uncompressed tar. zstd layers fail with a clear error.
  *(My call: zstd needs a library we would rather not add; few images use it.)*
- HTTP through Foundation's `URLSession` (FoundationNetworking in the static Linux SDK).
  SHA-256 and gzip: the builder picks what links into the static binary without a heavy package
  (zlib from the SDK is fine; a small SHA-256 of our own is fine).

### `swift/oci`: the store

- Location: `$XDG_CACHE_HOME/jig/oci`, else `$HOME/.cache/jig/oci`, next to the existing rootfs
  cache.
- Format: the standard **OCI image layout** (`oci-layout`, `index.json`, `blobs/sha256/<hex>`), so
  other tools can read it and Docker can load from it.
- `index.json` also remembers tag → digest (annotation `org.opencontainers.image.ref.name` with the
  full normalized reference), which is the "last seen" version for the offline fallback.
- Blobs are written to a temporary file and renamed into place after their digest checks out.
  Two jig processes may fill the store at once; neither may see a half-written blob or a damaged
  `index.json`.
- No garbage collection yet.

### Resolving a reference

1. Pinned registry reference (a replay): if the manifest and its blobs are in the store, done, no
   network. Otherwise download them by digest. If that fails, `IMAGE_NOT_FOUND` (registry says
   unknown) or an unreachable-registry error. Never a fallback.
2. Registry reference with a tag: ask the registry what the tag points to (one manifest request),
   pick the platform manifest, download what is missing, record tag → digest in `index.json`.
   If the registry cannot be reached (network error, timeout, 5xx), use the last recorded digest for
   that tag when the store has it complete, and add a note to the output that a cached version was
   used and why. Without a recorded digest, fail.
3. `localhost/` reference: unchanged.

### The sandboxes

- **rootlesskit**, registry image: builds its image folder from the store. It unpacks the layers in
  order into the rootfs cache entry keyed by the manifest digest. No Docker involved, so a machine
  with only rootlesskit can run registry images. The image config (`Entrypoint`, `Cmd`, `Env`)
  comes from the image's config blob.
- **rootlesskit**, local image: unchanged (`docker export`).
- **docker**, registry image: when Docker does not have it yet, loads it from the store
  (`docker load` of an OCI archive streamed from the store) under an internal name derived from the
  manifest digest, then runs it as today. The builder picks the name and how "already loaded" is
  detected; what runs must be exactly the pinned manifest's image.
- **docker**, local image: unchanged.

### Unpacking layers (in `swift/oci`, used by rootlesskit)

A tar reader of our own: ustar, PAX and GNU long names; regular files, directories, symlinks and
hard links. Whiteouts: `.wh.<name>` removes `<name>` from lower layers, `.wh..wh..opq` empties the
folder. Modes are kept, ownership is the invoking user's, device files are skipped (rootless cannot
create them). **No entry may write outside the image folder**: absolute paths, `..` and paths
through symlinks are resolved inside the image folder or refused.

### Output and errors

- `IMAGE_NOT_FOUND` covers "the registry does not have it" and "no local image" (local images), with
  instructions that say which.
- Unreachable registry (network error, timeout, 5xx, 429), digest mismatch: a stable error code. The builder
  may add a new code (e.g. `REGISTRY_UNAVAILABLE`) to `ErrorCode` and the schemas.
- The offline-tag note: a new optional field in the success output (and the verify output if it
  applies), added to the schemas. *(My call; name and shape are the builder's.)*
- README, `swift/*/README.md` and AGENTS.md describe the store, the `localhost/` rule and the
  fallback; the "Images are pinned by local image ID only" limitation goes.

## Testing

- Unit tests in `swift/oci`: reference parsing and normalization, manifest/index parsing and platform
  choice, digest checks, the token flow (against a fake HTTP responder), the store's atomic writes,
  the tar reader and whiteouts, and path-escape attempts.
- Integration tests: a `registry:2` container on `localhost:<port>`, the jig images pushed to it,
  then `jig` and `jig verify` with both sandboxes: first download, a cached run without network
  (registry stopped), a tag moved to a new image, a pinned replay after the tag moved, a missing
  image, and a non-`localhost/` local-only image refused.

## Left to the builder

Package and file layout inside `swift/oci`; the HTTP and SHA-256/gzip plumbing within the
constraints above; timeouts and retries; the internal Docker name for loaded images; the name and
shape of the new error code and output field; how the store locks `index.json`; how the offline
note travels from `resolve` to the output; what an interrupted download leaves (nothing half-written
in the store, per the store rules).

Settled after the builder check *(my calls)*:
- HTTP 429 (rate limited) counts as "registry unreachable" for the tag fallback.
- Plain HTTP only for `localhost:<port>`; every other registry is HTTPS.
- First step of the plan: check that `URLSession` over HTTPS works in the static musl binary,
  before building on it.

