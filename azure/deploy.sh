#!/usr/bin/env bash
# Deploys Launch Tracker to Azure from Cloud Shell, and checks it. Only a person with rights on the
# landing zone runs this; nothing in CI or any agent does.
#
#   bash deploy.sh preflight --image <image@sha256:...>   check values, rights, what-if and image; change nothing
#   bash deploy.sh deploy    --image <image@sha256:...>   preflight, then deploy, smoke test, report
#   bash deploy.sh report                                 print the controls report (starts one probe run)
#   bash deploy.sh rollback  [--to <revision>]            serve the previous revision again
#
# Options: --values <file> (default landing-zone.env next to this script), --yes (no confirmation).
# The image is the one CI tagged main, by digest. The runbook, section 2, walks through every step.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPOSITORY=muttonkodibiriyani/launch-tracker
LOCATION=uaenorth
APP=ca-launch-tracker
MIGRATE_JOB=caj-lt-migrate
SMOKE_JOB=caj-lt-smoke
INFRA_DEPLOYMENT=lt-infra
APP_API=2025-07-01

say() { printf '==> %s\n' "$*"; }
fail() {
  printf '\nStopped: %s\n' "$*" >&2
  exit 1
}
usage() { sed -n '2,11s/^# \{0,1\}//p' "$0"; }

command=${1:-}
[ $# -gt 0 ] && shift
image=""
values="$HERE/landing-zone.env"
target=""
assume_yes=0
while [ $# -gt 0 ]; do
  case "$1" in
    --image | --values | --to)
      [ $# -ge 2 ] || fail "$1 needs a value. Run with --help to see the options."
      case "$1" in --image) image=$2 ;; --values) values=$2 ;; --to) target=$2 ;; esac
      shift 2
      ;;
    --yes) assume_yes=1 && shift ;;
    -h | --help) usage && exit 0 ;;
    *) fail "unknown option $1. Run with --help to see the options." ;;
  esac
done
case "$command" in
  preflight | deploy) [ -n "$image" ] || fail "$command needs --image <image@sha256:...>: the digest CI tagged main (runbook, section 2.2)." ;;
  report | rollback) ;;
  -h | --help | help) usage && exit 0 ;;
  *) fail "say what to do: preflight, deploy, report or rollback. Run with --help to see the options." ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"

# ---- Landing-zone values ---------------------------------------------------------------------

REQUIRED="SUBSCRIPTION_ID RESOURCE_GROUP VNET_ADDRESS_PREFIX DNS_SERVERS HUB_FIREWALL_IP
POSTGRES_DNS_ZONE_ID BLOB_DNS_ZONE_ID KEYVAULT_DNS_ZONE_ID REGISTRY_DNS_ZONE_ID POSTGRES_NETWORKING REGISTRY
ENTRA_TENANT_ID ENTRA_CLIENT_ID ENTRA_CREDENTIAL
GROUP_WORKSPACE_ADMIN GROUP_LAUNCH_MANAGER GROUP_BRAND_TEAM GROUP_SUPPLY GROUP_VM GROUP_COMMS GROUP_VIEWER
POC_EXCEPTIONS_ACCEPTED"

# Reads NAME=value lines without running them, so the file can hold nothing but values.
read_values() {
  [ -f "$values" ] || fail "there is no values file at $values. Copy landing-zone.env and fill in the landing-zone values."
  local line name value
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) continue ;; esac
    name=${line%%=*}
    value=${line#*=}
    case " $(echo "$REQUIRED" | tr '\n' ' ') " in
      *" $name "*) printf -v "LZ_$name" '%s' "$value" ;;
      *) fail "$values has an unknown line '$name=…'. Only the names in landing-zone.env belong there." ;;
    esac
  done <"$values"

  local missing="" bad="" name_ value_
  for name_ in $REQUIRED; do
    value_=$(lz "$name_")
    if [ -z "$value_" ]; then
      missing="$missing\n  - $name_ is not set"
    elif [ "${value_#<}" != "$value_" ]; then
      missing="$missing\n  - $name_ is still the placeholder $value_"
    fi
  done
  [ -z "$missing" ] || fail "these landing-zone values are missing in $values:$(printf '%b' "$missing")
Fill in each one from the landing-zone doc, never with a guess, then run this again."

  local guid='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  local ip='^([0-9]{1,3}\.){3}[0-9]{1,3}$'
  local zone='^/subscriptions/[0-9a-f-]{36}/resourceGroups/[^/]+/providers/Microsoft\.Network/privateDnsZones/'
  for name_ in SUBSCRIPTION_ID ENTRA_TENANT_ID ENTRA_CLIENT_ID GROUP_WORKSPACE_ADMIN GROUP_LAUNCH_MANAGER GROUP_BRAND_TEAM GROUP_SUPPLY GROUP_VM GROUP_COMMS GROUP_VIEWER; do
    lz "$name_" | grep -Eq "$guid" || bad="$bad\n  - $name_ must be an ID like 00000000-0000-0000-0000-000000000000 (lower case)"
  done
  lz VNET_ADDRESS_PREFIX | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}/(1[6-9]|2[0-2])$' || bad="$bad\n  - VNET_ADDRESS_PREFIX must be a range of /22 or wider, like 10.20.0.0/22"
  lz HUB_FIREWALL_IP | grep -Eq "$ip" || bad="$bad\n  - HUB_FIREWALL_IP must be an IP address"
  if [ "$LZ_DNS_SERVERS" != azure ] && printf '%s\n' "$LZ_DNS_SERVERS" | tr ',' '\n' | grep -Evq "$ip"; then
    bad="$bad\n  - DNS_SERVERS must be azure, or IP addresses separated by commas"
  fi
  lz POSTGRES_DNS_ZONE_ID | grep -Eq "${zone}privatelink\.postgres\.database\.azure\.com$" || bad="$bad\n  - POSTGRES_DNS_ZONE_ID must be the resource ID of privatelink.postgres.database.azure.com"
  lz BLOB_DNS_ZONE_ID | grep -Eq "${zone}privatelink\.blob\.core\.windows\.net$" || bad="$bad\n  - BLOB_DNS_ZONE_ID must be the resource ID of privatelink.blob.core.windows.net"
  lz KEYVAULT_DNS_ZONE_ID | grep -Eq "${zone}privatelink\.vaultcore\.azure\.net$" || bad="$bad\n  - KEYVAULT_DNS_ZONE_ID must be the resource ID of privatelink.vaultcore.azure.net"
  lz REGISTRY_DNS_ZONE_ID | grep -Eq "${zone}privatelink\.azurecr\.io$" || bad="$bad\n  - REGISTRY_DNS_ZONE_ID must be the resource ID of privatelink.azurecr.io"
  case "$LZ_POSTGRES_NETWORKING" in private-endpoint | vnet-integration) ;; *) bad="$bad\n  - POSTGRES_NETWORKING must be private-endpoint or vnet-integration" ;; esac
  case "$LZ_ENTRA_CREDENTIAL" in managed-identity | certificate) ;; *) bad="$bad\n  - ENTRA_CREDENTIAL must be managed-identity or certificate" ;; esac
  [ "$LZ_REGISTRY" = create ] || lz REGISTRY | grep -Eq '^/subscriptions/[0-9a-f-]{36}/resourceGroups/[^/]+/providers/Microsoft\.ContainerRegistry/registries/[A-Za-z0-9]+$' ||
    bad="$bad\n  - REGISTRY must be create, or the resource ID of a container registry"
  [ -z "$bad" ] || fail "these landing-zone values in $values are not in the right form:$(printf '%b' "$bad")"
}

