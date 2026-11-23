# Notes for agents working on jig

Decisions from the project owner that are not up for discussion until they say otherwise.

## Deferred: symlinks created by images

How to treat symlinks that an action image creates or changes in `/workspace` is deferred. Do not raise
it, propose options for it, or list it as a limitation or open question in reviews, plans or summaries.
Keep whatever behaviour the code has; the owner will come back to it.

## Deferred until publishing: do not mention

Until the owner says the project is moving to its publishing state, do not raise, suggest or list (in
reviews, plans, summaries or TODOs) anything about:
- local images, registries, image digests for sharing, signing, publishing;
- linting, CI, build commands, the repo's hosting or remote;
- license, README polish, backward compatibility;
and similar "make it public" concerns. Only discuss them when the owner asks.

## Publishing images: names and tags

When the owner asks to publish, images go to `ghcr.io/dralletje/jig/<image>-v<our major>`, with these
tags:
- `<tool version>-<our minor>.<our patch>`, for example `typescript-v1:6.0.3-0.1`: the exact build.
- `<tool version>` alone, for example `typescript-v1:6.0.3`: moved on every publish to the latest of
  our builds for that tool version.
- An image that wraps no tool (`fs`) has no tool version: it gets `<our minor>.<our patch>` only, for
  example `fs-v1:0.1`.
- `latest`, for example `fs-v1:latest`: moved on every publish to the newest build of that image name,
  so nobody has to type `-0.2` to be on the newest version.

While the typescript image carries a TypeScript beta (now 7.1.0-beta, for duplicate-folder, move-file,
rename-files and imports-to-*), its builds are tagged as beta only: `typescript-v1:6.0.3-0.4-beta`
(the exact build) and `typescript-v1:beta` (moved to the newest beta build). They do not move
`typescript-v1:6.0.3` or `latest`, which stay on the last build without the beta.

jig is alpha: breaking changes still ship under the same `-v1` name, with a new minor
(`6.0.3-0.3`). Only once the owner says the images are stable does a breaking change start a new image
name (`typescript-v2`), so nobody is moved across it by a tag. Steps:
1. Build from a clean `main` with `sh scripts/build-images.sh`.
2. Log in with a throwaway Docker config, so the token is not kept:
   `DOCKER_CONFIG=<temp dir>`, then `gh auth token | docker login ghcr.io -u dralletje --password-stdin`.
3. `docker tag localhost/jig/<image>:local <name>:<tag>` and `docker push` for both tags. The first push
   to a new package can be `denied` once; push it again.
4. Log out and delete the temp config.
5. A new package starts private: the owner makes it public on GitHub.

## `.gitignore` is respected

The host repo's `.gitignore` rules are respected for now:
- An image that changes a `.gitignore` file is rejected (`IMAGE_FAILED`).
- New files an image creates at ignored paths are ignored: they are not committed and never written
  into the host repo.

## We dislike `bun` in this project: it is gone, do not reintroduce it

Nothing in the repo uses Bun any more: the action images run on Node 26, the package tests use
`node --test`, the end-to-end tests are Swift (`sh scripts/test-swift.sh`, which runs `swift test` in every package under `swift/`), and the scripts are POSIX `sh`.
Do not reintroduce it: no `bun` commands or scripts, `Bun.*` APIs, `bun:` imports, `bun-types`,
`bun.lock`/`bunfig.toml`, or "run it with `bun`" instructions.

## Doubtful cases start as errors

When it is unclear whether an input or case should be allowed (an empty folder to unwrap, an odd path,
an edge case nobody asked about), refuse it with clear instructions. It can be allowed later, once the
owner decides it is really fine; a refusal is easy to lift, while silently doing something odd is not.

## Language split

The host binary (`jig`) is Swift, built as a single static binary. Actions stay in whatever
language their tool needs; that is why they run in containers.
