#!/bin/sh
# Runs the unit tests of the action packages (packages/*/test/*.test.ts, and the ones next to an action in
# packages/*/src/**/test/*.test.ts) with Node's test runner.
# Extra arguments go to `node --test` (for example --test-name-pattern=rename).
#
# Node is taken from $NODE, else `node` on PATH when it is Node 26, else the Node 26 install in
# ~/.local/share/node (not on PATH by default). It must be Node 26: the tests run TypeScript source
# with Node's type stripping, as the action images do.
set -eu

NODE_VERSION=26.13.1

repo_root=$(cd "$(dirname "$0")/.." && pwd)
local_node="$HOME/.local/share/node/node-v$NODE_VERSION-linux-x64/bin/node"

if [ -n "${NODE:-}" ]; then
  node=$NODE
elif command -v node >/dev/null 2>&1 && case $(node --version 2>/dev/null) in v26.*) true ;; *) false ;; esac; then
  node=$(command -v node)
elif [ -x "$local_node" ]; then
  node=$local_node
else
  echo "Node 26 not found: set NODE, put Node 26 on PATH, or install Node $NODE_VERSION in ~/.local/share/node" >&2
  exit 1
fi

version=$("$node" --version 2>/dev/null) || version="unknown"
case "$version" in
  v26.*) ;;
  *)
    echo "$node is not Node 26 (found: $version). Set NODE to a Node 26 binary." >&2
    exit 1
    ;;
esac

cd "$repo_root"
"$node" --test "$@" 'packages/*/test/*.test.ts' 'packages/*/src/**/test/*.test.ts'
# The typescript tests again as the experimental typescript-beta image runs them, on TypeScript 7.1.0-beta.
echo "# again with JIG_TYPESCRIPT=7.1.0-beta (the typescript-beta image)"
JIG_TYPESCRIPT=7.1.0-beta exec "$node" --test "$@" 'packages/engine-typescript/test/*.test.ts' 'packages/engine-typescript/src/**/test/*.test.ts'
