#!/bin/sh
# To start from a source checkout, run `corepack pnpm desktop` directly from a terminal. This script starts the same
# Host and desktop app through Node.
#
# Run this script directly from a terminal if Corepack is unavailable.
# The launcher reuses a running Host for the same data directory. Stop that Host normally before switching how it starts.
#
# It accepts the same arguments as `corepack pnpm desktop --`, with no separator. For example, `./scripts/desktop.sh --demo`.
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

# The direct Node fallback uses the exact version in .node-version.
want=$(cat .node-version)
have=$(node --version | sed 's/^v//')
if [ "$have" != "$want" ]; then
  echo "Latch 需要 Node.js $want（.node-version），当前是 $have。请先切换版本（例如 fnm use），不要用 fnm exec。" >&2
  exit 1
fi

# --disable-sigusr1 as every entry that starts the Host (AGENTS.md).
exec node --disable-sigusr1 --import tsx apps/host/scripts/desktop.ts "$@"
