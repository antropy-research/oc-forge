#!/usr/bin/env bash
# Builds the image from the vendors as pinned. The build stages copy vendors/ without git metadata
# and cannot tell a pinned checkout from a changed one, so this checks first that each vendor the
# image builds is checked out at its pin and unmodified, then runs `docker compose build` with any
# arguments given (such as --no-cache).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel)"
for vendor in opencode openchamber vscode; do
  status="$(git -C "$root" submodule status "vendors/$vendor")"
  case "$status" in
    " "*) ;;
    -*) echo "vendors/$vendor is not checked out; run: git submodule update --init vendors/$vendor" >&2; exit 1 ;;
    *) echo "vendors/$vendor is not at its pin: $status" >&2; exit 1 ;;
  esac
  if [ -n "$(git -C "$root/vendors/$vendor" status --porcelain)" ]; then
    echo "vendors/$vendor has local changes; the image builds the pinned sources only" >&2
    exit 1
  fi
done
cd "$here"
exec docker compose build "$@"
