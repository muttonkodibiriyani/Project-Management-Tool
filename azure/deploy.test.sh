#!/usr/bin/env bash
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
DEPLOY_SH_LIBRARY_ONLY=1
export DEPLOY_SH_LIBRARY_ONLY
# shellcheck source=deploy.sh disable=SC1091
source "$HERE/deploy.sh"

tests=0
test_output=$(mktemp)
trap 'rm -f "$test_output"' EXIT

expect_success() {
  local name=$1
  shift
  failures=0
  "$@" >"$test_output"
  if [ "$failures" -ne 0 ]; then
    sed 's/^/  /' "$test_output" >&2
    printf 'not ok - %s: expected no failed controls, got %s\n' "$name" "$failures" >&2
    exit 1
  fi
  tests=$((tests + 1))
  printf 'ok - %s\n' "$name"
}

expect_failures() {
  local wanted=$1 name=$2
  shift 2
  failures=0
  "$@" >"$test_output"
  if [ "$failures" -ne "$wanted" ]; then
    sed 's/^/  /' "$test_output" >&2
    printf 'not ok - %s: expected %s failed controls, got %s\n' "$name" "$wanted" "$failures" >&2
    exit 1
  fi
  tests=$((tests + 1))
  printf 'ok - %s\n' "$name"
}

valid_app=$(jq -n '{
  optionalClaims: {idToken: [{name: "email"}, {name: "acct"}]},
  web: {implicitGrantSettings: {enableIdTokenIssuance: false, enableAccessTokenIssuance: false}},
  appRoles: (["Workspace.Admin", "Launch.Manager", "BrandTeam", "Supply", "VM", "Comms", "Viewer"]
    | map({value: ., isEnabled: true, allowedMemberTypes: ["User"]}))
}')
expect_success "Entra manifest accepts the exact token claims, grants and roles" check_entra_application "$valid_app"

invalid_app=$(printf '%s' "$valid_app" | jq '
  .optionalClaims.idToken = [{name: "email"}]
  | .web.implicitGrantSettings.enableIdTokenIssuance = true
  | .appRoles = [.appRoles[] | select(.value != "Viewer")]
')
expect_failures 3 "Entra manifest rejects a missing claim, implicit grant and missing role" check_entra_application "$invalid_app"

LZ_ENTRA_TENANT_ID=00000000-0000-0000-0000-000000000001
principal=00000000-0000-0000-0000-000000000002
valid_credentials=$(jq -n --arg subject "$principal" --arg issuer "https://login.microsoftonline.com/$LZ_ENTRA_TENANT_ID/v2.0" '[
  {subject: $subject, issuer: $issuer, audiences: ["api://AzureADTokenExchange"]},
  {subject: "unrelated", issuer: $issuer, audiences: ["api://AzureADTokenExchange"]}
]')
expect_success "managed-identity federation accepts the exact issuer, subject and audience" check_federated_credential "$valid_credentials" "$principal"

wrong_audience=$(printf '%s' "$valid_credentials" | jq '.[0].audiences = ["api://wrong"]')
expect_failures 1 "managed-identity federation rejects the wrong audience" check_federated_credential "$wrong_audience" "$principal"

connections_fixture='[]'
zones_fixture='[]'
az() {
  case "$1 $2 $3" in
    "network private-endpoint-connection list")
      [ "${4:-}" = --id ] && [ "${5:-}" = "$registry_id" ] || return 2
      printf '%s' "$connections_fixture"
      ;;
    "network private-endpoint dns-zone-group")
      [ "${4:-}" = list ] || return 2
      [ "${5:-}" = -g ] && [ "${6:-}" = platform-network ] || return 2
      [ "${7:-}" = --endpoint-name ] && [ "${8:-}" = pe-shared-acr ] || return 2
      [ "${9:-}" = --subscription ] && [ "${10:-}" = 00000000-0000-0000-0000-000000000001 ] || return 2
      printf '%s' "$zones_fixture"
      ;;
    *) return 2 ;;
  esac
}

endpoint_id=/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/platform-network/providers/Microsoft.Network/privateEndpoints/pe-shared-acr
registry_id=/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/platform-registry/providers/Microsoft.ContainerRegistry/registries/sharedacr
registry_zone=/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/platform-dns/providers/Microsoft.Network/privateDnsZones/privatelink.azurecr.io
connections_fixture=$(jq -n --arg endpoint "$endpoint_id" '[{
  privateEndpoint: {id: $endpoint},
  groupIds: ["registry"],
  privateLinkServiceConnectionState: {status: "Approved"}
}]')
zones_fixture=$(jq -n --arg zone "$registry_zone" '[{privateDnsZoneConfigs: [{privateDnsZoneId: $zone}]}]')
expect_success "private endpoint follows a central target to its exact subresource and DNS zone" \
  check_private_endpoint "container registry" "$registry_id" registry "$registry_zone"

wrong_subresource=$(printf '%s' "$connections_fixture" | jq '.[0].groupIds = ["registry_data"]')
connections_fixture=$wrong_subresource
expect_failures 1 "private endpoint rejects a required-subresource mismatch" \
  check_private_endpoint "container registry" "$registry_id" registry "$registry_zone"

connections_fixture=$(jq -n --arg endpoint "$endpoint_id" '[{
  privateEndpoint: {id: $endpoint},
  groupIds: ["registry"],
  privateLinkServiceConnectionState: {status: "Approved"}
}]')
wrong_zone=$(printf '%s' "$zones_fixture" | jq '.[0].privateDnsZoneConfigs[0].privateDnsZoneId = "/wrong/zone"')
zones_fixture=$wrong_zone
expect_failures 1 "private endpoint rejects a DNS-zone mismatch" \
  check_private_endpoint "container registry" "$registry_id" registry "$registry_zone"

zones_fixture=$(jq -n --arg zone "$registry_zone" '[{privateDnsZoneConfigs: [{privateDnsZoneId: $zone}]}]')
connections_fixture=$(printf '%s' "$connections_fixture" | jq '.[0].privateLinkServiceConnectionState.status = "Pending"')
expect_failures 1 "private endpoint rejects a non-approved connection" \
  check_private_endpoint "container registry" "$registry_id" registry "$registry_zone"

route_table=/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.Network/routeTables/rt-lt-cae
expect_success "route-table association accepts the declared table" check_route_table_association "${route_table^^}" "$route_table"
expect_failures 1 "route-table association rejects a detached subnet" check_route_table_association "" "$route_table"

printf '1..%s\n' "$tests"
