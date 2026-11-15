#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 3 || $2 != --used-bytes || ! $3 =~ ^[0-9]{1,16}$ ]]; then
  printf '%s\n' 'Usage: install.sh /absolute/compose.yaml --used-bytes <provider-cycle-bytes>' >&2
  exit 2
fi
relay_compose=$1
relay_used=$3
relay_image=${LATCH_RELAY_IMAGE:?Set an immutable repository@sha256 image}
relay_data=${LATCH_RELAY_DATA_DIR:?Set the private absolute state directory}
[[ $relay_compose == /* && -f $relay_compose && $relay_data == /* && -d $relay_data ]]
[[ $relay_image =~ ^[a-zA-Z0-9._:/-]+@sha256:[a-f0-9]{64}$ ]]
for relay_tool in docker flock python3; do command -v "$relay_tool" >/dev/null; done
exec 9>"$relay_data/.maintenance.lock"
flock -n 9
relay_compose_command() { docker compose -f "$relay_compose" "$@"; }
relay_admin() {
  relay_compose_command exec -T relay /opt/latch/node --disable-sigusr1 /opt/latch/latch-relay.mjs "$@" --data-dir /var/lib/latch-relay
}
relay_compose_command config --quiet
relay_compose_command run --rm --no-deps relay check --data-dir /var/lib/latch-relay
relay_compose_command up -d --no-deps --no-build --no-recreate relay

for ((relay_attempt=0; relay_attempt<30; relay_attempt++)); do
  if relay_status=$(relay_admin status 2>/dev/null); then
    relay_calibration=$(printf '%s' "$relay_status" | python3 -c 'import json,sys;s=json.load(sys.stdin).get("quota");print("local" if s is None else "calibrated" if s["calibrated"] else "pending")')
    if [[ $relay_calibration == pending ]]; then
      relay_admin quota set-used "$relay_used" >/dev/null
    fi
    if relay_admin health >/dev/null 2>&1; then
      printf '%s\n' 'Relay is ready. Export a private profile with the relay CLI.'
      exit 0
    fi
  fi
  sleep 1
done
printf '%s\n' 'Relay did not report ready. Inspect status before exposing the public endpoint.' >&2
exit 1
