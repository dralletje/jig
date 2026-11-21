# Registry Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** jig downloads public registry images itself into its own OCI store, pins them by the
(platform-independent) digest the tag points to, and both sandboxes run them from that store;
`localhost/...` images keep coming from local Docker.

**Architecture:** A new Swift package `swift/oci` holds everything registry-related: reference
parsing, SHA-256, gzip, manifests, an HTTP transport, the registry client, the OCI-layout store, the
puller (resolve + download + tag fallback), a tar reader/unpacker and a Docker-archive writer. The
sandboxes route by `isLocalImage(_:)`: local references keep today's Docker path; registry
references go through `ImagePuller`. rootlesskit unpacks from the store; docker loads from the store.

**Tech Stack:** Swift 6.4.2, Static Linux SDK (musl), Foundation + FoundationNetworking
(`URLSession`), zlib from the SDK, swift-testing. No new package dependencies.

**Spec:** `docs/superpowers/specs/2026-11-19-registry-images-design.md`

## Global Constraints

- No new runtime program and no new Swift package dependency (no swift-crypto, no swift-nio, no
  borrowed registry library). zlib via `linkedLibrary("z")` is allowed.
- Exactly the prefix `localhost/` means a local Docker image; everything else, including
  `localhost:<port>/...`, is a registry image.
- Plain HTTP only for `localhost:<port>` registries; all others HTTPS.
- Public images only: the anonymous bearer-token flow; never read `~/.docker/config.json` or run
  credential helpers.
- Pin = the digest the tag points to (index digest for multi-platform images). `PinnedImage.id` =
  the `linux/<host arch>` manifest digest that runs; `PinnedImage.reference` = what the user typed
  plus `@sha256:<pinned digest>` (a typed reference that already has a digest is kept as typed).
- Tag fallback only when the registry is unreachable (network error, timeout, 5xx, 429) and the
  store has that tag's last digest complete; a pinned digest never falls back.
- Every manifest and blob is checked against its SHA-256 before it enters the store.
- zstd layers fail with a clear error.
- Store: `$XDG_CACHE_HOME/jig/oci` (absolute XDG only), else `$HOME/.cache/jig/oci`; OCI image
  layout (`oci-layout`, `index.json`, `blobs/sha256/<hex>`); tag memory in `index.json` via
  annotation `org.opencontainers.image.ref.name` = the normalized `<registry>/<repository>:<tag>`.
- Shell commands go through `nux`; Bun is not used anywhere (AGENTS.md).

## Review Focus

1. **Two jig processes pulling the same image at once** — both succeed; no truncated blob, no lost
   or corrupted `index.json` entry. (Test in Task 5.)
2. **A layer that tries to write outside the image folder** — `../x`, `/etc/x`, and a symlink
   `a -> /` followed by `a/etc/x` in the same or a later layer: refused with `IMAGE_FAILED`, nothing
   written outside. (Test in Task 7.)
3. **A registry that sends bytes not matching the requested digest** (or a tag manifest whose
   `Docker-Content-Digest` header disagrees with its body) — `REGISTRY_UNAVAILABLE`, nothing stored.
   (Test in Task 4.)
