# Code actions as container images

"How the binary runs it" below is superseded by `2026-11-17-swift-host-design.md` (the Swift host).

Status: implemented. Supersedes, where they conflict, the "Reproducibility model" section and the
validation sections of `2026-11-17-jig-design.md`.

## Intent

A refactor commit should be reproducible from what it records alone: an image and its arguments. Run
that image on the parent commit's checkout, with no network, and you get the same tree. The images are
the code actions. The `jig` binary only runs an image on a clean copy of the repo and
commits what comes out.

The binary does not validate. The agent calling it validates the result itself (typecheck, tests). If an
image produces a broken tree, that is a bug in the image, not something the binary guards against.

## Goals

- One image per tool, not per refactor:
  - `typescript`: all `typescript-*` actions (rename, extract, lift-out, move-file, organize-imports),
    with the bundled TypeScript 6.0.3.
  - `prettier`: the `format` action, with prettier.
  - More tools later get their own image the same way.
- A script that builds every image with a local tag: `localhost/jig/<tool>:local`.
- `jig [--repo <path>] [--message <text>] <image> [args...]`: runs the image on a copy of
  `HEAD` with only committed files, no network, then commits the result. `args` go to the image
  verbatim.
- The commit records the pinned image and the args:
  `Refactor-Command: {"image":"localhost/jig/typescript:local@sha256:<id>","args":[...]}`.
  Passing that recorded `image` and `args` back to the binary on the parent commit replays it.
- The image describes its own result: it reports the commit subject. The binary knows nothing about
  any action.

## Non-goals (for now)

- Matching tool versions to the repo's own (its TypeScript, its prettier). Later, the binary will pick
  an image whose tool version matches the repo. For now: TypeScript 6.0.3 and one pinned prettier.
- Registry pushes and registry digests. Local images are pinned by image ID only.
- Validation of any kind in the binary: no typecheck, completeness or command validators.
- biome, prettier plugins, and anything else that would need the repo's `node_modules`.
- Rewriting references across package boundaries (workspace packages, an `extends` from npm).
- A `verify` command.

## Anti-goals

- The binary must not grow knowledge of individual actions. If it needs to know something about an
  action, the image tells it.
- The container must never see anything that is not committed: no `node_modules`, untracked or ignored
  files, `.git`, or host paths. It must never have network.

## Approaches

1. **One base image, a thin image per action, validation on the host.** Rejected: the user wants no
   validation in the binary, and one image per tool, not per action.
2. **Self-describing images (chosen by the user, "as much as possible").** The binary treats an image as
   a black box: workspace in, changed workspace plus a small JSON report out. Everything
   action-specific (parsing args, the commit subject) lives in the image.
3. **Validation inside the container too.** Rejected: without `node_modules` a typecheck is meaningless,
   and validation is the agent's job anyway.

## Design

### The image contract

- `/workspace` is a writable bind mount holding the files of `HEAD` and nothing else (no `.git`). It is
  also the working directory.
- The image is started with the args given to the binary, verbatim, after the image name.
- It changes files under `/workspace` in place: edits, creates and deletes.
- On success it exits 0 and prints one JSON object as the last line of stdout:
  `{"ok":true,"subject":"refactor(typescript-rename): foo → bar in a.ts"}`.
- On failure it exits non-zero and prints `{"ok":false,"error":{"code","message","details"}}`, with the
  same error codes as today (`SYMBOL_NOT_FOUND`, `REFACTOR_UNAVAILABLE`, `INVALID_ARGS`, ...). The binary
  passes that error through.
- It needs no network and no files outside `/workspace` apart from what is in the image.

### How the binary runs it

1. Refuse a dirty working tree (`DIRTY_WORKTREE`), as today. This includes files hidden from
   `git status` by assume-unchanged or skip-worktree, which `git ls-files -v` shows. This is not validation: it keeps unrelated
   edits out of the commit and makes `HEAD` equal what the image sees.