lz() {
  local var="LZ_$1"
  printf '%s' "${!var:-}"
}

# ---- Azure helpers ---------------------------------------------------------------------------

azq() { az "$@" --only-show-errors -o tsv; }
infra() { azq deployment group show -g "$LZ_RESOURCE_GROUP" -n "$INFRA_DEPLOYMENT" --query "properties.outputs.$1.value"; }
job_id() { printf '/subscriptions/%s/resourceGroups/%s/providers/Microsoft.App/jobs/%s' "$LZ_SUBSCRIPTION_ID" "$LZ_RESOURCE_GROUP" "$1"; }

# Starts a job execution, with an optional container override (JSON), and prints its name.
start_job() {
  local body=${2:-'{}'}
  az rest --only-show-errors -m post -u "https://management.azure.com$(job_id "$1")/start?api-version=$APP_API" -b "$body" --query name -o tsv
}

# Waits for a job execution to finish; returns 0 only if it succeeded.
wait_job() {
  local job=$1 execution=$2 limit=$3 waited=0 status=""
  while [ "$waited" -lt "$limit" ]; do
    status=$(az rest --only-show-errors -m get -u "https://management.azure.com$(job_id "$job")/executions/$execution?api-version=$APP_API" --query properties.status -o tsv)
    case "$status" in
      Succeeded) return 0 ;;
      Failed | Stopped | Degraded) break ;;
    esac
    sleep 10 && waited=$((waited + 10))
  done
  printf '%s execution %s ended as %s.\n' "$job" "$execution" "${status:-unknown}" >&2
  return 1
}

# Prints a job execution's output from Log Analytics, which receives it within a few minutes.
print_job_log() {
  local execution=$1 workspace query rows tries=0
  workspace=$(azq monitor log-analytics workspace show -g "$LZ_RESOURCE_GROUP" -n "$(infra workspaceName)" --query customerId)
  query="ContainerAppConsoleLogs | where ContainerGroupName startswith '$execution' | order by TimeGenerated asc | project Log"
  while [ "$tries" -lt 18 ]; do
    rows=$(az monitor log-analytics query --only-show-errors -w "$workspace" --analytics-query "$query" --query '[].Log' -o tsv 2>/dev/null || true)
    if [ -n "$rows" ]; then
      printf '%s\n' "$rows" | sed 's/^/    /'
      return 0
    fi
    sleep 10 && tries=$((tries + 1))
  done
  printf '    (no output in Log Analytics yet; run this query in workspace %s later:\n     %s)\n' "$(infra workspaceName)" "$query"
}

# Says where the app's own explanation is: of a failing health check, or (with start) of not starting.
app_log_hint() {
  local filter="| where Log has '\"check\"' " why="The app logs why each check failed."
  if [ "${2:-}" = start ]; then
    filter="" why="The app logs why it did not start, after 'Launch Tracker cannot start:'."
  fi
  printf '%s In the Azure portal, open Log Analytics workspace %s and run:\n' "$why" "$(infra workspaceName)"
  printf "  ContainerAppConsoleLogs | where ContainerAppName == '%s' and RevisionName == '%s' %s| project TimeGenerated, Log\n" "$APP" "$1" "$filter"
}

# Runs the smoke test from the CI image inside the environment, against one revision.
smoke_revision() {
  local revision=$1 digest=$2 commit=${3:-} fqdn body execution
  fqdn=$(azq containerapp revision show -n "$APP" -g "$LZ_RESOURCE_GROUP" --revision "$revision" --query properties.fqdn)
  body=$(jq -n --arg image "$(registry_image "$digest")" --arg url "https://$fqdn" --arg digest "$digest" --arg commit "$commit" '{
    containers: [{
      name: "smoke", image: $image,
      args: (["dist/smoke.js", $url, "--expect-digest", $digest, "--wait", "120"] + (if $commit == "" then [] else ["--expect-commit", $commit] end)),
      resources: { cpu: 0.25, memory: "0.5Gi" }
    }]}')
  say "Smoke test of $revision at https://$fqdn"
  execution=$(start_job "$SMOKE_JOB" "$body")
  if wait_job "$SMOKE_JOB" "$execution" 300; then
    print_job_log "$execution"
    return 0
  fi
  print_job_log "$execution"
  app_log_hint "$revision" >&2
  return 1
}