4. **Large layers** — downloads stream to disk and unpacking streams from disk; memory stays
   bounded (no `Data` of a whole layer). (Test in Task 4: download a 64 MiB fake blob via the fake
   transport's file path and assert the client never asks for `send` with a body for blobs.)
5. **Interrupted pull** (SIGINT mid-download) — no half-written blob becomes visible; leftovers
   `.tmp-<pid>-*` of dead processes are swept on the next store use. (Test in Task 5.)

---

### Task 1: `swift/oci` package, SHA-256, gzip, and the static HTTPS check

**Files:**
- Create: `swift/oci/Package.swift`, `swift/oci/Sources/CZlib/` (module map + shim header),
  `swift/oci/Sources/OCI/Digest.swift`, `swift/oci/Sources/OCI/Gzip.swift`,
  `swift/oci/Tests/OCITests/DigestTests.swift`, `swift/oci/Tests/OCITests/GzipTests.swift`
- Modify: `scripts/test-swift.sh` (add `oci` after `process` in the package list)

**Interfaces:**
- Produces:
  - `public struct Digest: Hashable, Sendable, CustomStringConvertible, Codable` — `init?(_ text: String)` accepts only `sha256:<64 lowercase hex>`; `var hex: String`; `description` = `"sha256:<hex>"`; Codable as that string.
  - `public struct SHA256Hasher` — `init()`, `mutating func update(_ data: Data)`, `mutating func finalize() -> Digest`; `static func digest(_ data: Data) -> Digest`; `static func digest(fileAt: URL) throws -> Digest` (streams 1 MiB chunks).
  - `public struct GzipReader` — `init(fileAt: URL) throws`, `mutating func read(upTo: Int) throws -> Data` (empty at end; multi-member gzip supported); throws `RefactorError(.IMAGE_FAILED, …)` on corrupt data.
  - Package `oci`, product `OCI` (library), depends on `../report` only.

- [ ] **Step 1: Static HTTPS check (throwaway, not committed).** In the scratchpad, a one-file
  executable package doing `URLSession.shared.dataTask` (semaphore-waited) GET
  `https://ghcr.io/v2/`, built with `swift build -c release --swift-sdk x86_64-swift-linux-musl`
  and run. Expected: status 401 printed. If it fails (TLS/CA bundle), stop and report to the owner
  before continuing — the transport choice depends on it.
- [ ] **Step 2: Write failing tests.** `DigestTests`: `SHA256Hasher.digest(Data())` ==
  `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`; `"abc"` ==
  `sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`; 1,000,000 × `"a"` fed in
  7-byte chunks == `sha256:cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0`;
  `Digest("sha256:ABC…")` (uppercase) and `Digest("sha512:…")` are nil. `GzipTests`: a fixture made
  with `gzip -n` of a known text round-trips; two concatenated members read as one stream; a
  truncated file throws `IMAGE_FAILED`.
- [ ] **Step 3: Run** `cd swift/oci && swift test` — expected: compile failure (types missing).
- [ ] **Step 4: Implement** `Digest`, `SHA256Hasher` (FIPS 180-4, our own), `GzipReader` (zlib
  `inflateInit2(…, 16+MAX_WBITS)`, `inflateReset` on `Z_STREAM_END` with input left), the `CZlib`
  system-library target with `link "z"`.
- [ ] **Step 5: Run** `swift test` in `swift/oci` — PASS. Also `sh scripts/build-binary.sh` still
  passes (oci not yet linked into cli; just confirms the script is untouched).
- [ ] **Step 6: Commit** `feat(oci): package with SHA-256 and gzip`.

### Task 2: Image references

**Files:**
- Create: `swift/oci/Sources/OCI/Reference.swift`, `swift/oci/Tests/OCITests/ReferenceTests.swift`

**Interfaces:**
- Consumes: `Digest`.
- Produces:
  - `public func isLocalImage(_ reference: String) -> Bool` — `reference.hasPrefix("localhost/")`.
  - `public struct ImageReference: Equatable, Sendable` — `registry: String`, `repository: String`, `tag: String?`, `digest: Digest?`; `static func parse(_ text: String) throws -> ImageReference` (throws `RefactorError(.INVALID_ARGS, …)`); `var name: String` (`<registry>/<repository>`); `var taggedName: String?` (`<name>:<tag>` when tag ≠ nil); `var plainHTTP: Bool` (`registry.hasPrefix("localhost:")`); `var apiBase: URL` (`https://registry-1.docker.io` for `docker.io`, `http://localhost:5000` for `localhost:5000`, else `https://<registry>`).

- [ ] **Step 1: Failing tests** (`ReferenceTests`), each `parse` → expected fields:
  `node` → `docker.io`, `library/node`, tag `latest`; `node:26` → tag `26`;
  `acme/tool` → `docker.io`, `acme/tool`; `ghcr.io/acme/jig/typescript:0.1.0` → `ghcr.io`,
  `acme/jig/typescript`, `0.1.0`; `localhost:5000/x/y` → registry `localhost:5000`, `plainHTTP`
  true, tag `latest`; `ghcr.io/a/b:1@sha256:<64 hex>` → tag `1`, digest set;
  `ghcr.io/a/b@sha256:<64 hex>` → tag nil; `index.docker.io/library/node` → registry `docker.io`.
  Rejected with `INVALID_ARGS`: `""`, `UPPER/case`, `a/b@sha256:short`, `a//b`.
  `isLocalImage("localhost/jig/typescript:local")` true; `isLocalImage("localhost:5000/x")` false.
- [ ] **Step 2: Run** `swift test --filter ReferenceTests` — FAIL.
- [ ] **Step 3: Implement** with Docker's rules: the first path component is a registry when it
  contains `.` or `:` or is `localhost`; else `docker.io`, and single-component repositories get
  `library/`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(oci): image references`.

### Task 3: Manifests, indexes, config, platform

**Files:**
- Create: `swift/oci/Sources/OCI/Manifest.swift`, `swift/oci/Tests/OCITests/ManifestTests.swift`

**Interfaces:**
- Consumes: `Digest`.
- Produces:
  - `public enum MediaType` — static strings `ociManifest` (`application/vnd.oci.image.manifest.v1+json`), `ociIndex` (`application/vnd.oci.image.index.v1+json`), `dockerManifest` (`application/vnd.docker.distribution.manifest.v2+json`), `dockerList` (`application/vnd.docker.distribution.manifest.list.v2+json`), `accept` (all four, comma-joined); `static func isGzipLayer(_:) -> Bool`, `isPlainLayer(_:) -> Bool`, `isZstdLayer(_:) -> Bool`.
  - `public struct Platform: Codable, Equatable, Sendable` — `os`, `architecture`, `variant: String?`; `static let host: Platform` (`linux` + `amd64`/`arm64` from `uname -m`: `x86_64`→`amd64`, `aarch64`→`arm64`).
  - `public struct Descriptor: Codable, Equatable, Sendable` — `mediaType: String`, `digest: Digest`, `size: Int64`, `platform: Platform?`, `annotations: [String: String]?`.
  - `public struct ImageManifest: Codable, Equatable, Sendable` — `config: Descriptor`, `layers: [Descriptor]`.
  - `public struct ImageIndex: Codable, Equatable, Sendable` — `manifests: [Descriptor]`; `func manifest(for: Platform) -> Descriptor?` (os+architecture match; for arm64 prefer variant `v8` or nil; skip `unknown/unknown` attestation entries).
  - `public enum ParsedManifest: Equatable, Sendable` — `.image(ImageManifest)`, `.index(ImageIndex)`; `static func parse(_ data: Data, mediaType: String) throws -> ParsedManifest` (falls back to the body's `mediaType` field when the header is generic; unknown → `RefactorError(.INTERNAL, "… unsupported manifest type <x>")`).
  - `public struct ImageConfigFile: Codable, Equatable, Sendable` — decodes `config.Entrypoint`, `config.Cmd`, `config.Env` (all optional) and exposes `entrypoint: [String]`, `cmd: [String]`, `env: [String]` (empty when absent).

- [ ] **Step 1: Failing tests:** parse a real-shaped OCI index (fixture JSON with amd64, arm64 v8,
  and an `unknown/unknown` attestation entry) and pick amd64 and arm64; an index with only
  `linux/s390x` gives nil for both hosts; a Docker v2 manifest and an OCI manifest parse to
  `.image` with their layers; a config blob with `Entrypoint` null and `Cmd ["node"]` gives
  `entrypoint == []`, `cmd == ["node"]`; `Platform.host.os == "linux"`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(oci): manifests, indexes and platform choice`.

### Task 4: HTTP transport and registry client

**Files:**
- Create: `swift/oci/Sources/OCI/Transport.swift`, `swift/oci/Sources/OCI/RegistryClient.swift`,
  `swift/oci/Tests/OCITests/FakeTransport.swift`, `swift/oci/Tests/OCITests/RegistryClientTests.swift`

**Interfaces:**
- Consumes: `ImageReference`, `Digest`, `SHA256Hasher`, `MediaType`.
- Produces:
  - `public struct HTTPRequest: Sendable` — `url: URL`, `method: String` (`GET`/`HEAD`), `headers: [String: String]`.
  - `public struct HTTPResponse: Sendable` — `status: Int`, `headers: [String: String]` (lowercased keys), `body: Data` (empty for `download`).
  - `public protocol HTTPTransport: Sendable` — `func send(_: HTTPRequest) throws -> HTTPResponse`; `func download(_: HTTPRequest, to file: URL) throws -> HTTPResponse` (streams the body to `file`; follows redirects — blob URLs redirect to storage). Network failure throws `TransportError(message:)`.
  - `public struct URLSessionTransport: HTTPTransport` — synchronous via semaphore, 30 s request timeout, follows redirects, drops `Authorization` on redirect to another host.
  - `public enum RegistryError: Error, Equatable` — `.notFound(String)`, `.unavailable(String)`, `.digestMismatch(expected: Digest, actual: Digest)`.
  - `public final class RegistryClient: Sendable` — `init(transport: any HTTPTransport = URLSessionTransport())`; `func manifest(_ ref: ImageReference, _ tagOrDigest: String) throws -> (digest: Digest, mediaType: String, data: Data)`; `func downloadBlob(_ ref: ImageReference, _ digest: Digest, to file: URL) throws`.
  - Token flow: on 401 with `WWW-Authenticate: Bearer realm="…",service="…",scope="…"`, GET the realm with `service` and `scope=repository:<repository>:pull`, take `token` (or `access_token`), retry once with `Authorization: Bearer <token>`; tokens cached per `(registry, repository)` for the client's lifetime.
  - Error mapping: 404, and 401/403 after the token retry → `.notFound`; `TransportError`, 5xx, 429 → `.unavailable`; a manifest fetched by digest whose body hash differs, or a tag manifest whose `Docker-Content-Digest` header differs from the body hash → `.digestMismatch`; a downloaded blob whose streamed hash differs → `.digestMismatch` and the file is deleted.

- [ ] **Step 1: Failing tests** with `FakeTransport` (a table of URL → responses, recording
  requests, writing `download` bodies to the given file): anonymous token flow against a fake
  ghcr (`401` + `WWW-Authenticate` → token endpoint → retried with `Bearer`); Docker Hub uses
  `registry-1.docker.io`; `localhost:5000` uses `http://`; 404 → `.notFound`; 401 after token →
  `.notFound`; 503 and 429 and a thrown `TransportError` → `.unavailable`; a tag manifest with a
  wrong `Docker-Content-Digest` → `.digestMismatch`; a blob with wrong bytes → `.digestMismatch`
  and the target file no longer exists; a 64 MiB blob goes through `download`, never `send`
  (Review Focus 4).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(oci): registry client with anonymous tokens`.

### Task 5: The OCI store

**Files:**
- Create: `swift/oci/Sources/OCI/Store.swift`, `swift/oci/Tests/OCITests/StoreTests.swift`

**Interfaces:**
- Consumes: `Digest`, `SHA256Hasher`, `Descriptor`.
- Produces:
  - `public struct OCIStore: Sendable` — `init(root: URL)`; `static func defaultRoot(environment: [String: String]) -> URL?` (rules in Global Constraints);
    `func blobURL(_: Digest) -> URL`; `func has(_: Digest) -> Bool`;
    `func temporaryFile() throws -> URL` (in `<root>/tmp/`, named `.tmp-<pid>-<random>`; sweeps
    those of dead pids, like `RootfsCache.sweepStale`);
    `func adopt(_ file: URL, as digest: Digest) throws` (hashes the file, `.digestMismatch` →
    deletes it and throws `RefactorError(.REGISTRY_UNAVAILABLE, …)`; else `rename` into `blobs/sha256/<hex>`; an existing blob wins);
    `func put(_ data: Data, as digest: Digest) throws` (same, for manifests);
    `func recordTag(_ taggedName: String, _ descriptor: Descriptor) throws` (replaces that name's entry in `index.json`);
    `func lastTag(_ taggedName: String) -> Descriptor?`.
  - `index.json` updates: under an exclusive `flock` on `<root>/index.lock`, read, change, write to a temp file, `rename`. The `oci-layout` file (`{"imageLayoutVersion":"1.0.0"}`) is created on first use.
- `REGISTRY_UNAVAILABLE` is added to `ErrorCode` in Task 9; until then this task uses `.INTERNAL`
  and Task 9 switches it (the plan keeps the order so `swift/oci` tests pass at each commit).

- [ ] **Step 1: Failing tests:** `defaultRoot` with `XDG_CACHE_HOME=/c` → `/c/jig/oci`, with
  relative XDG and `HOME=/h` → `/h/.cache/jig/oci`, neither → nil; `put` then `has`; `adopt` with
  wrong bytes throws and leaves no blob; `recordTag` twice for the same name keeps one entry with
  the second digest, another name keeps its own; **concurrency** (Review Focus 1): 8 threads ×
  25 `recordTag` of distinct names + `adopt` of the same blob — afterwards `index.json` parses and
  has all 200 names, the blob hashes right; **stale temp sweep** (Review Focus 5): a
  `.tmp-999999-x` file (pid that does not exist) in `tmp/` is gone after `temporaryFile()`, one with
  the test's own pid stays.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(oci): OCI image layout store`.

### Task 6: The puller (resolve, download, tag fallback)

**Files:**
- Create: `swift/oci/Sources/OCI/Puller.swift`, `swift/oci/Tests/OCITests/PullerTests.swift`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  - `public struct ResolvedImage: Equatable, Sendable` — `pinned: Digest` (what the commit records), `manifest: Digest` (the platform manifest that runs), `config: ImageConfigFile`, `layers: [Descriptor]`, `note: String?`.
  - `public struct ImagePuller: Sendable` — `init(store: OCIStore, client: RegistryClient, platform: Platform = .host)`; `func resolve(_ ref: ImageReference) throws -> ResolvedImage` (throws `RefactorError`); `func pinnedReference(typed: String, _ resolved: ResolvedImage) -> String` (typed unchanged when it has a digest, else `"<typed>@<pinned>"`).
  - Behaviour (spec "Resolving a reference"): digest given → from the store when complete (manifest, config, all layers), else download by digest; never fallback. Tag → `manifest(ref, tag)`; on `.unavailable`, use `store.lastTag(taggedName)` if the store has it complete and set `note` = `"<registry> could not be reached (<reason>); used the copy of <taggedName> downloaded earlier: <pinned>"`; else rethrow. After a fresh tag fetch: store the manifest(s), download missing config and layers (each through `temporaryFile` + `adopt`), then `recordTag`.
  - Error mapping to `RefactorError`: `.notFound` → `IMAGE_NOT_FOUND`, instructions `"There is no image <typed> in its registry, or it is private (jig only downloads public images). For an image in local Docker, tag it localhost/<name> and use that name; otherwise push it."`; index without this platform → `IMAGE_NOT_FOUND` `"<typed> has no linux/<arch> build."`; single-platform manifest whose config `os/architecture` differs from the host → same; `.unavailable`/`.digestMismatch` → `REGISTRY_UNAVAILABLE` (`.INTERNAL` until Task 9) with the reason; a zstd layer → `INTERNAL` `"<typed> has zstd-compressed layers, which jig does not support yet."`.

- [ ] **Step 1: Failing tests** with `FakeTransport` + a temp `OCIStore`: tag → pins the index
  digest, `manifest` is the amd64 entry when `platform` is amd64 and the arm64 entry when arm64
  (same `pinned`); second resolve of the same tag with the fake registry now answering 503 →
  same `pinned`, `note` contains `could not be reached`; tag moved (fake now serves a new index)
  → new `pinned`, no note; pinned digest with all blobs stored and the fake failing every request
  → resolves with no request made; pinned digest with a layer missing and the fake failing →
  `REGISTRY_UNAVAILABLE`/`INTERNAL`, no fallback; 503 on a tag never seen → error; unknown repo →
  `IMAGE_NOT_FOUND` with the `localhost/` instructions; index with only `linux/s390x` →
  `IMAGE_NOT_FOUND` mentioning `linux/amd64`; zstd layer → `INTERNAL`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(oci): resolve and download images with tag fallback`.

### Task 7: Tar reader and layer unpacking

**Files:**
- Create: `swift/oci/Sources/OCI/Tar.swift`, `swift/oci/Sources/OCI/Unpack.swift`,
  `swift/oci/Tests/OCITests/UnpackTests.swift` (fixtures built in the test with a small tar
  writer from Task 8, or with `^tar` when simpler)

**Interfaces:**
- Consumes: `GzipReader`, `MediaType`, `Descriptor`, `OCIStore.blobURL`.
- Produces:
  - `struct TarReader` (internal) — streaming over a byte source; ustar, PAX (`path`, `linkpath`, `size`), GNU `L`/`K` long names; entry kinds file, directory, symlink, hard link (others skipped).
  - `public func unpackLayers(_ layers: [(descriptor: Descriptor, file: URL)], into rootfs: URL) throws` (changed during execution so Tasks 5 and 7 could run in parallel: callers pass `store.blobURL(descriptor.digest)` as `file`) — in order; gzip or plain by media type; whiteouts `.wh.<name>` and `.wh..wh..opq`; modes kept (`0o7777` masked to `0o777` plus sticky; setuid/setgid dropped), owner is the caller; files written with `O_NOFOLLOW` and every parent component checked with `lstat` to be a real directory inside `rootfs` (create missing ones); an escaping entry → `RefactorError(.IMAGE_FAILED, "the image's layer <digest> has an entry outside the image: <path>")`; a hard link whose target is outside or missing → same error.

- [ ] **Step 1: Failing tests:** a two-layer image (layer 1: `bin/a`, `etc/x`, dir `d/` with
  `d/1`; layer 2: `.wh.x` in `etc/`, `d/.wh..wh..opq`, `d/2`, symlink `link -> bin/a`, hard link
  `bin/b` → `bin/a`) unpacks to `bin/a`, `bin/b` (same inode), `link`, `d/2` only, no `etc/x`;
  a PAX long path (150 chars) and a GNU long name both land right; mode `0o755` kept, `0o4755`
  becomes `0o755`; **escapes** (Review Focus 2) each throw `IMAGE_FAILED` and leave the temp
  parent folder unchanged: `../evil`, `/abs/evil`, symlink `s -> /` then file `s/evil` (same layer),
  symlink `s -> ../..` in layer 1 then `s/evil` in layer 2, hard link to `../../outside`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(oci): unpack image layers safely`.

### Task 8: Docker archive for `docker load`

**Files:**
- Create: `swift/oci/Sources/OCI/TarWriter.swift`, `swift/oci/Sources/OCI/DockerArchive.swift`,
  `swift/oci/Tests/OCITests/DockerArchiveTests.swift`

**Interfaces:**
- Consumes: `OCIStore`, `ResolvedImage`.
- Produces:
  - `struct TarWriter` (internal) — ustar headers (+ PAX for long names), regular files and directories.
  - `public func dockerName(for manifest: Digest) -> String` — `"jig-oci.invalid/<hex>:image"` (`.invalid` never resolves, so Docker can never pull something else under it).
  - `public func writeDockerArchive(_ image: ResolvedImage, from store: OCIStore, to file: URL) throws` — a tar with `oci-layout`, `index.json` (one descriptor for `image.manifest`, annotations `io.containerd.image.name` and `org.opencontainers.image.ref.name` = `dockerName(for:)`), `manifest.json` (`[{"Config":"blobs/sha256/<config>","RepoTags":[dockerName],"Layers":["blobs/sha256/<layer>",…]}]`), and `blobs/sha256/` with the platform manifest, config and layers.

- [ ] **Step 1: Failing test:** archive of a stored one-layer image lists exactly those entries
  (read back with `TarReader`), and `manifest.json`'s `RepoTags` is `[dockerName]`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Docker check:** with a real image saved into a temp store (use Task 6 against the
  Task 13 test registry if it exists, else build the store from `docker save` output in a
  scratch test), `docker load -i <archive>` then `docker image inspect jig-oci.invalid/<hex>:image`
  succeeds and `docker run --rm <name> node --version` prints a version. Expected on this machine
  (containerd image store). If `docker load` rejects the archive, fix the layout before
  continuing.
