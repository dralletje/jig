#!/bin/sh
# Builds the static release binary of the Swift host (the package swift/cli, with the packages it
# depends on) and copies it to dist/jig.
# Prints that path. Needs only a POSIX shell and Swift (no Node).
#
# Swift is taken from $SWIFT, else `swift` on PATH, else the toolchain swiftly installs
# (not on PATH by default). It must be the version the Static Linux SDK belongs to.
set -eu

SWIFT_VERSION=6.4.2
SWIFT_SDK=x86_64-swift-linux-musl

repo_root=$(cd "$(dirname "$0")/.." && pwd)
cli_dir="$repo_root/swift/cli"
out_path="$repo_root/dist/jig"

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

version=$("$swift" --version 2>&1 | head -n 1) || version="unknown"
case "$version" in
  *"$SWIFT_VERSION"*) ;;
  *)
    echo "$swift is not Swift $SWIFT_VERSION (found: $version)." >&2
    echo "Install it with swiftly (swiftly install $SWIFT_VERSION), then set SWIFT to its swift binary or put it on PATH." >&2
    exit 1
    ;;
esac

# No debug info, and the symbol table stripped at link time: one small distributable binary.
# A scratch path of its own: SwiftPM locks its scratch path for as long as it runs, and `swift test` in
# swift/cli (whose end-to-end tests call this script) holds the lock on the default `.build`.
scratch="$cli_dir/.build/static-linux"
cd "$cli_dir"
"$swift" build -c release --swift-sdk "$SWIFT_SDK" --scratch-path "$scratch" -Xswiftc -gnone -Xlinker -s >&2
bin_dir=$("$swift" build -c release --swift-sdk "$SWIFT_SDK" --scratch-path "$scratch" -Xswiftc -gnone -Xlinker -s --show-bin-path)
product="$bin_dir/jig"
if [ ! -f "$product" ]; then
  echo "swift build did not produce $product" >&2
  exit 1
fi

mkdir -p "$repo_root/dist"
cp "$product" "$out_path"
chmod 755 "$out_path"
echo "$out_path"