registry_image() { printf '%s/launch-tracker@%s' "$(infra registryLoginServer)" "$1"; }
# The revision serving all traffic, whether the traffic entry names it or says latest.
live_revision() {
  { az containerapp show -n "$APP" -g "$LZ_RESOURCE_GROUP" --only-show-errors -o json 2>/dev/null || echo '{}'; } |
    jq -r '.properties as $p | [($p.configuration.ingress.traffic // [])[] | select(.weight == 100)
      | (.revisionName // (if .latestRevision then $p.latestRevisionName else empty end))][0] // ""'
}
# The revision that served before the last deploy; deploy records it as a tag on the app.
previous_revision() {
  azq containerapp show -n "$APP" -g "$LZ_RESOURCE_GROUP" --query 'tags."lt-previous-revision"' 2>/dev/null || true
}
# The app's address, its FQDN in the environment's domain, and the sign-in redirect URI under it; both are
# known once the infrastructure exists.
public_origin() {
  local domain
  domain=$(infra environmentDomain 2>/dev/null || true)
  if [ -n "$domain" ]; then printf 'https://%s.%s' "$APP" "$domain"; fi
}
redirect_uri() {
  local origin
  origin=$(public_origin)
  if [ -n "$origin" ]; then printf '%s/auth/callback' "$origin"; fi
}

# ---- Preflight -------------------------------------------------------------------------------

check_tools() {
  local tool
  for tool in az jq curl tar; do
    command -v "$tool" >/dev/null || fail "$tool is not installed. Run this in Azure Cloud Shell (Bash), which has it."
  done
  az account show >/dev/null 2>&1 || fail "the Azure CLI is not signed in. Run 'az login', then run this again."
  az extension show -n containerapp >/dev/null 2>&1 || fail "the Azure CLI containerapp extension is missing. Run 'az extension add -n containerapp', then run this again."
}

check_account() {
  az account set -s "$LZ_SUBSCRIPTION_ID" 2>/dev/null || fail "you cannot use subscription $LZ_SUBSCRIPTION_ID. Check SUBSCRIPTION_ID, and that your account (az account show) has access to it."
  [ "$(azq account show --query tenantId)" = "$LZ_ENTRA_TENANT_ID" ] ||
    fail "subscription $LZ_SUBSCRIPTION_ID is not in tenant $LZ_ENTRA_TENANT_ID. Check SUBSCRIPTION_ID and ENTRA_TENANT_ID."
  local location
  location=$(azq group show -n "$LZ_RESOURCE_GROUP" --query location 2>/dev/null) ||
    fail "resource group $LZ_RESOURCE_GROUP does not exist in that subscription, or you cannot see it. The landing zone creates it."
  [ "$location" = "$LOCATION" ] || fail "resource group $LZ_RESOURCE_GROUP is in $location, not UAE North ($LOCATION). Ask the platform team which group to use."

  local me roles
  me=$(azq ad signed-in-user show --query id) || fail "the Azure CLI cannot read your Entra account. Sign in as a user with 'az login'."
  roles=$(azq role assignment list --assignee "$me" --include-groups --include-inherited --scope "$(azq group show -n "$LZ_RESOURCE_GROUP" --query id)" --query '[].roleDefinitionName')
  if ! printf '%s\n' "$roles" | grep -qx Owner; then
    { printf '%s\n' "$roles" | grep -qx Contributor && printf '%s\n' "$roles" | grep -Eqx 'User Access Administrator|Role Based Access Control Administrator'; } ||
      fail "your account needs Owner on $LZ_RESOURCE_GROUP, or Contributor plus Role Based Access Control Administrator, to create the resources and their role assignments. If the role is PIM-eligible, activate it, then run this again."
  fi

  local provider state unregistered=""
  for provider in Microsoft.App Microsoft.ContainerRegistry Microsoft.DBforPostgreSQL Microsoft.Insights Microsoft.KeyVault Microsoft.ManagedIdentity Microsoft.Network Microsoft.OperationalInsights Microsoft.Storage; do
    state=$(azq provider show -n "$provider" --query registrationState)
    [ "$state" = Registered ] || unregistered="$unregistered $provider"
  done
  [ -z "$unregistered" ] || fail "these resource providers are not registered in the subscription:$unregistered. Ask the platform team to register them."
  say "Subscription, resource group, your rights and the resource providers are right"
}

# The digest must be the one CI tagged main, and its image must hold the migrate and smoke scripts.
check_image() {
  printf '%s' "$image" | grep -Eq "^ghcr\.io/$REPOSITORY@sha256:[0-9a-f]{64}$" ||
    fail "--image must be ghcr.io/$REPOSITORY@sha256:<digest>, the image CI tagged main, not '$image'."
  digest=${image##*@}
  local token accept main_digest manifest config_digest layers layer
  token=$(curl -fsS "https://ghcr.io/token?scope=repository:$REPOSITORY:pull" | jq -r .token) ||
    fail "could not reach ghcr.io from Cloud Shell. Try again in a minute."
  accept='application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json'
  main_digest=$(curl -fsSI -H "Authorization: Bearer $token" -H "Accept: $accept" "https://ghcr.io/v2/$REPOSITORY/manifests/main" |
    tr -d '\r' | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: *//p') ||
    fail "could not read which image CI tagged main from ghcr.io. Try again in a minute."
  [ "$main_digest" = "$digest" ] ||
    fail "$digest is not the image CI tagged main (main is ${main_digest:-not found}). Deploy the digest from the newest green CI run on main (runbook, section 2.2)."

  manifest=$(curl -fsS -H "Authorization: Bearer $token" -H "Accept: $accept" "https://ghcr.io/v2/$REPOSITORY/manifests/$digest") ||
    fail "could not read image $digest from ghcr.io. Try again in a minute."
  if printf '%s' "$manifest" | jq -e 'has("manifests")' >/dev/null; then
    layer=$(printf '%s' "$manifest" | jq -r '[.manifests[] | select(.platform.os == "linux" and .platform.architecture == "amd64") | .digest][0] // ""')
    [ -n "$layer" ] || fail "image $digest has no linux/amd64 build. Use an image built by CI."
    manifest=$(curl -fsS -H "Authorization: Bearer $token" -H "Accept: $accept" "https://ghcr.io/v2/$REPOSITORY/manifests/$layer") ||
      fail "could not read the linux/amd64 build of image $digest from ghcr.io. Try again in a minute."
  fi
  config_digest=$(printf '%s' "$manifest" | jq -r .config.digest)
  commit=$(curl -fsSL -H "Authorization: Bearer $token" "https://ghcr.io/v2/$REPOSITORY/blobs/$config_digest" | jq -r '.config.Labels["org.opencontainers.image.revision"] // ""')
  printf '%s' "$commit" | grep -Eq '^[0-9a-f]{40}$' || fail "image $digest does not say which commit it was built from. Use an image built by CI."

  # The app's own files are in the image's last small layers; look there for both job scripts.
  layers=$(printf '%s' "$manifest" | jq -r '.layers[] | select(.size < 20000000) | .digest')
  : >"$work/files"
  for layer in $layers; do
    curl -fsSL -H "Authorization: Bearer $token" "https://ghcr.io/v2/$REPOSITORY/blobs/$layer" | tar -tzf - 2>/dev/null >>"$work/files" || true
  done
  grep -qx 'app/dist/smoke.js' "$work/files" || fail "image $digest has no dist/smoke.js, so the smoke test cannot run in Azure. Use an image built by CI."
  local lacking=""
  grep -qx 'app/dist/migrate.js' "$work/files" ||
    lacking="$lacking\n  - dist/migrate.js, the database migrations (tm8 task 01a188d1-e074, \"Build the API and database\")"
  grep -q '^app/dist/auth/' "$work/files" ||
    lacking="$lacking\n  - dist/auth/, Microsoft Entra sign-in (tm8 task 01a188d2-4f58, \"Add Microsoft Entra sign-in and roles\")"
  [ -z "$lacking" ] || fail "image $digest (commit ${commit:0:7}) cannot go to Azure yet; it lacks:$(printf '%b' "$lacking")
Nothing in Azure was changed. Deploy main's image from after both tasks merge (runbook, section 2.2)."
  say "Image $digest is main's, built from commit ${commit:0:7}, with migrations, Entra sign-in and the smoke test"
}

# Sign-in: assignment required, no client secret, the redirect URI registered (once it is known), a role per group.
check_entra() {
  local sp app uri roles_json assigned role group value missing=""
  sp=$(az ad sp show --id "$LZ_ENTRA_CLIENT_ID" --only-show-errors -o json 2>/dev/null) ||
    fail "tenant $LZ_ENTRA_TENANT_ID has no enterprise application for client ID $LZ_ENTRA_CLIENT_ID. Check ENTRA_CLIENT_ID, or ask the identity team to create it."
  app=$(az ad app show --id "$LZ_ENTRA_CLIENT_ID" --only-show-errors -o json)
  entra_line "$(printf '%s' "$sp" | jq -r .appRoleAssignmentRequired)" true "the enterprise application requires assignment"
  entra_line "$(printf '%s' "$app" | jq -r .signInAudience)" AzureADMyOrg "the app registration is single tenant"
  entra_line "$(printf '%s' "$app" | jq -r '.passwordCredentials | length')" 0 "the app registration has no client secret"
  uri=$(redirect_uri)
  if [ -n "$uri" ]; then
    entra_line "$(printf '%s' "$app" | jq -r --arg uri "$uri" '.web.redirectUris | index($uri) != null')" true "the redirect URI $uri is registered"
  else
    printf 'NOTE Sign-in: the redirect URI is known after the first infrastructure deployment; deploy prints it and waits for it to be registered\n'
  fi
  roles_json=$(printf '%s' "$sp" | jq '[.appRoles[] | {(.value): .id}] | add // {}')
  assigned=$(az rest --only-show-errors -m get -u "https://graph.microsoft.com/v1.0/servicePrincipals/$(printf '%s' "$sp" | jq -r .id)/appRoleAssignedTo" -o json)
  for role in Workspace.Admin:GROUP_WORKSPACE_ADMIN Launch.Manager:GROUP_LAUNCH_MANAGER BrandTeam:GROUP_BRAND_TEAM Supply:GROUP_SUPPLY VM:GROUP_VM Comms:GROUP_COMMS Viewer:GROUP_VIEWER; do
    value=${role%%:*}
    group=$(lz "${role#*:}")
    printf '%s' "$assigned" | jq -e --arg group "$group" --arg role "$(printf '%s' "$roles_json" | jq -r --arg v "$value" '.[$v] // ""')" \
      '.value | any(.principalId == $group and .appRoleId == $role)' >/dev/null || missing="$missing $value"
  done
  entra_line "${missing:- none}" " none" "each app role is assigned to its group (missing:${missing:- none})"
}

entra_line() { check "$1" "$2" "Sign-in: $3"; }

# ---- Report lines ----------------------------------------------------------------------------

failures=0
check() {
  if [ "$1" = "$2" ]; then
    printf 'PASS %s\n' "$3"
  else
    printf 'FAIL %s (found %s, expected %s)\n' "$3" "${1:-nothing}" "$2"
    failures=$((failures + 1))
  fi
}

# ---- Deploy ----------------------------------------------------------------------------------

# Writes the infrastructure parameters and shows what deploying them would change; changes nothing.
what_if_infra() {
  local key_vault lookup signing_key="" state waited=0
  # Cloud Shell closes after 20 idle minutes, but a deployment it started keeps running in Azure.
  state=$(azq deployment group show -g "$LZ_RESOURCE_GROUP" -n "$INFRA_DEPLOYMENT" --query properties.provisioningState 2>/dev/null || true)
  if [ "$state" = Running ] || [ "$state" = Accepted ]; then
    say "An earlier $INFRA_DEPLOYMENT deployment is still running; waiting for it to finish"
    while [ "$state" = Running ] || [ "$state" = Accepted ]; do
      [ "$waited" -lt 3600 ] || fail "$INFRA_DEPLOYMENT is still running after an hour. Look at it in the portal (resource group $LZ_RESOURCE_GROUP, Deployments), then run deploy again."
      sleep 30 && waited=$((waited + 30))
      state=$(azq deployment group show -g "$LZ_RESOURCE_GROUP" -n "$INFRA_DEPLOYMENT" --query properties.provisioningState)
    done
  fi
  # A new signing key only when the secret is really absent: replacing it signs everyone out.
  key_vault=$(azq keyvault list -g "$LZ_RESOURCE_GROUP" --query "[?starts_with(name, 'kv-lt-')].id | [0]") ||
    fail "could not list the key vaults in $LZ_RESOURCE_GROUP; the error above says why. Nothing was changed."
  if [ -z "$key_vault" ]; then
    signing_key=$(head -c 32 /dev/urandom | base64 | tr -d '\n')
  elif ! lookup=$(az resource show --ids "$key_vault/secrets/session-signing-key" --only-show-errors -o none 2>&1); then
    printf '%s' "$lookup" | grep -Eq 'ResourceNotFound|SecretNotFound|was not found' ||
      fail "could not check whether session-signing-key exists in $key_vault: $lookup. Fix access to the vault, then run deploy again; nothing was changed."
    signing_key=$(head -c 32 /dev/urandom | base64 | tr -d '\n')
  fi
  (
    umask 077
    jq -n --arg location "$LOCATION" --arg vnet "$LZ_VNET_ADDRESS_PREFIX" --arg dns "$LZ_DNS_SERVERS" --arg firewall "$LZ_HUB_FIREWALL_IP" \
      --arg postgresZone "$LZ_POSTGRES_DNS_ZONE_ID" --arg blobZone "$LZ_BLOB_DNS_ZONE_ID" --arg kvZone "$LZ_KEYVAULT_DNS_ZONE_ID" --arg acrZone "$LZ_REGISTRY_DNS_ZONE_ID" \
      --arg postgresNetworking "$LZ_POSTGRES_NETWORKING" --arg registry "$LZ_REGISTRY" --arg tenant "$LZ_ENTRA_TENANT_ID" \
      --arg credential "$LZ_ENTRA_CREDENTIAL" --arg key "$signing_key" '{
        location: {value: $location}, vnetAddressPrefix: {value: $vnet},
        dnsServers: {value: (if $dns == "azure" then [] else ($dns | split(",")) end)},
        hubFirewallIp: {value: $firewall},
        privateDnsZoneIds: {value: {postgres: $postgresZone, blob: $blobZone, keyVault: $kvZone, registry: $acrZone}},
        postgresNetworking: {value: $postgresNetworking},
        existingRegistryId: {value: (if $registry == "create" then "" else $registry end)},
        tenantId: {value: $tenant}, entraCredential: {value: $credential}, sessionSigningKey: {value: $key}
      }' >"$work/infra.json"
  )
  say "What the infrastructure deployment would change"
  az deployment group what-if -g "$LZ_RESOURCE_GROUP" -n "$INFRA_DEPLOYMENT" -f "$HERE/main.bicep" -p "@$work/infra.json" --only-show-errors ||
    fail "Azure could not work out the infrastructure changes; the error above says which value or right is wrong. Nothing was changed."
}

deploy_infra() {
  local params=$work/infra.json
  confirm "Apply these changes to $LZ_RESOURCE_GROUP?"
  say "Deploying the infrastructure (the first run takes about 20 minutes)"
  az deployment group create -g "$LZ_RESOURCE_GROUP" -n "$INFRA_DEPLOYMENT" -f "$HERE/main.bicep" -p "@$params" --only-show-errors -o none ||
    fail "the infrastructure deployment failed; the error above names the resource. Fix it and run deploy again: finished resources are kept."
  rm -f "$params"

  local server pending
  server=$(infra postgresName)
  pending=$(azq postgres flexible-server parameter show -g "$LZ_RESOURCE_GROUP" -s "$server" -n shared_preload_libraries --query isConfigPendingRestart)
  if [ "$pending" = true ]; then
    say "Restarting PostgreSQL to load pgaudit"
    az postgres flexible-server restart -g "$LZ_RESOURCE_GROUP" -n "$server" --only-show-errors -o none
  fi
}

# The app cannot sign anyone in until its redirect URI, known only now, is on the app registration.
check_redirect_uri() {
  local uri
  uri=$(redirect_uri)
  [ -n "$uri" ] || fail "the infrastructure is deployed, but $INFRA_DEPLOYMENT has no environmentDomain output, so the sign-in address is unknown. Look at the deployment in the portal (resource group $LZ_RESOURCE_GROUP, Deployments), then run deploy again."
  az ad app show --id "$LZ_ENTRA_CLIENT_ID" --only-show-errors -o json | jq -e --arg uri "$uri" '.web.redirectUris | index($uri) != null' >/dev/null ||
    fail "the infrastructure is deployed, and the app's sign-in address is now known. Add $uri as a Web redirect URI on app registration $LZ_ENTRA_CLIENT_ID (or ask the identity team to), then run deploy again; what is deployed is kept."
}

confirm() {
  [ "$assume_yes" = 1 ] && return 0
  local answer
  read -r -p "$1 Type yes to continue: " answer
  [ "$answer" = yes ] || fail "nothing more was changed, because the answer was not yes."
}

deploy_app() {
  local registry live previous suffix revision params execution
  registry=$(infra registryName)
  say "Importing $digest into registry $registry"
  az acr import -n "$registry" --source "$image" --image "launch-tracker:sha-$commit" --force --only-show-errors ||
    fail "the image could not be imported into $registry; the error above says why. Nothing else was changed."

  params=$(jq -n --arg location "$LOCATION" --arg image "$(registry_image "$digest")" --arg server "$(infra registryLoginServer)" \
    --arg environment "$(infra environmentName)" --arg host "$(infra postgresHost)" '{
      location: {value: $location}, image: {value: $image}, registryLoginServer: {value: $server},
      environmentName: {value: $environment}, postgresHost: {value: $host}}')
  printf '%s' "$params" >"$work/jobs.json"
  say "Updating the migrate and smoke-test jobs to this image"
  az deployment group create -g "$LZ_RESOURCE_GROUP" -n lt-jobs -f "$HERE/jobs.bicep" -p "@$work/jobs.json" --only-show-errors -o none ||
    fail "the jobs could not be updated; the error above says why. The app was not changed."

  say "Preparing the database (migrate job)"
  execution=$(start_job "$MIGRATE_JOB")
  if ! wait_job "$MIGRATE_JOB" "$execution" 900; then
    print_job_log "$execution"
    fail "the database migration failed; its output is above. The app was not changed and still serves the previous revision."
  fi
  print_job_log "$execution"

  live=$(live_revision)
  previous=$(previous_revision)
  suffix="c${commit:0:7}-$(date -u +%m%d%H%M)"
  revision="$APP--$suffix"
  jq -n --arg location "$LOCATION" --arg image "$(registry_image "$digest")" --arg digest "$digest" --arg suffix "$suffix" --arg live "$live" --arg previous "$previous" \
    --arg server "$(infra registryLoginServer)" --arg environment "$(infra environmentName)" --arg host "$(infra postgresHost)" \
    --arg blob "$(infra storageBlobUrl)" --arg vault "$(infra keyVaultUri)" --arg tenant "$LZ_ENTRA_TENANT_ID" \
    --arg client "$LZ_ENTRA_CLIENT_ID" --arg origin "$(public_origin)" '{
      location: {value: $location}, image: {value: $image}, imageDigest: {value: $digest},
      revisionSuffix: {value: $suffix}, liveRevision: {value: $live}, previousRevision: {value: $previous}, registryLoginServer: {value: $server},
      environmentName: {value: $environment}, postgresHost: {value: $host}, storageBlobUrl: {value: $blob},
      keyVaultUri: {value: $vault}, tenantId: {value: $tenant}, entraClientId: {value: $client}, publicOrigin: {value: $origin}}' >"$work/app.json"
  if [ -n "$live" ]; then
    say "Starting revision $revision with no traffic ($live keeps serving)"
  else
    say "Starting revision $revision, the first; it serves as soon as it is healthy"
  fi
  az deployment group create -g "$LZ_RESOURCE_GROUP" -n lt-app -f "$HERE/app.bicep" -p "@$work/app.json" --only-show-errors -o none ||
    fail "the new revision could not be created; the error above says why.${live:+ $live still serves.}"
  wait_revision "$revision" || {
    deactivate "$revision"
    fail "revision $revision did not become healthy within 5 minutes and is deactivated.${live:+ $live still serves.} $(app_log_hint "$revision" start)"
  }

  if ! smoke_revision "$revision" "$digest" "$commit"; then
    deactivate "$revision"
    fail "the smoke test failed; the lines marked FAIL above say what. Revision $revision is deactivated.${live:+ $live still serves.}"
  fi
  switch_traffic "$revision" "$live" record
}

wait_revision() {
  local waited=0 state
  while [ "$waited" -lt 300 ]; do
    state=$(azq containerapp revision show -n "$APP" -g "$LZ_RESOURCE_GROUP" --revision "$1" --query "join('/', [properties.runningState, properties.healthState])" 2>/dev/null || true)
    case "$state" in Running*/Healthy) return 0 ;; Failed* | */Unhealthy) [ "$waited" -ge 120 ] && return 1 ;; esac
    sleep 10 && waited=$((waited + 10))
  done
  return 1
}

