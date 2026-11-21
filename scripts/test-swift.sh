#!/bin/sh
# Runs `swift test` in every Swift package under swift/, in dependency order, so the package with the
# end-to-end tests (swift/cli, IntegrationTests) runs last. Stops at the first package that fails.
# Extra arguments go to every `swift test` (for example --skip IntegrationTests for the unit tests alone).
#
# Swift is taken from $SWIFT, else `swift` on PATH, else the toolchain swiftly installs (not on PATH by
# default), as in build-binary.sh.
set -eu

SWIFT_VERSION=6.4.2

repo_root=$(cd "$(dirname "$0")/.." && pwd)

if [ -n "${SWIFT:-}" ]; then
  swift=$SWIFT
elif command -v swift >/dev/null 2>&1; then
  swift=$(command -v swift)
elif [ -x "$HOME/.local/share/swiftly/toolchains/$SWIFT_VERSION/usr/bin/swift" ]; then
  swift="$HOME/.local/share/swiftly/toolchains/$SWIFT_VERSION/usr/bin/swift"
else
  echo "swift not found: set SWIFT, put swift on PATH, or install Swift $SWIFT_VERSION with swiftly" >&2
  exit 1
fi

# The integration tests run scripts/build-binary.sh, which must find the same Swift.
SWIFT=$swift
export SWIFT

for package in report process oci docker git sandbox sandbox+docker sandbox+rootlesskit cli; do
  echo "== swift test in swift/$package" >&2
  (cd "$repo_root/swift/$package" && "$swift" test "$@")
done
