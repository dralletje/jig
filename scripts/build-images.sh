#!/bin/sh
# Builds the action images: every containers/<tool>/Containerfile, or only the tools named as
# arguments, with the repo root as the build context. Each is tagged
# localhost/jig/<tool>:local. Prints one line per image: `<tool> <tag> <id>`.
# On a failed build it exits non-zero and prints the tail of the build output to stderr.
set -eu

repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"

available=""
for containerfile in containers/*/Containerfile; do
  [ -f "$containerfile" ] || continue
  tool=${containerfile#containers/}
  available="$available ${tool%/Containerfile}"
done
available=${available# }

if [ "$#" -eq 0 ]; then
  # shellcheck disable=SC2086 # split the tool names into the arguments
  set -- $available
fi

unknown=""
for tool in "$@"; do
  case " $available " in
    *" $tool "*) ;;
    *) unknown="$unknown $tool" ;;
  esac
done
if [ -n "$unknown" ]; then
  echo "unknown tool(s):$unknown (available: $available)" >&2
  exit 1
fi

log=$(mktemp)
trap 'rm -f "$log"' EXIT

for tool in "$@"; do
  tag="localhost/jig/$tool:local"
  status=0
  docker build -f "containers/$tool/Containerfile" -t "$tag" . >"$log" 2>&1 || status=$?
  if [ "$status" -ne 0 ]; then
    echo "docker build of $tag failed (exit $status):" >&2
    tail -n 30 "$log" >&2
    exit 1
  fi
  id=$(docker image inspect --format '{{.Id}}' "$tag" 2>"$log") || status=$?
  if [ "$status" -ne 0 ]; then
    echo "docker image inspect $tag failed (exit $status):" >&2
    tail -n 30 "$log" >&2
    exit 1
  fi
  echo "$tool $tag $id"
done