deactivate() { az containerapp revision deactivate -n "$APP" -g "$LZ_RESOURCE_GROUP" --revision "$1" --only-show-errors -o none || true; }

# Moves all traffic to a revision and deactivates the old one; with record, tags the old one as previous.
switch_traffic() {
  local new=$1 old=$2 record=${3:-}
  az containerapp ingress traffic set -n "$APP" -g "$LZ_RESOURCE_GROUP" --revision-weight "$new=100" latest=0 --only-show-errors -o none ||
    fail "traffic could not be moved to $new; the error above says why.${old:+ $old still serves.}"
  if [ -n "$old" ] && [ "$old" != "$new" ]; then
    if [ "$record" = record ]; then
      az tag update --resource-id "$(azq containerapp show -n "$APP" -g "$LZ_RESOURCE_GROUP" --query id)" --operation Merge \
        --tags "lt-previous-revision=$old" --only-show-errors -o none ||
        printf 'Could not record %s as the revision to roll back to; rollback then needs --to %s.\n' "$old" "$old" >&2
    fi
    deactivate "$old"
    say "$new now serves all traffic; $old is deactivated and kept for rollback"
  else
    say "$new now serves all traffic"
  fi
}

# ---- Controls report -------------------------------------------------------------------------

report() {
  local rg=$LZ_RESOURCE_GROUP live app_json live_json env_json value principal expected actual
  live=$(live_revision)
  [ -n "$live" ] || fail "no revision of $APP serves traffic yet. Run deploy first."
  printf '\nControls report for %s in %s (architecture doc, section 7)\n\n' "$APP" "$rg"
  app_json=$(az containerapp show -n "$APP" -g "$rg" --only-show-errors -o json)
  live_json=$(az containerapp revision show -n "$APP" -g "$rg" --revision "$live" --only-show-errors -o json)
  env_json=$(az containerapp env show -n "$(infra environmentName)" -g "$rg" --only-show-errors -o json)

  # Sign-in
  check "$(printf '%s' "$live_json" | jq -r '.properties.template.containers[0].env[] | select(.name == "AUTH_MODE") | .value')" entra "Sign-in: the live revision runs with AUTH_MODE=entra"
  check_entra
  check "$(printf '%s' "$live_json" | jq -r '.properties.template.containers[0].env[] | select(.name == "PUBLIC_ORIGIN") | .value')" "$(public_origin)" \
    "Sign-in: the live revision's PUBLIC_ORIGIN is the app's own address"
  if [ "$LZ_ENTRA_CREDENTIAL" = managed-identity ]; then
    principal=$(azq identity show -g "$rg" -n id-lt-app --query principalId)
    check "$(az ad app federated-credential list --id "$LZ_ENTRA_CLIENT_ID" --only-show-errors -o json | jq -r --arg s "$principal" --arg i "https://login.microsoftonline.com/$LZ_ENTRA_TENANT_ID/v2.0" 'any(.[]; .subject == $s and .issuer == $i)')" true \
      "Sign-in: the app registration trusts id-lt-app as its federated credential (option A)"
  fi
  probe "$(printf '%s' "$app_json" | jq -r '.properties.configuration.ingress.fqdn')" "$(printf '%s' "$live_json" | jq -r '.properties.template.containers[0].image | split("@")[1]')"

  # Roles: exactly these, on exactly these resources
  local registry_id kv_id storage_id
  registry_id=$( [ "$LZ_REGISTRY" = create ] && azq acr show -g "$rg" -n "$(infra registryName)" --query id || printf '%s' "$LZ_REGISTRY")
  kv_id=$(azq keyvault show -n "$(infra keyVaultName)" --query id)
  storage_id=$(azq storage account show -n "$(infra storageName)" --query id)
  expected="AcrPull $registry_id
Key Vault Secrets User $kv_id
Storage Blob Data Contributor $storage_id"
  [ "$LZ_ENTRA_CREDENTIAL" = certificate ] && expected="$expected
Key Vault Crypto User $kv_id"
  for identity in id-lt-app id-lt-migrate id-lt-smoke; do
    principal=$(azq identity show -g "$rg" -n "$identity" --query principalId)
    actual=$(azq role assignment list --assignee "$principal" --all --query "[].join(' ', [roleDefinitionName, scope])" | sort)
    [ "$identity" = id-lt-app ] && value=$(printf '%s\n' "$expected" | sort) || value="AcrPull $registry_id"
    check "$(printf '%s' "$actual" | tr '\n' ';')" "$(printf '%s' "$value" | tr '\n' ';')" "Roles: $identity has only its own roles"
  done

  # Secrets
  check "$(printf '%s' "$app_json" | jq '[.properties.configuration.secrets[]? | select(.keyVaultUrl == null)] | length')" 0 "Secrets: the app's secrets are all Key Vault references"

  # Storage
  value=$(az storage account show -n "$(infra storageName)" --only-show-errors -o json | jq -r '[.allowSharedKeyAccess, .allowBlobPublicAccess, .minimumTlsVersion, .enableHttpsTrafficOnly, .publicNetworkAccess] | join(" ")')
  check "$value" "false false TLS1_2 true Disabled" "Storage: no shared key, no public blobs, TLS 1.2, HTTPS only, no public network"
  value=$(az storage account blob-service-properties show -n "$(infra storageName)" -g "$rg" --only-show-errors -o json | jq -r '[.deleteRetentionPolicy.days, .containerDeleteRetentionPolicy.days, (.isVersioningEnabled // false)] | join(" ")')
  check "$value" "14 14 false" "Storage: deleted blobs and containers kept 14 days, no versioning"
  value=$(azq storage container-rm list --storage-account "$(infra storageName)" -g "$rg" --query "sort([].name) | join(' ', @)")
  check "$value" "attachments imports" "Storage: containers attachments and imports, and no others"
  value=$(az storage account management-policy show --account-name "$(infra storageName)" -g "$rg" --only-show-errors -o json | jq -r '.policy.rules[] | select(.definition.filters.prefixMatch == ["imports/"]) | .definition.actions.baseBlob.delete.daysAfterModificationGreaterThan')
  check "$value" 30 "Storage: imports are deleted after 30 days"

  # Container registry
  if [ "$LZ_REGISTRY" = create ]; then
    value=$(az acr show -g "$rg" -n "$(infra registryName)" --only-show-errors -o json | jq -r '[.adminUserEnabled, .anonymousPullEnabled, .publicNetworkAccess] | join(" ")')
    check "$value" "false false Disabled" "Registry: no admin user, no anonymous pull, no public network"
  else
    value=$(az acr show --ids "$LZ_REGISTRY" --only-show-errors -o json | jq -r '[.adminUserEnabled, .anonymousPullEnabled] | join(" ")')
    check "$value" "false false" "Registry (the landing zone's): no admin user, no anonymous pull"
  fi

  # PostgreSQL
  local server
  server=$(infra postgresName)
  value=$(az postgres flexible-server show -g "$rg" -n "$server" --only-show-errors -o json | jq -r '[.authConfig.passwordAuth, .authConfig.activeDirectoryAuth, .network.publicNetworkAccess, (.backup.backupRetentionDays >= 7)] | join(" ")')
  check "$value" "Disabled Enabled Disabled true" "PostgreSQL: Entra sign-in only, no public network, backups kept 7 days or more"
  for setting in require_secure_transport=on ssl_min_protocol_version=TLSv1.2 shared_preload_libraries=pgaudit pgaudit.log=DDL,ROLE; do
    check "$(azq postgres flexible-server parameter show -g "$rg" -s "$server" -n "${setting%%=*}" --query value)" "${setting#*=}" "PostgreSQL: ${setting%%=*} is ${setting#*=}"
  done

  # Key Vault
  value=$(az keyvault show -n "$(infra keyVaultName)" --only-show-errors -o json | jq -r '[.properties.enableRbacAuthorization, .properties.publicNetworkAccess, .properties.enablePurgeProtection] | join(" ")')
  check "$value" "true Disabled true" "Key Vault: RBAC only, no public network, purge protection"

  # Network
  check "$(printf '%s' "$env_json" | jq -r .properties.vnetConfiguration.internal)" true "Network: the Container Apps environment is internal"
  value=$(azq network private-endpoint list -g "$rg" --query "[].privateLinkServiceConnections[0].privateLinkServiceConnectionState.status" | sort -u | tr '\n' ' ')
  check "$value" "Approved " "Network: every private endpoint is approved"
  value=$(azq network route-table route list -g "$rg" --route-table-name "$(infra routeTableName)" --query "[?addressPrefix=='0.0.0.0/0'].join(' ', [nextHopType, nextHopIpAddress]) | [0]")
  check "$value" "VirtualAppliance $LZ_HUB_FIREWALL_IP" "Network: all egress from snet-cae goes to the hub firewall"
  value=$(azq network vnet peering list -g "$rg" --vnet-name "$(infra vnetName)" --query "[?peeringState=='Connected'] | length(@)")
  check "$([ "${value:-0}" -ge 1 ] && echo connected || echo none)" connected "Network: $(infra vnetName) is peered to the hub (the platform team sets this up)"

  # Image
  value=$(printf '%s' "$live_json" | jq -r '.properties.template.containers[0].image')
  check "$(printf '%s' "$value" | grep -Ec '@sha256:[0-9a-f]{64}$' || true)" 1 "Image: the live revision runs by digest, ${value##*@}"

  # Logs
  diagnostics "$kv_id" AuditEvent "Key Vault"
  [ "$LZ_REGISTRY" = create ] && diagnostics "$registry_id" "ContainerRegistryLoginEvents ContainerRegistryRepositoryEvents" "Registry"
  diagnostics "$storage_id/blobServices/default" "StorageDelete StorageRead StorageWrite" "Blob storage"
  diagnostics "$(azq postgres flexible-server show -g "$rg" -n "$server" --query id)" PostgreSQLLogs "PostgreSQL"
  diagnostics "$(printf '%s' "$env_json" | jq -r .id)" "ContainerAppConsoleLogs ContainerAppSystemLogs" "Container Apps"

  # POC exceptions, accepted under POC_EXCEPTIONS_ACCEPTED
  printf '\nPOC exceptions (accepted: %s):\n' "$LZ_POC_EXCEPTIONS_ACCEPTED"
  printf '  app replicas: min %s, max %s\n' "$(printf '%s' "$app_json" | jq -r .properties.template.scale.minReplicas)" "$(printf '%s' "$app_json" | jq -r .properties.template.scale.maxReplicas)"
  printf '  environment zone redundant: %s\n' "$(printf '%s' "$env_json" | jq -r .properties.zoneRedundant)"
  printf '  storage: %s\n' "$(azq storage account show -n "$(infra storageName)" --query sku.name)"
  printf '  PostgreSQL high availability: %s\n' "$(azq postgres flexible-server show -g "$rg" -n "$server" --query highAvailability.mode)"
  printf '\nThe hub firewall allow-list is the platform team'"'"'s; firewall-allow-list.md is the request. The probe above shows Entra is let through and an unlisted site is not.\n'

  if [ "$failures" -gt 0 ]; then
    printf '\nControls report: %s check(s) failed. Each FAIL line says what was found.\n' "$failures"
    return 1
  fi
  printf '\nControls report: every check passed. Live revision %s.\n' "$live"
}

