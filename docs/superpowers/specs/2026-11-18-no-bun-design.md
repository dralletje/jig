# Off Bun: Node 26 action images, Swift end-to-end tests

Status: approved in conversation ("Use node 26 for the images. Also swift for the end-to-end tests").
See `AGENTS.md`: we dislike Bun in this project. After this change nothing in the repo needs Bun.

## Why the images need a JavaScript runtime

The `typescript` image wraps TypeScript's language service and the `prettier` image wraps prettier;
both are JavaScript libraries. Our own action code around them is small TypeScript. Bun was only there
to run `.ts` directly. Node 26 does that too (type stripping, on by default), and the code already uses
only erasable syntax (`.ts` import extensions, `import type`, no enums, namespaces or parameter
properties).

## Decisions

- Action images run on **Node 26**, base image pinned to `node:26.13.1-slim`. Entrypoint
  `["node", "/app/packages/<pkg>/src/bin.ts"]`. Dependencies are installed at build time with the
  `npm` that ships with that image (Node 26 has no corepack, so no pnpm inside images). Network only at
  build time, as before.
- Bun-only APIs in the action code are replaced with Node built-ins: `Bun.Glob` → `path.matchesGlob`
  (stable in Node 26), `Bun.spawn`/`Bun.spawnSync` → `node:child_process`, `import.meta.dir` →
  `import.meta.dirname`, `Bun.file` → `node:fs`. `import.meta.main` exists in Node 26.
- Workspace packages are loaded as TypeScript source. Node refuses to strip types from files under
  `node_modules`, so inside the image the workspace packages must resolve to their real paths under
  `/app/packages` (npm `file:` dependencies are symlinks, which Node resolves to the real path). The
  builder verifies this with the smoke runs.
- Unit tests of the action packages (`packages/*/test`) use `node:test` and `node:assert/strict`, run
  with Node 26.13.1 (installed at `~/.local/share/node/node-v26.13.1-linux-x64/bin`, not on PATH; a
  test script finds it like `build-binary.sh` finds Swift, via `$NODE`, then `node` on PATH if it is
  26.x, then that path).
- `scripts/build-images.ts` becomes `scripts/build-images.sh` (POSIX sh, argv only, same tags and
  output: one line per image, `<tool> <tag> <id>`).
- The end-to-end tests move to **Swift**: an integration test target in `host/` using swift-testing,
  driving the built binary, `git` and `docker`. They keep every case of today's `e2e/` suite (same
  assertions), build the images and the probe image through `scripts/build-images.sh` (the probe gets
  a `containers/`-style Containerfile under `host/Tests/` on Node 26 too), and build the binary with
  `scripts/build-binary.sh`. They skip with a clear message when docker is unavailable. The `e2e/`
  TypeScript package is deleted.
  Decided during implementation: the probe is test-only, so it does not live under `containers/` and
  is not built by `scripts/build-images.sh`; the integration tests build it with `docker build` of
  `host/Tests/IntegrationTests/probe` directly.
- `test-utils` keeps the fixtures and `makeRepo`/`readTree` for the Node unit tests; the Swift tests
  copy fixtures from `packages/test-utils/fixtures` the same way.
- Host development tooling stays pnpm (workspace install, `pnpm typecheck`). `bun-types` is replaced
  by `@types/node`; any `bun.lock`, `bunfig.toml` and Bun mentions in docs go. `AGENTS.md` keeps the
  "we dislike Bun" note, now as "do not reintroduce it".

## Non-goals

- Changing what the actions do, the image contract, the CLI or the binary's behaviour.
- Matching tool versions to the target repo (later).
