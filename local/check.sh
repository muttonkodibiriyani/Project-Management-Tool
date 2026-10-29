#!/usr/bin/env bash
# Runs one Launch Tracker image with PostgreSQL and Blob storage (Azurite), then runs the smoke
# test from the same image. Works with Docker Desktop or Podman on Mac and Linux.
#
#   bash check.sh                  the newest image that passed CI on main
#   bash check.sh --image ghcr.io/muttonkodibiriyani/launch-tracker@sha256:<digest>
#   bash check.sh --stop           remove everything this script started
#
# Options: --port <n> (default 8080), --engine docker|podman, --expect-commit <sha>.
# Everything it starts is named launch-tracker-check-*. Only the app is published, on 127.0.0.1.
# The database and storage start empty with throwaway passwords, so no real data is involved.
set -euo pipefail

REPOSITORY=muttonkodibiriyani/launch-tracker
POSTGRES_IMAGE=docker.io/library/postgres:16-alpine@sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab
AZURITE_IMAGE=mcr.microsoft.com/azure-storage/azurite:3.37.0@sha256:830430c1da1a2d537e08f3e6764dd1f5ae00cf0346bcaf625b968ec3f0971fd5
NAME=launch-tracker-check

say() { printf '==> %s\n' "$*"; }
fail() {
  printf '\nCheck failed: %s\n' "$*" >&2
  [ "$started" = 0 ] || printf 'Remove what this run started with: bash %s --stop\n' "$0" >&2
  exit 1
}
usage() { sed -n '2,11s/^# \{0,1\}//p' "$0"; }

image=""
port=8080
engine=""
expect_commit=""
stop=0
started=0
while [ $# -gt 0 ]; do
  case "$1" in
    --image | --port | --engine | --expect-commit)
      [ $# -ge 2 ] || fail "$1 needs a value. Run with --help to see the options."
      case "$1" in
        --image) image=$2 ;;
        --port) port=$2 ;;
        --engine) engine=$2 ;;
        --expect-commit) expect_commit=$2 ;;
      esac
      shift 2
      ;;
    --stop) stop=1 && shift ;;
    -h | --help) usage && exit 0 ;;
    *) fail "unknown option $1. Run with --help to see the options." ;;
  esac
done
case "$port" in '' | *[!0-9]*) fail "--port must be a number, not '$port'." ;; esac

if [ -z "$engine" ]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    engine=docker
  elif command -v podman >/dev/null 2>&1 && podman info >/dev/null 2>&1; then
    engine=podman
  elif command -v docker >/dev/null 2>&1; then
    fail "Docker is installed but not running. Start Docker Desktop, wait until it says it is running, and run this again."
  elif command -v podman >/dev/null 2>&1; then
    fail "Podman is installed but its machine is not running. Run 'podman machine start', then run this again."
  else
    fail "neither Docker nor Podman is installed. Install Docker Desktop (https://www.docker.com/products/docker-desktop/) or Podman Desktop (https://podman-desktop.io/), then run this again."
  fi
fi
case "$engine" in docker | podman) ;; *) fail "--engine must be docker or podman, not '$engine'." ;; esac
"$engine" info >/dev/null 2>&1 || fail "$engine is not running. Start it, then run this again."

remove_all() {
  "$engine" rm -f -v "$NAME-smoke" "$NAME-app" "$NAME-storage" "$NAME-postgres" >/dev/null 2>&1 || true
  "$engine" network rm "$NAME" >/dev/null 2>&1 || true
}

if [ "$stop" = 1 ]; then
  remove_all
  say "Stopped and removed the Launch Tracker check containers."
  exit 0
fi