diagnostics() {
  local found
  found=$(az monitor diagnostic-settings list --resource "$1" --only-show-errors -o json |
    jq -r --arg ws "$(azq monitor log-analytics workspace show -g "$LZ_RESOURCE_GROUP" -n "$(infra workspaceName)" --query id)" \
      '[.[] | select((.workspaceId | ascii_downcase) == ($ws | ascii_downcase)) | .logs[] | select(.enabled) | .category] | unique | join(" ")')
  check "$found" "$2" "Logs: $3 sends $2 to $(infra workspaceName)"
}

probe() {
  local body execution
  body=$(jq -n --arg image "$(registry_image "$2")" \
    --arg script "$(cat "$HERE/probe.mjs")" --arg url "https://$1" --arg tenant "$LZ_ENTRA_TENANT_ID" '{
      containers: [{ name: "smoke", image: $image,
        args: ["--input-type=module", "-e", $script, $url, $tenant], resources: { cpu: 0.25, memory: "0.5Gi" } }]}')
  execution=$(start_job "$SMOKE_JOB" "$body")
  if wait_job "$SMOKE_JOB" "$execution" 180; then
    printf 'PASS Sign-in and egress probe from inside the environment:\n'
  else
    printf 'FAIL Sign-in and egress probe from inside the environment:\n'
    failures=$((failures + 1))
  fi
  print_job_log "$execution"
}

