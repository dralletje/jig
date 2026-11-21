# Host binary hardening: never hang, never leak, exact git, stricter reports

Status: approved in conversation (the owner said yes to each item). Applies to the Swift host binary in
`host/`. See `AGENTS.md` (no Bun; symlinks deferred; publishing topics deferred).

## 1. Timeout: none built in (owner decision)

- The binary has no `--timeout` option and no internal timeouts on its git (or docker) calls. Callers
  bound a run with the Linux `timeout` command (`timeout 600 jig …`), which sends SIGTERM;
  section 2's handling makes that clean.
- Callers use plain `timeout`, not `-s KILL` or `-k`: a SIGKILL cannot be cleaned up after (the
  container would keep running).
- The container still runs with a unique name (`--name jig-<random>`): the signal cleanup
  needs it to remove exactly that container.

## 2. Interruption

- On SIGINT, SIGTERM and SIGHUP the binary removes the container (`docker rm -f <name>`), the temp export
  and the temp index, then exits with status 130 (SIGINT) / 143 (SIGTERM) / 129 (SIGHUP) after printing
  `{"schema":"urn:jig:output:1","ok":false,"code":"INTERNAL","instructions":"interrupted …"}`.
- If the interruption arrives during the final fast-forward merge, it waits for the merge to finish
  (the repo must never be left half-updated), then exits as above but reports the commit if it landed.

## 5. Instructions on the binary's own errors

- Every error the binary itself produces (image not found, bad or unsupported report, git failures,
  docker failures, dirty tree, hidden edits, config errors, timeouts, interruption) has instructions
  that say what to do next. Keep the codes; existing tests matching on message prefixes are updated
  deliberately.

## 6. Exact git handling

- Git output parsed with `-z` is kept as raw bytes until a path is known to be valid UTF-8. A path that
  is not valid UTF-8 → `IMAGE_FAILED` (if the image created it) or `DIRTY_WORKTREE`-style refusal with
  instructions (if it is in the repo already), never a lossy decode. Maps keyed by path use exact bytes.
- Every git invocation runs with a cleaned environment: drop all `GIT_*` variables inherited from the
  caller (including `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_COMMON_DIR`,
  `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*`/`GIT_CONFIG_VALUE_*`, `GIT_NAMESPACE`,
  `GIT_INDEX_FILE`, `GIT_WORK_TREE`, `GIT_DIR`, `GIT_CEILING_DIRECTORIES`), then set only the ones the
  binary needs explicitly.
- A child process killed by a signal is reported as "killed by signal N" (not as exit code N), in
  image failures and git/docker failures alike.

## 7. `.gitattributes` is protected like `.gitignore`

- An image that changes, adds or deletes any `.gitattributes` file → `IMAGE_FAILED`, nothing committed,
  with instructions. Also checked before the capture runs `git add` (so an image-written
  `.gitattributes` can never select a host filter driver during capture): the check walks the export
  for new or changed `.gitattributes` the same way the `.git` check does.

## 8. Stricter report checks

- The success report's `subject` must start with `<kind>(` for the reported `kind`; otherwise
  `IMAGE_FAILED` with instructions.
- The `effect` array must already be in canonical order (sorted by canonical JSON of each entry, no
  duplicates) — the binary checks and rejects instead of hashing an unstable order. Same for `misses`
  (sorted by canonical JSON of `{at, reason}`, no duplicates). Core's `okReport` already sorts; the
  check protects against other images.

## Tests

- Swift unit tests for every check (report prefix/order/duplicates, signal formatting, env cleaning,
  byte-exact path parsing).
- Integration tests through probe image modes: `timeout --preserve-status N jig …` on a
  hanging image → exit 143, one JSON failure (interrupted, with instructions), no container left
  (`docker ps -a` by name) and no temp dir left; SIGINT to the binary during a slow
  image → exit 130, no container, no temp dir; an image that writes `.gitattributes` (root and nested)
  → IMAGE_FAILED; an image that writes a file with a non-UTF-8 name → IMAGE_FAILED; an unsorted effect
  and a wrong subject prefix → IMAGE_FAILED; a process killed by a signal → "killed by signal".
