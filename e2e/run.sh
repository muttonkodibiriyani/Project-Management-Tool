#!/usr/bin/env bash
# Runs the end-to-end suite against one Launch Tracker image: starts the image with PostgreSQL and
# Blob storage (Azurite) on a private network, then drives it with Playwright from its own pinned
# container, so the browser and its libraries are the same on every machine and in CI.
#
#   bash e2e/run.sh --image ghcr.io/muttonkodibiriyani/launch-tracker@sha256:<digest>
#   bash e2e/run.sh --image <name>@sha256:<digest> --repeat 3     every test three times in a row
#   bash e2e/run.sh --stop                                         remove everything this script started
#
# Options: --engine docker|podman, --grep <pattern> (only the tests whose title matches),
#   --browser chromium|firefox (one browser instead of both).
# Everything it starts is named launch-tracker-e2e-*. Nothing is published on the host. The database
# and storage start empty with throwaway passwords, and the tests use synthetic data only.
# The report, traces, screenshots and videos land in e2e/playwright-report and e2e/test-results.
set -euo pipefail

POSTGRES_IMAGE=docker.io/library/postgres:16-alpine@sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab
AZURITE_IMAGE=mcr.microsoft.com/azure-storage/azurite:3.37.0@sha256:830430c1da1a2d537e08f3e6764dd1f5ae00cf0346bcaf625b968ec3f0971fd5
# Keep the tag in step with @playwright/test in e2e/package.json: the browsers in this image are the ones that version drives.
PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea
NAME=launch-tracker-e2e
E2E_DIR=$(cd "$(dirname "$0")" && pwd)

say() { printf '==> %s\n' "$*"; }
fail() {
  printf '\nEnd-to-end run failed: %s\n' "$*" >&2
  exit 1
}
usage() { sed -n '2,14s/^# \{0,1\}//p' "$0"; }

image=""
engine=docker
repeat=1
grep_pattern=""
browser=""
stop=0
while [ $# -gt 0 ]; do
  case "$1" in
    --image | --engine | --repeat | --grep | --browser)
      [ $# -ge 2 ] || fail "$1 needs a value."
      case "$1" in
        --image) image=$2 ;;
        --engine) engine=$2 ;;
        --repeat) repeat=$2 ;;
        --grep) grep_pattern=$2 ;;
        --browser) browser=$2 ;;
      esac
      shift 2
      ;;
    --stop)
      stop=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) fail "unknown option '$1'. Run with --help to see the options." ;;
  esac
done

case "$engine" in docker | podman) ;; *) fail "--engine must be docker or podman, not '$engine'." ;; esac
case "$browser" in '' | chromium | firefox) ;; *) fail "--browser must be chromium or firefox, not '$browser'." ;; esac
case "$repeat" in '' | *[!0-9]* | 0) fail "--repeat must be a whole number from 1, not '$repeat'." ;; esac
"$engine" info >/dev/null 2>&1 || fail "$engine is not running. Start it, then run this again."

remove_all() {
  "$engine" rm -f -v "$NAME-playwright" "$NAME-app" "$NAME-storage" "$NAME-postgres" >/dev/null 2>&1 || true
  "$engine" network rm "$NAME" >/dev/null 2>&1 || true
}

if [ "$stop" = 1 ]; then
  remove_all
  say "Stopped and removed the end-to-end containers."
  exit 0
fi

[ -n "$image" ] || fail "give the image to test with --image <name>@sha256:<digest>."
printf '%s' "$image" | grep -Eq '@sha256:[0-9a-f]{64}$' ||
  fail "give the image by digest (<name>@sha256:<digest>) so the suite tests exactly what CI built, not '$image'."
say "Image $image"

remove_all
trap remove_all EXIT

say "Downloading the images"
for ref in "$image" "$POSTGRES_IMAGE" "$AZURITE_IMAGE" "$PLAYWRIGHT_IMAGE"; do
  "$engine" pull --quiet "$ref" >/dev/null || fail "could not download $ref. Check the internet connection, then run this again."
done

say "Starting PostgreSQL, Blob storage and the app (empty, with throwaway passwords)"
db_password=$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')
storage_key=$(head -c 32 /dev/urandom | base64 | tr -d '\n')
"$engine" network create "$NAME" >/dev/null || fail "could not create the $NAME network; the $engine message above says why."
"$engine" run -d --name "$NAME-postgres" --network "$NAME" --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_USER=launchtracker -e POSTGRES_DB=launchtracker -e POSTGRES_PASSWORD="$db_password" \
  "$POSTGRES_IMAGE" >/dev/null || fail "PostgreSQL did not start; the $engine message above says why."
"$engine" run -d --name "$NAME-storage" --network "$NAME" -e AZURITE_ACCOUNTS="launchtracker:$storage_key" \
  "$AZURITE_IMAGE" azurite-blob --blobHost 0.0.0.0 --inMemoryPersistence --skipApiVersionCheck >/dev/null ||
  fail "Blob storage (Azurite) did not start; the $engine message above says why."
tries=0
until "$engine" exec "$NAME-postgres" pg_isready -q -h 127.0.0.1 -U launchtracker -d launchtracker; do
  tries=$((tries + 1))
  if [ "$tries" -ge 60 ]; then
    "$engine" logs --tail 30 "$NAME-postgres" >&2
    fail "PostgreSQL did not become ready within 60 seconds; its log is above."
  fi
  sleep 1
done
"$engine" run -d --name "$NAME-app" --network "$NAME" \
  -e PGHOST="$NAME-postgres" -e PGDATABASE=launchtracker -e PGUSER=launchtracker -e PGPASSWORD="$db_password" -e PGSSLMODE=disable \
  -e BLOB_CONNECTION_STRING="DefaultEndpointsProtocol=http;AccountName=launchtracker;AccountKey=$storage_key;BlobEndpoint=http://$NAME-storage:10000/launchtracker;" \
  -e BLOB_CONTAINER=launch-tracker \
  "$image" >/dev/null || fail "the app did not start; the $engine message above says why."

say "Running the end-to-end suite (each test ${repeat} time(s))"
rm -rf "$E2E_DIR/test-results" "$E2E_DIR/playwright-report"
set -- npx playwright test --repeat-each "$repeat"
[ -z "$grep_pattern" ] || set -- "$@" --grep "$grep_pattern"
[ -z "$browser" ] || set -- "$@" --project "$browser"
# The suite installs its own locked packages inside the container, into a tmpfs the host never sees,
# and runs as the host user so the report and traces it writes stay the host user's files.
if ! "$engine" run --rm --name "$NAME-playwright" --network "$NAME" --init --shm-size 1g \
  --user "$(id -u):$(id -g)" -e HOME=/tmp -e CI="${CI:-}" -e NPM_CONFIG_UPDATE_NOTIFIER=false -e BASE_URL="http://$NAME-app:8080" \
  -v "$E2E_DIR:/e2e" --tmpfs /e2e/node_modules:exec,mode=1777 -w /e2e \
  "$PLAYWRIGHT_IMAGE" sh -c 'npm ci --ignore-scripts --no-audit --no-fund --loglevel=error && "$@"' sh "$@"; then
  printf '\nApp log (last 50 lines):\n' >&2
  "$engine" logs --tail 50 "$NAME-app" >&2 || true
  fail "the suite did not pass; the output above says which test failed, or why the runner could not start. For a failed test, open e2e/playwright-report/index.html, or its trace with: npx playwright show-trace e2e/test-results/<test>/trace.zip"
fi
say "Every end-to-end test passed."