# ---- Rollback --------------------------------------------------------------------------------

rollback() {
  local live revision_digest
  live=$(live_revision)
  [ -n "$live" ] || fail "no revision of $APP serves traffic, so there is nothing to roll back from. Run deploy."
  if [ -z "$target" ]; then
    target=$(previous_revision)
    { [ -n "$target" ] && [ "$target" != "$live" ]; } ||
      fail "there is no recorded revision before $live to go back to. Pick one with --to; list them with: az containerapp revision list -n $APP -g $LZ_RESOURCE_GROUP --all -o table"
  fi
  revision_digest=$(azq containerapp revision show -n "$APP" -g "$LZ_RESOURCE_GROUP" --revision "$target" --query "properties.template.containers[0].image" | sed -n 's/.*@//p') ||
    fail "$APP has no revision $target. List them with: az containerapp revision list -n $APP -g $LZ_RESOURCE_GROUP --all -o table"
  confirm "Serve $target (image $revision_digest) instead of $live? The database stays as $live's migrations left it."
  say "Activating $target"
  az containerapp revision activate -n "$APP" -g "$LZ_RESOURCE_GROUP" --revision "$target" --only-show-errors -o none
  wait_revision "$target" || fail "$target did not become healthy within 5 minutes; $live still serves. $(app_log_hint "$target" start)"
  smoke_revision "$target" "$revision_digest" || {
    deactivate "$target"
    fail "the smoke test of $target failed; $live still serves."
  }
  switch_traffic "$target" "$live"
}

# ---- Main ------------------------------------------------------------------------------------

check_tools
read_values
check_account
# Everything read-only runs first, so the landing-zone values can be tested before an image is ready;
# the image is refused before the first write to Azure.
case "$command" in
  preflight | deploy)
    printf '\nThe Entra app registration:\n'
    check_entra
    what_if_infra
    [ "$failures" = 0 ] || fail "the Entra app registration is not ready; each FAIL line above says what the identity team must change."
    check_image
    if [ "$command" = preflight ]; then
      printf '\nPreflight passed: run deploy with the same --image.\n'
    else
      deploy_infra
      check_redirect_uri
      deploy_app
      report
    fi
    ;;
  report) report ;;
  rollback) rollback ;;
esac