if [ -z "$image" ]; then
  say "Finding the newest image that passed CI on main"
  token=$(curl -fsS "https://ghcr.io/token?scope=repository:$REPOSITORY:pull" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p') ||
    fail "could not reach ghcr.io. Check the internet connection (and any proxy), then run this again."
  digest=$(curl -fsSI -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
    "https://ghcr.io/v2/$REPOSITORY/manifests/main" | tr -d '\r' | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: *//p') || digest=""
  [ -n "$digest" ] || fail "ghcr.io has no image tagged main for $REPOSITORY, or it is not public. Pass one with --image <name>@sha256:<digest>."
  image="ghcr.io/$REPOSITORY@$digest"
fi
printf '%s' "$image" | grep -Eq '@sha256:[0-9a-f]{64}$' ||
  fail "give the image by digest (<name>@sha256:<digest>) so you check exactly what CI built, not '$image'."
digest=${image##*@}
say "Image $image"

remove_all
if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
  fail "port $port is already in use on this computer. Close what uses it, or run with --port <another number>."
fi

say "Downloading the images (the first run takes a few minutes)"
for ref in "$image" "$POSTGRES_IMAGE" "$AZURITE_IMAGE"; do
  "$engine" pull --quiet "$ref" >/dev/null || fail "could not download $ref. Check the internet connection, then run this again."
done

say "Starting PostgreSQL and Blob storage (empty, with throwaway passwords)"
db_password=$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')
storage_key=$(head -c 32 /dev/urandom | base64 | tr -d '\n')
started=1
"$engine" network create "$NAME" >/dev/null || fail "could not create the $NAME network; the $engine message above says why."
"$engine" run -d --name "$NAME-postgres" --network "$NAME" --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_USER=launchtracker -e POSTGRES_DB=launchtracker -e POSTGRES_PASSWORD="$db_password" \
  "$POSTGRES_IMAGE" >/dev/null || fail "could not start PostgreSQL; the $engine message above says why."
"$engine" run -d --name "$NAME-storage" --network "$NAME" -e AZURITE_ACCOUNTS="launchtracker:$storage_key" \
  "$AZURITE_IMAGE" azurite-blob --blobHost 0.0.0.0 --inMemoryPersistence --skipApiVersionCheck >/dev/null ||
  fail "could not start Blob storage; the $engine message above says why."

waited=0
until "$engine" exec "$NAME-postgres" pg_isready -q -h 127.0.0.1 -U launchtracker -d launchtracker; do
  [ "$waited" -lt 60 ] || {
    "$engine" logs --tail 30 "$NAME-postgres" >&2
    fail "PostgreSQL did not start within 60 seconds; its log is above."
  }
  sleep 1 && waited=$((waited + 1))
done

say "Starting Launch Tracker"
"$engine" run -d --name "$NAME-app" --network "$NAME" -p "127.0.0.1:$port:8080" \
  -e PGHOST="$NAME-postgres" -e PGDATABASE=launchtracker -e PGUSER=launchtracker -e PGPASSWORD="$db_password" -e PGSSLMODE=disable \
  -e BLOB_CONNECTION_STRING="DefaultEndpointsProtocol=http;AccountName=launchtracker;AccountKey=$storage_key;BlobEndpoint=http://$NAME-storage:10000/launchtracker;" \
  -e BLOB_CONTAINER=launch-tracker -e IMAGE_DIGEST="$digest" \
  "$image" >/dev/null || fail "could not start Launch Tracker; the $engine message above says why."

say "Running the smoke test"
set -- "dist/smoke.js" "http://$NAME-app:8080" --expect-digest "$digest" --wait 90
[ -z "$expect_commit" ] || set -- "$@" --expect-commit "$expect_commit"
if ! "$engine" run --rm --name "$NAME-smoke" --network "$NAME" "$image" "$@"; then
  printf '\nThe app log:\n' >&2
  "$engine" logs --tail 40 "$NAME-app" >&2 || true
  fail "the smoke test failed; the lines marked FAIL above say what to fix."
fi
curl -fsS -o /dev/null "http://127.0.0.1:$port/healthz" ||
  fail "the app answers inside $engine but not at http://127.0.0.1:$port. Check that nothing else (a VPN or firewall) holds that port."

printf '\nLaunch Tracker is running at http://127.0.0.1:%s\n' "$port"
printf 'Stop it with: bash %s --stop\n' "$0"
