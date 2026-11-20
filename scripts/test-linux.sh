#!/usr/bin/env bash
# Runs vitest on Linux (ext4, case-sensitive) in Docker: `pnpm test:linux [vitest args/paths]`.
# Use it for tests that skip on the default macOS disk, such as the extension-case twin tests (a.md beside a.MD).
# Copies the repository to a temp folder: what .gitignore keeps, minus .git, .scratch/ and .env* (untracked
# private files stay out of /tmp). It then mounts the copy read-only into
# node:24-bookworm, installs from the lockfile and runs vitest as the image's unprivileged `node` user, so
# tests that need a read-only folder (tests/cli/install.test.ts) behave as on a developer machine.
set -euo pipefail

command -v docker >/dev/null 2>&1 || { echo 'test:linux: docker is not on PATH' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo 'test:linux: the Docker daemon is not running (start Docker Desktop)' >&2; exit 1; }

root="$(cd "$(dirname "$0")/.." && pwd)"
# Under /tmp, which Docker Desktop shares with its VM by default. The mktemp folder stays 0700 so other local
# users cannot reach the copy; only the repo subfolder inside it is opened up for the container's `node` user.
copy="$(mktemp -d /tmp/boost-linux.XXXXXX)"
# Retried: macOS can write .DS_Store files into the folder while it is being deleted.
cleanup() {
  for _ in 1 2 3; do rm -rf "$copy" 2>/dev/null && return; sleep 1; done
  echo "test:linux: could not delete $copy" >&2
}
trap cleanup EXIT
rsync -a --exclude .git --exclude .scratch/ --exclude '.env*' --filter=':- .gitignore' "$root/" "$copy/repo/"
chmod -R a+rX "$copy/repo"

docker run --rm --user node -v "$copy/repo:/src:ro" node:24-bookworm bash -c '
  set -e
  cp -r /src "$HOME/work"
  cd "$HOME/work"
  export CI=1
  corepack pnpm install --frozen-lockfile --ignore-scripts >/dev/null
  corepack pnpm exec vitest run "$@"
' bash "$@"