- [ ] **Step 6: Commit** `feat(oci): Docker-loadable archives`.

### Task 9: Error code, output note, `PinnedImage.note`

**Files:**
- Modify: `swift/report/Sources/Report/ErrorCode.swift` (add `REGISTRY_UNAVAILABLE` after
  `IMAGE_FAILED`; host-only like `INTERNAL`, so `reportable` never returns it),
  `swift/report/Sources/Report/Output.swift` (`successJSON(…, notes: [String] = [])`, key `notes`
  emitted only when non-empty), `swift/report/Tests/ReportTests/OutputTests.swift`,
  `schemas/report-1.schema.json` (add the code wherever `INTERNAL` is listed),
  `schemas/output-1.schema.json` (success: optional `notes`, array of non-empty strings,
  `minItems: 1`), `swift/sandbox/Sources/Sandbox/Sandbox.swift` (`PinnedImage.note: String?`,
  `init(id:reference:note: = nil)`; docs: `id` is what runs, `reference` what is recorded),
  `swift/oci` (switch the Task 5/6 placeholders from `.INTERNAL` to `.REGISTRY_UNAVAILABLE`; add
  `../report` is already a dependency).

**Interfaces:**
- Produces: `ErrorCode.REGISTRY_UNAVAILABLE`; `successJSON(commit:parent:image:args:report:filesChanged:notes:)`; `PinnedImage(id:reference:note:)`.

