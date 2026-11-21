#!/usr/bin/env bash
# Runs vitest with TMPDIR on a temporary case-sensitive APFS volume: `pnpm test:case-sensitive [vitest args/paths]`.
# Use it for tests that skip on the default (case-insensitive) macOS disk, such as the extension-case twin
# tests (a.md beside a.MD) and the NFD twin test that needs case-sensitive, normalization-insensitive APFS.
# macOS only. The image is created, attached, and always detached and deleted on exit.
set -euo pipefail

if [ "$(uname -s)" != Darwin ]; then
  echo 'test:case-sensitive: needs macOS (hdiutil and APFS); on Linux run `pnpm test` (ext4 is already case-sensitive)' >&2
  exit 1
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
mnt="$work/mnt"
mkdir "$mnt"
cleanup() {
  hdiutil detach "$mnt" -force >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

hdiutil create -quiet -size 512m -type SPARSE -fs 'Case-sensitive APFS' -volname BoostCaseSensitive "$work/cs"
hdiutil attach -quiet -nobrowse -mountpoint "$mnt" "$work/cs.sparseimage"
mkdir "$mnt/tmp"

cd "$root"
TMPDIR="$mnt/tmp" pnpm exec vitest run "$@"
