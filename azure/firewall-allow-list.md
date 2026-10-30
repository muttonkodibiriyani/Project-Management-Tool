# Hub firewall allow-list request: Launch Tracker (snet-cae egress)

To: the platform team. From: the Launch Tracker POC (Tarkesh).

## What we are asking for

Launch Tracker runs in an internal Container Apps environment (workload profiles, Consumption profile)
in the spoke subnet `snet-cae` (<landing-zone: snet-cae address range>), in UAE North. `azure/main.bicep` puts a route
table on that subnet with one route, `0.0.0.0/0 → VirtualAppliance <landing-zone: hub firewall private IP>`, so
everything the environment sends outside the spoke goes through the hub firewall.

Please allow outbound HTTPS (TCP 443) from `snet-cae` to the destinations below, and nothing else. Every row
says why it is needed and which Microsoft Learn page says so.

### Application rules (FQDN, HTTPS 443)

| FQDN | Why | Source |
|---|---|---|
| `login.microsoftonline.com` | Entra sign-in. The server does the OpenID Connect code flow itself: it reads the discovery document, redeems the code at the token endpoint and fetches the signing keys, all under `https://login.microsoftonline.com/`, followed by the company tenant ID and `/v2.0`. The managed identities (`id-lt-app`, `id-lt-migrate`) also get their tokens here, for PostgreSQL, Blob, Key Vault and, with option A, the federated client assertion. | [OIDC on the Microsoft identity platform](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc) (endpoint table: discovery, token and JWKS are all under `login.microsoftonline.com/{tenant}/v2.0`); [Use Azure Firewall with Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/use-azure-firewall) (managed identity row) |
| `*.login.microsoftonline.com` | Managed identity, as Container Apps documents it. | [Use Azure Firewall with Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/use-azure-firewall) (managed identity row) |
| `login.microsoft.com`, `*.login.microsoft.com` | Managed identity, and registry pull with a managed identity (the app pulls its image with `id-lt-app`'s AcrPull role). | [Use Azure Firewall with Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/use-azure-firewall) (managed identity and Azure Container Registry rows) |
| `*.identity.azure.net` | The Container Apps managed identity endpoint. | [Use Azure Firewall with Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/use-azure-firewall) (managed identity row) |
| `mcr.microsoft.com`, `*.data.mcr.microsoft.com` | The environment pulls its own system containers from Microsoft Artifact Registry. Required in every scenario. | [Use Azure Firewall with Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/use-azure-firewall) ("All scenarios"); [Control outbound traffic with user-defined routes](https://learn.microsoft.com/en-us/azure/container-apps/user-defined-routes) |
| `packages.aks.azure.com`, `acs-mirror.azureedge.net` | The underlying AKS cluster downloads its Kubernetes and Azure CNI binaries from these. Required in every scenario. | [Use Azure Firewall with Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/use-azure-firewall) ("All scenarios") |

### Network rule (service tag, TCP 443)

| Service tag | Why | Source |
|---|---|---|
| `AzureMonitor` | The environment's logs go to Azure Monitor (`appLogsConfiguration.destination = azure-monitor`), and a diagnostic setting sends `ContainerAppConsoleLogs` and `ContainerAppSystemLogs` to the `log-lt` workspace. Container Apps documents this tag as required when the environment uses Azure Monitor; there is no FQDN equivalent on that page. | [Securing a virtual network in Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/firewall-integration) (workload profile outbound table, `AzureMonitor` row); [Log storage and monitoring options](https://learn.microsoft.com/en-us/azure/container-apps/log-options) |

If the hub firewall policy prefers service tags to FQDNs, Microsoft lists the equivalents: `AzureActiveDirectory` for
the Entra and managed identity rows, and `MicrosoftContainerRegistry` plus `AzureFrontDoor.FirstParty` for the
Artifact Registry row ([Use Azure Firewall with Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/use-azure-firewall), network rules). The page says
to use one form or the other for each scenario, not both. The AKS binaries row has no service tag on that page, so it
stays an application rule either way.

## What needs no firewall rule

PostgreSQL, Blob storage, Key Vault and the container registry all have `publicNetworkAccess` disabled and are
reached only through private endpoints in `snet-pe`, in the same spoke VNet. Their names resolve to private
addresses through the landing zone's private DNS zones (`privatelink.postgres.database.azure.com`,
`privatelink.blob.core.windows.net`, `privatelink.vaultcore.azure.net`, `privatelink.azurecr.io`), and traffic to
addresses inside the VNet takes the more specific virtual network route, not the `0.0.0.0/0` route to the firewall
([Virtual network traffic routing](https://learn.microsoft.com/en-us/azure/virtual-network/virtual-networks-udr-overview)).

For the registry, this includes its data endpoint: a private endpoint on a Premium registry automatically enables
the registry's dedicated data endpoint in `uaenorth.data.azurecr.io` and gives it a private address too
([Private endpoint for Azure Container Registry](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-private-link)). So the registry rows on the
Container Apps firewall page (the registry's own `azurecr.io` name and `*.blob.core.windows.net`) are not needed here.

## Deliberately not requested

- **No font hosts.** Not `fonts.googleapis.com`, not `fonts.gstatic.com`. The server never fetches fonts. Fonts
  are loaded by users' browsers, which reach the internet through the company network, not through `snet-cae`.
  The design decision is to self-host gr8r's fonts in the image (design section 7, question Q5), so that no font
  host is needed anywhere.
- **No Microsoft Graph** (`graph.microsoft.com`). Roles come from app roles in the ID token, so the server never
  calls Graph.
- **No package registries or Docker Hub** (npm, `registry-1.docker.io` and so on). The image is built in GitHub
  Actions and imported into the private registry by digest; nothing is downloaded at run time.
- **No Application Insights ingestion yet.** The current image does not send telemetry, and `main.bicep` creates no
  Application Insights resource. When it does, the request will add `uaenorth.in.applicationinsights.azure.com`
  and `uaenorth.livediagnostics.monitor.azure.com`, the regional endpoints Microsoft lists for telemetry and Live
  Metrics ([Azure Monitor endpoint access and firewall configuration](https://learn.microsoft.com/en-us/azure/azure-monitor/fundamentals/azure-monitor-network-access)).
- **No `login.windows.net`.** The design listed it, but nothing in the app or the Container Apps platform
  documentation calls it: the OIDC flow and managed identity both use `login.microsoftonline.com`.
- **No `azurecontainerapps.dev`.** It serves the portal's log stream and console to the administrator's browser,
  not traffic from `snet-cae` ([Networking in Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/networking), portal dependencies).

## How we check it after each deploy

`azure/deploy.sh` runs a probe (`azure/probe.mjs`) as a Container Apps job inside the environment, so it leaves
through the same route table and firewall as the app. The report shows PASS or FAIL for each:

- **Entra passes.** It fetches the tenant's OpenID configuration document from `login.microsoftonline.com`
  (`/v2.0/.well-known/openid-configuration` under the tenant ID) and expects a success status. A failure means `login.microsoftonline.com` is not yet allowed.
- **fonts.googleapis.com is blocked.** It requests `https://fonts.googleapis.com/` and expects the connection to
  fail. A response means the firewall is letting through a host that is not on this list.
- It also checks that an unauthenticated `/auth/login` answers with a 302 to `login.microsoftonline.com`, under the company tenant ID.

The same report checks that `snet-cae`'s route table sends `0.0.0.0/0` to <landing-zone: hub firewall private IP>.