- [ ] **Step 1: Failing tests:** `errorCodesMatchTheTypeScriptList` expected list gains
  `"REGISTRY_UNAVAILABLE"` after `"IMAGE_FAILED"` (the TypeScript list in
  `packages/core/src/errors.ts` stays as is: images cannot report host codes); `reportable("REGISTRY_UNAVAILABLE") == nil`;
  `successJSON` with `notes: ["x"]` contains `"notes":["x"]`, without notes has no `notes` key;
  the schema examples still validate (existing tests).
- [ ] **Step 2: Run** `swift test` in `swift/report` — FAIL. **Step 3: Implement.**
- [ ] **Step 4: Run** `swift test` in `swift/report`, `swift/sandbox`, `swift/oci` — PASS.
- [ ] **Step 5: Commit** `feat: REGISTRY_UNAVAILABLE and the output's notes`.

### Task 10: rootlesskit runs registry images from the store

**Files:**
- Modify: `swift/sandbox+rootlesskit/Package.swift` (depend on `../oci`),
  `swift/sandbox+rootlesskit/Sources/SandboxRootlesskit/RootlesskitSandbox.swift`
  (`Options.ociRoot: URL?`, `Options.registry: RegistryClient?` for tests; `resolve` routes by
  `isLocalImage`; `imageFolder` builds registry images with `unpackLayers` and
  `ImageConfig(entrypoint:cmd:env:)` from `ImageConfigFile`), `README.md` of the package