2. Resolve the image: `docker image inspect` gives its ID. A reference that already carries
   `@sha256:<id>` (a replay) is split by the binary itself, since local images have no registry digest:
   it runs that ID directly whenever it still exists locally, even if the tag now points elsewhere
   (builds are not byte-reproducible, so every rebuild moves the tag). An ID that is gone fails with
   `IMAGE_NOT_FOUND`, as does an unknown name. *(Builder's call, confirmed in review.)*
3. Export `HEAD` into a fresh temporary directory through a temporary index: `git read-tree HEAD`, then
   `git checkout-index -a --prefix=<tmp>/`. `git archive` is not used because it applies
   `export-ignore` and `export-subst` from `.gitattributes`, so the container would not see `HEAD`. The
   host's eol/smudge filters (`core.autocrlf`, LFS) do apply, so a replay is reproducible per host config.
4. `docker run --rm --network none --read-only --tmpfs /tmp -v <tmp>:/workspace -w /workspace <image id> <args...>`.
   Docker here is rootless, so files the container writes as root are owned by the user on the host.
   Only rootless docker is supported for now; rootful docker and podman are later. *(My call: the user
   said we are still testing locally.)*
5. Parse the last stdout line. On `ok:false` or a non-zero exit, fail with the image's error, or
   `IMAGE_FAILED` with the exit code and the last part of its output when it printed no JSON. A
   reported subject that is empty or contains a newline is `IMAGE_FAILED`.
6. Compare the directory with `HEAD`: a changed file is a file whose content differs, a deleted file is
   tracked but missing, a created file is present but untracked. No changes: `NO_CHANGES`. Symlinks are
   compared by their target text and never followed; a new or changed symlink, or anything that is not
   a regular file or a symlink, fails with `IMAGE_FAILED`, so an image can never pull a host file into
   the commit. The images are our own and trusted, so there are no time or memory limits yet. *(My
   call.)*
7. Write those changes into the repo (created files get the default mode), commit exactly those paths,
   and delete the temporary directory. A failure to delete it is written to stderr and never turns the
   result into a failure. Nothing is undone on failure, as today.
8. The commit message is the image's subject, then the optional `--message`, then
   `Refactor-Command: {"image":"<name>@sha256:<id>","args":[...]}` and `Co-Authored-By` (from
   `coAuthor` in `.jig.json`).
9. Print `{"ok":true,"commit","parent","image","args","filesChanged"}`.

### The images

- `containers/typescript/Containerfile`: Node 26 plus the engine and actions code with TypeScript 6.0.3
  bundled. The entrypoint is a small CLI in the engine package, `<action> --flags...`, with the same
  flags as today's CLI. It loads the engine on `/workspace`, runs the action, writes the overlay to
  disk, and prints the report.
- `containers/prettier/Containerfile`: Node 26 plus one pinned prettier 3 version. Args: `--files <globs>`.
  It formats every matching file in `/workspace` with the repo's own prettier config, and prints the
  report. It allows rather than refuses (decided by the user; later checks on the commits can reject
  what they don't want): with no prettier config in the repo it applies prettier's defaults (plus
  `.editorconfig`, as prettier does), and a config that fails to load (for example a JS config
  importing from `node_modules`) is ignored the same way, falling back to the defaults. A `plugins` entry is dropped (the image has none) and the rest of the
  config applies.
- `scripts/build-images.sh` (POSIX sh): builds every `containers/*/Containerfile` with the repo root as the
  build context, tagged `localhost/jig/<dir>:local`, and prints the tags and image IDs.

### How the typescript image sees a project (decided by the user)

Best effort. What it can see is rewritten; anything else stays as is, and the agent's own typecheck
afterwards catches what was missed.

- The project for an action is the folder of the nearest `tsconfig.json` above the target file
  (`--file`), or `/workspace` itself when there is none. Every `.ts`/`.tsx`/`.mts`/`.cts` file under that
  folder is in the project, whatever the tsconfig's `include`/`exclude`/`files` say.
- From that tsconfig the image takes `compilerOptions`, so `paths` (and `baseUrl`, `jsx` and the rest)
  apply: alias imports inside the project are rewritten too. Without a tsconfig, TypeScript's defaults.
- An `extends` that cannot be resolved (an npm package, which is absent without `node_modules`) is
  ignored without an error: the image uses the options it could read. Config errors and type errors in
  the project never stop an action.
- No workspace links, no `node_modules`, no other tsconfigs. In a monorepo, a rename in
  `packages/core` rewrites `packages/core` (and whatever its `paths` reach), not `packages/app`'s
  `@x/core` imports.
- For the file-glob actions (organize-imports), each matched file uses its own nearest tsconfig the
  same way.

This replaces the multi-project machinery in `TsEngine` (all tsconfigs in the repo, owner project,
merging edits across projects, realpaths for workspace symlinks). The monorepo fixture's cross-package
rename test goes; a test that `paths` aliases inside one package are rewritten replaces it.

### What changes in the existing code

- In the container there is no `.git`, so "tracked files" means every file under `/workspace`. The
  engine and the actions take their file list from a lister that walks the directory instead of
  calling `git ls-files`.
- The `Action` interface keeps `parseParams`, `describe` and `run`. `symbolNames`, `fileAliases` and
  `check` existed only for validation and go away.
- `format` moves out of `engine-typescript` into the prettier image's own small package. The `auto`
  formatter detection and the biome path go away.
- Removed: the `validators` package, in-process running of actions in `app` (`run.ts`, the action
  registry), the `actions`, `ignoreUncovered` and `tsconfigs` config keys (an unknown key stays an
  error), and `parseRefactorCommand`'s `action`/`params` shape, which becomes `image`/`args`.
- Kept: `coAuthor` in `.jig.json`, read by the binary on the host.

### Tests

- Engine and action tests run in-process on fixture copies, as now, with no docker. That is where
  action behaviour is tested.
- App tests run the real images, built once per test run with the build script. They cover: a rename
  commit and its trailer, a format commit, replaying a recorded command on the parent to get the same
  tree, an image error passed through, `NO_CHANGES`, and that the container sees no
  untracked file and has no network.

## Left to the builder

- The exact layout of the image entrypoint CLIs and of the prettier package.
- Base image choice (a `node` tag pinned by version, now `node:26.13.1-slim`) and how the workspace packages get into the
  typescript image.
- How the app tests skip cleanly when docker is unavailable.
