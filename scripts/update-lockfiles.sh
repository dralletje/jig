#!/bin/sh
# Regenerates containers/<tool>/package-lock.json, the lockfiles `npm ci` installs in the action images:
# every tool, or only the tools named as arguments. The lockfile has to be made from the manifests the
# image sees after its Containerfile's rewrite step, so this reproduces that step in a temporary
# directory (the `RUN node -e '...'` script is read from the Containerfile itself, so the two cannot
# drift apart), runs `npm install --package-lock-only` there, and copies the result back.
#
# Usage: update-lockfiles.sh [--fresh] [tool...]
#   --fresh  ignore the committed lockfile and resolve every range again (the default keeps the
#            versions already pinned and only adds or removes what the manifests changed)
#
# Node is taken from $NODE, else `node` on PATH when it is Node 26, else the Node 26 install in
# ~/.local/share/node (not on PATH by default). npm is the one next to that node. The user's npm
# config is ignored, so the lockfile does not depend on the machine it was made on.
set -eu

NODE_VERSION=26.13.1

repo_root=$(cd "$(dirname "$0")/.." && pwd)
local_node="$HOME/.local/share/node/node-v$NODE_VERSION-linux-x64/bin/node"

fresh=0
tools_given=0
available=""
for containerfile in "$repo_root"/containers/*/Containerfile; do
  [ -f "$containerfile" ] || continue
  tool=${containerfile%/Containerfile}
  available="$available ${tool##*/}"
done
available=${available# }

# Arguments: the optional --fresh, then tool names (checked below, then handled one by one).
for arg in "$@"; do
  case "$arg" in
    --fresh) fresh=1 ;;
    -*)
      echo "unknown option $arg (usage: update-lockfiles.sh [--fresh] [tool...])" >&2
      exit 1
      ;;
    *)
      tools_given=1
      case " $available " in
        *" $arg "*) ;;
        *)
          echo "unknown tool: $arg (available: $available)" >&2
          exit 1
          ;;
      esac
      ;;
  esac
done

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
node_dir=$(dirname "$(command -v "$node")")
npm="$node_dir/npm"
if [ ! -x "$npm" ]; then
  echo "npm not found next to $node ($npm)" >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
: >"$work/npmrc"

# The rewrite script of a Containerfile: the line `RUN node -e '<script>' \`.
run_prefix="RUN node -e '"
run_suffix="' \\"

update() {
  tool=$1
  containerfile="$repo_root/containers/$tool/Containerfile"
  dir="$work/$tool"
  mkdir -p "$dir"
  rewrite=""
  while IFS= read -r line; do
    case "$line" in
      "COPY packages/"*)
        source_dir=${line#COPY }
        source_dir=${source_dir%% *}
        mkdir -p "$dir/$source_dir"
        cp "$repo_root/$source_dir/package.json" "$dir/$source_dir/package.json"
        ;;
      "$run_prefix"*"$run_suffix")
        rewrite=${line#"$run_prefix"}
        rewrite=${rewrite%"$run_suffix"}
        ;;
    esac
  done <"$containerfile"
  if [ -z "$rewrite" ]; then
    echo "$containerfile has no \`RUN node -e '...' \\\` rewrite step" >&2
    exit 1
  fi
  cp "$repo_root/containers/$tool/package.json" "$dir/package.json"
  if [ "$fresh" -eq 0 ] && [ -f "$repo_root/containers/$tool/package-lock.json" ]; then
    cp "$repo_root/containers/$tool/package-lock.json" "$dir/package-lock.json"
  fi
  (
    cd "$dir"
    PATH="$node_dir:$PATH" "$node" -e "$rewrite"
    PATH="$node_dir:$PATH" "$npm" install --package-lock-only --omit=dev --no-audit --no-fund --no-update-notifier \
      --userconfig "$work/npmrc" >"$work/npm.log" 2>&1 || {
      echo "npm install --package-lock-only failed for $tool:" >&2
      tail -n 30 "$work/npm.log" >&2
      exit 1
    }
  )
  cp "$dir/package-lock.json" "$repo_root/containers/$tool/package-lock.json"
  echo "$tool containers/$tool/package-lock.json"
}

if [ "$tools_given" -eq 0 ]; then
  # shellcheck disable=SC2086 # split the tool names into the arguments
  set -- $available
fi
for tool in "$@"; do
  case "$tool" in
    --fresh) ;;
    *) update "$tool" ;;
  esac
done