- Test: `swift/sandbox+rootlesskit/Tests/SandboxRootlesskitTests/RegistryImageTests.swift`

**Interfaces:**
- Consumes: `ImagePuller`, `ResolvedImage`, `unpackLayers`, `isLocalImage`, `PinnedImage(id:reference:note:)`.
- Produces: for a registry reference, `resolve` returns `PinnedImage(id: resolved.manifest, reference: puller.pinnedReference(typed:…), note: resolved.note)`; the rootfs cache entry is keyed by `resolved.manifest`. The sandbox keeps the `ResolvedImage` per `id` from `resolve` so `run` needs no second registry call; if `run` gets a `PinnedImage` it did not resolve, it resolves `reference` again (store only, then registry). Docker is not invoked for registry images.

- [ ] **Step 1: Failing tests** (unit, `FakeTransport` serving a tiny busybox-free image: one
  layer with a static `/bin/hello` copied from the probe build, or a shell-free test binary built
  for the test): `resolve("localhost:5000/t/hello:1")` → `id` is the manifest digest, `reference`
  ends with `@<index digest>`; `run` on it (skipped when rootlesskit is unavailable, as the existing
  integration suites do) prints the expected output with `docker` set to a nonexistent path in
  `Options`, proving no Docker use; a `localhost/…` reference still goes through Docker (existing
  tests keep passing).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `swift test` in
  `swift/sandbox+rootlesskit` — PASS.
