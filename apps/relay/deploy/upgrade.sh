#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ $# -lt 3 || $# -gt 4 ]]; then
  printf '%s\n' 'Usage: upgrade.sh /absolute/compose.yaml new-repository@sha256:digest https://alternate/healthz [--force]'
  exit 2
fi
relay_compose=$1
relay_next=$2
relay_alternate=$3
relay_force=${4:-}
relay_previous=${LATCH_RELAY_IMAGE:?Set the currently deployed immutable image}
relay_data=${LATCH_RELAY_DATA_DIR:?Set the private state directory}
[[ $relay_compose == /* && $relay_data == /* && -f $relay_compose && -d $relay_data && ! -L $relay_data ]]
[[ $relay_next =~ ^[a-zA-Z0-9._:/-]+@sha256:[a-f0-9]{64}$ && $relay_previous =~ ^[a-zA-Z0-9._:/-]+@sha256:[a-f0-9]{64}$ ]]
[[ -z $relay_force || $relay_force == --force ]]
python3 -c 'import sys,urllib.parse;u=urllib.parse.urlsplit(sys.argv[1]);assert u.scheme=="https" and u.hostname and not u.username and not u.password and not u.query and not u.fragment' "$relay_alternate"
for relay_tool in docker curl flock python3; do command -v "$relay_tool" >/dev/null; done
# Use the same read-only directory lock as the installer.
exec 9<"$relay_data"
flock -n 9
relay_compose_command() { docker compose -f "$relay_compose" "$@"; }
relay_status() { relay_compose_command exec -T relay /opt/latch/node --disable-sigusr1 /opt/latch/latch-relay.mjs status --data-dir /var/lib/latch-relay; }
relay_count() { python3 -c 'import json,sys;v=json.load(sys.stdin);x=v[sys.argv[1]];assert type(x) is int and 0<=x<=20000;print(x)' "$1"; }
relay_before=$(relay_status)
relay_controls=$(printf '%s' "$relay_before" | relay_count controls)
relay_uncovered=$(printf '%s' "$relay_before" | relay_count withoutAlternate)
if (( relay_controls > 0 && relay_uncovered * 100 > relay_controls * 5 )) && [[ $relay_force != --force ]]; then
  printf '%s\n' 'More than 5% of control connections report no alternate relay; review before using --force.'
  exit 1
fi
# Pull and validate before disturbing the current process. No secrets enter image arguments.
docker pull "$relay_next"
docker run --rm --network none --read-only --user 65532:65532 --cap-drop ALL --security-opt no-new-privileges:true \
  --volume "$relay_data:/var/lib/latch-relay:ro" "$relay_next" check --data-dir /var/lib/latch-relay
if ! curl --fail --silent --max-time 5 --output /dev/null "$relay_alternate" 2>/dev/null; then
  printf '%s\n' 'Alternate health check failed before drain.'
  exit 1
fi
relay_compose_command exec -T relay /opt/latch/node --disable-sigusr1 /opt/latch/latch-relay.mjs drain --data-dir /var/lib/latch-relay
for ((relay_wait=0; relay_wait<60; relay_wait++)); do
  relay_state=$(relay_status | python3 -c 'import json,sys;print(json.load(sys.stdin)["supervisor"]["state"])')
  [[ $relay_state == drained ]] && break
  sleep 1
done
relay_compose_command stop --timeout 75 relay
LATCH_RELAY_IMAGE=$relay_next relay_compose_command up -d --no-deps --no-build relay
relay_returned=0
relay_healthy=0
for ((relay_wait=0; relay_wait<180; relay_wait+=5)); do
  if relay_compose_command exec -T relay /opt/latch/node --disable-sigusr1 /opt/latch/latch-relay.mjs health --data-dir /var/lib/latch-relay >/dev/null 2>&1; then
    relay_healthy=1
    relay_returned=$(relay_status 2>/dev/null | relay_count controls 2>/dev/null || printf '0')
    if (( relay_controls == 0 || relay_returned * 100 >= relay_controls * 80 )); then
      printf '%s\n' 'Replacement is healthy and the control-connection threshold has returned.'
      exit 0
    fi
  fi
  sleep 5
done
if (( relay_healthy == 0 || (relay_controls > 0 && relay_returned * 100 < relay_controls * 20) )); then
  printf '%s\n' 'Replacement missed the minimum recovery threshold; restoring the previous immutable image.'
  relay_compose_command stop --timeout 75 relay
  LATCH_RELAY_IMAGE=$relay_previous relay_compose_command up -d --no-deps --no-build relay
  exit 1
fi
printf '%s\n' 'Replacement is running, but fewer than 80% of controls returned within three minutes; inspect alternate routing and status.'
exit 1
