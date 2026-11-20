#!/bin/sh
# Starts the Host and the Latch desktop app, as `pnpm desktop` does, with node run directly instead of through pnpm.
#
# Why: macOS gives a process the hardware (MAC) addresses of its local-network neighbours only with Local Network
# access, and it counts a process started by pnpm or `fnm exec` as theirs. Those command-line tools never get that
# access, so a Host started by `pnpm desktop` sees an empty neighbour table and cannot prove that a phone on the same
# Wi-Fi is nearby: pairing over Wi-Fi fails with 「连不上这台 Mac」 and daily direct connections fall back to a relay.
# Started by node directly, the Host belongs to the terminal app instead, which macOS asks about once.
# Pairing over the iPhone's cable hotspot works either way (docs/RELAY.md, 本地网络权限).
#
# Usage, from anywhere: scripts/desktop.sh [the same arguments as `pnpm desktop --`], e.g. scripts/desktop.sh --demo
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

# `pnpm desktop` refuses another Node.js through package.json `engines`; this does not, so it says so.
want=$(cat .node-version)
have=$(node --version | sed 's/^v//')
if [ "$have" != "$want" ]; then
  echo "Latch 需要 Node.js $want（.node-version），当前是 $have。请先切换版本（例如 fnm use），不要用 fnm exec。" >&2
  exit 1
fi

# --disable-sigusr1 as every entry that starts the Host (AGENTS.md).
exec node --disable-sigusr1 --import tsx apps/host/scripts/desktop.ts "$@"