- [ ] **Step 5: Commit** `feat(rootlesskit): run registry images from jig's store`.

### Task 11: docker runs registry images loaded from the store

**Files:**
- Modify: `swift/sandbox+docker/Package.swift` (depend on `../oci`),
  `swift/sandbox+docker/Sources/SandboxDocker/DockerSandbox.swift` (`init(puller: ImagePuller? = nil)`;
  `resolve` routes by `isLocalImage`; for registry images: resolve, then if
  `docker image inspect dockerName(for: manifest)` fails, `writeDockerArchive` to a store temp
  file and `docker load -i` it, delete the file; `run` uses `dockerName(for:)` for registry
  images and `image.id` for local ones), its `README.md`
- Test: `swift/sandbox+docker/Tests/SandboxDockerTests/RegistryImageTests.swift`

**Interfaces:**
- Consumes: `ImagePuller`, `writeDockerArchive`, `dockerName(for:)`, `isLocalImage`.
- Produces: `DockerSandbox.resolve` for registry references returns the same `PinnedImage` (id, reference, note) as rootlesskit's for the same store, so commits replay with either sandbox.

- [ ] **Step 1: Failing tests** (skipped without a reachable Docker daemon): with a `FakeTransport`
  serving a one-layer image whose layer is a `docker save` of `localhost/jig/typescript:local`'s
  layers re-packed (or the Task 13 registry, whichever the implementer finds simpler — state which
  in the test file's header), `resolve` loads it once (`docker image inspect jig-oci.invalid/…`
  succeeds afterwards), a second `resolve` does not call `docker load` again, and `run` executes it.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `swift test` in
  `swift/sandbox+docker` — PASS.
