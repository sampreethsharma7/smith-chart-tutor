#!/usr/bin/env bash
# Smith Chart Tutor on macOS and Linux: called by Start-Mac.command and Start-Linux.sh.
# Fetches a private copy of Node.js into .runtime/ (first run only, checksum-verified), then hands
# over to scripts/launch.mjs, which installs, builds and starts the app. No admin rights needed:
# nothing is installed system-wide. To uninstall, delete this folder.
set -euo pipefail

NODE_VERSION=24.18.0
cd "$(dirname "$0")/.."

fail() {
  printf '\n  ✗ %s\n' "$1"
  shift
  for hint in "$@"; do printf '    • %s\n' "$hint"; done
  printf '\n'
  exit 1
}

[ -f package.json ] || fail "Please extract the ZIP first, then double-click the start file in the extracted folder."

case "$(uname -s)" in
  Darwin) OS=darwin; EXT=tar.gz ;;
  Linux) OS=linux; EXT=tar.xz ;;
  *) fail "This script is for macOS and Linux. On Windows, double-click Start-Windows.cmd." ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) ARCH=arm64 ;;
  x86_64 | amd64) ARCH=x64 ;;
  *) fail "Unsupported processor: $(uname -m)." ;;
esac

RT="$PWD/.runtime"
NAME="node-v$NODE_VERSION-$OS-$ARCH"
NODE_HOME="$RT/$NAME"
# Trust the company's certificates (the system store) for npm's downloads, as the browser does.
export NODE_OPTIONS=--use-system-ca
unset ELECTRON_RUN_AS_NODE

if [ ! -x "$NODE_HOME/bin/node" ]; then
  printf '\n  Smith Chart Tutor: first-time setup. This takes a few minutes, once.\n'
  printf '  Everything goes into this folder; nothing is installed on the system.\n\n'
  printf '  [1/3] Downloading a private copy of Node.js %s...\n' "$NODE_VERSION"
  command -v curl >/dev/null || fail "curl is needed (it comes with macOS; on Linux: sudo apt install curl)."
  mkdir -p "$RT"
  NET_HINTS=("Check the internet connection, then run the start file again."
    "On a company network, nodejs.org may be blocked or need a proxy: ask IT, or set HTTPS_PROXY and try again.")
  curl -fL --retry 3 --progress-bar -o "$RT/$NAME.$EXT" "https://nodejs.org/dist/v$NODE_VERSION/$NAME.$EXT" ||
    fail "Could not download Node.js from nodejs.org." "${NET_HINTS[@]}"
  curl -fsSL --retry 3 -o "$RT/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" ||
    fail "Could not download Node.js's checksums from nodejs.org." "${NET_HINTS[@]}"

  # Check the download against Node.js's published checksum.
  expected="$(awk -v f="$NAME.$EXT" '$2 == f { print $1 }' "$RT/SHASUMS256.txt")"
  if command -v shasum >/dev/null; then
    actual="$(shasum -a 256 "$RT/$NAME.$EXT" | awk '{ print $1 }')"
  else
    actual="$(sha256sum "$RT/$NAME.$EXT" | awk '{ print $1 }')"
  fi
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    rm -f "$RT/$NAME.$EXT" "$RT/SHASUMS256.txt"
    fail "The Node.js download did not match its published checksum, so it was not used." "Run the start file again to download it afresh."
  fi

  # Unpack beside, then move into place: a window closed halfway never leaves a half-unpacked Node.
  rm -rf "$RT/unpack" && mkdir -p "$RT/unpack"
  tar -xf "$RT/$NAME.$EXT" -C "$RT/unpack" || fail "Could not unpack Node.js."
  rm -rf "$NODE_HOME" && mv "$RT/unpack/$NAME" "$NODE_HOME" && rm -rf "$RT/unpack"
  rm -f "$RT/$NAME.$EXT" "$RT/SHASUMS256.txt"
fi

export PATH="$NODE_HOME/bin:$PATH"
"$NODE_HOME/bin/node" scripts/launch.mjs "$@"