- [ ] **Step 5: Commit** `feat(docker): run registry images loaded from jig's store`.

### Task 12: CLI wiring and docs

**Files:**
- Modify: `swift/cli/Package.swift` (depend on `../oci`), `swift/cli/Sources/RefactorCLI/RunImage.swift`
  (`RunResult.notes: [String]`, filled from `pinned.note`, passed to `successJSON`),
  `swift/cli/Sources/RefactorCLI/Verify.swift` (the IMAGE_NOT_FOUND instructions: local images
  need the image in this machine's Docker; registry images are downloaded),
  `swift/cli/Sources/RefactorCLI/CLIArgs.swift` usage text (image may be a registry reference or
  `localhost/…`), `README.md` (store location, the `localhost/` rule, the tag fallback and its note,
  public images only; remove "Images are pinned by local image ID only"), `swift/cli/README.md`,
  `AGENTS.md` only if it describes images, `scripts/build-binary.sh` only if linking needs it.
- Test: `swift/cli/Tests/CLITests/` — `RunResult.json` with a note has `notes`.

**Interfaces:**
- Consumes: `PinnedImage.note`, `successJSON(…notes:)`.

- [ ] **Step 1: Failing test** for `RunResult.json` notes. **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** and update the docs.
- [ ] **Step 4: Run** `sh scripts/build-binary.sh` (static binary links `OCI`, zlib and
  FoundationNetworking) and `swift test --skip IntegrationTests` in `swift/cli` — PASS.
- [ ] **Step 5: Commit** `feat(cli): registry images and the offline note`.

### Task 13: End-to-end tests against a local registry

**Files:**
- Create: `swift/cli/Tests/IntegrationTests/RegistryTests.swift`
- Modify: `swift/cli/Tests/IntegrationTests/Helpers.swift` (registry helpers)

**Interfaces:**
- Produces (test helpers):
  - `func startTestRegistry() throws -> TestRegistry` — `docker run -d -p 127.0.0.1::5000 registry:2`, port from `docker port`, `wait` until `GET /v2/` answers; `TestRegistry.stop()` / `start()` (for the offline case) / `remove()`.
  - `func pushToTestRegistry(_ localImage: String, as name: String, registry: TestRegistry, extraPlatform: Bool = false) throws -> (pinned: String)` — pushes over the registry HTTP API from Swift (blob `POST`+`PUT`, manifest `PUT`), reading blobs from `docker save` of the local image (Docker 25+ writes an OCI layout). With `extraPlatform`, also pushes an index that lists the real manifest as `linux/<host arch>` and a copy as the other architecture. (Rootless Docker's own `docker push` to `localhost:<port>` goes through the daemon's network namespace and is not relied on.)
  - Every test sets `XDG_CACHE_HOME` to a fresh temp folder for jig.

- [ ] **Step 1: Write the tests** (skipped without Docker, as the existing suites are), each for
  `--sandbox docker` and `--sandbox rootlesskit` (rootlesskit skipped when unavailable):
  1. First run of `localhost:<port>/jig/typescript:test` (pushed with `extraPlatform: true`)
     commits; the `Refactor-Command` image ends with `@<index digest>`; output has no `notes`.
  2. `jig verify` of that commit passes.
  3. Registry stopped: the same tag runs again, output `notes` has one entry containing
     `could not be reached`; verify of the first commit still passes (store has it).
  4. Registry stopped and a fresh `XDG_CACHE_HOME`: run of the tag fails with
     `REGISTRY_UNAVAILABLE`.
  5. Tag moved to the prettier image: run pins the new digest; verify of the commit from test 1
     still passes (pinned digest, from the store).
  6. `localhost:<port>/never/pushed:1` → `IMAGE_NOT_FOUND`, instructions mention `localhost/`.
  7. `localhost/jig/typescript:local` behaves as before (existing suites cover it; one smoke run here).
- [ ] **Step 2: Run** `swift test --filter RegistryTests` in `swift/cli` — PASS (they exercise
  Tasks 1–12; failures here are bugs in those tasks, fixed there).
- [ ] **Step 3: Run everything:** `sh scripts/test-swift.sh`, the package tests
  (`NODE=/home/coder/.local/opt/node-v26.13.1-linux-x64/bin/node sh scripts/test-packages.sh`,
  not through pnpm) and `pnpm typecheck` — all PASS.
- [ ] **Step 4: Commit** `test(cli): registry images end to end`.
