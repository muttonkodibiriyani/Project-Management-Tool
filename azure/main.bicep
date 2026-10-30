// Launch Tracker's Azure resources in UAE North, except the app and its jobs (app.bicep and
// jobs.bicep), which need the image in the registry first. Every landing-zone value is a parameter
// without a default; deploy.sh reads them from landing-zone.env and refuses placeholders.
// Settings follow the architecture doc, sections 2, 6 and 7.
targetScope = 'resourceGroup'

@description('The region. The landing zone fixes it to UAE North.')
@allowed(['uaenorth'])
param location string

@description('The spoke address range from IPAM, /22 or wider: snet-cae takes the first /23, snet-pe the next /27, snet-psql the /28 after it.')
param vnetAddressPrefix string

@description('DNS servers for the spoke VNet: the hub resolver addresses, or empty to use Azure DNS.')
param dnsServers array

@description('The hub firewall\'s private IP, the next hop for all egress from snet-cae.')
param hubFirewallIp string

@description('Resource IDs of the landing zone\'s private DNS zones: an object with postgres, blob, keyVault and registry.')
param privateDnsZoneIds object

@description('private-endpoint, or vnet-integration (a delegated subnet), as the landing zone decides (Q8).')
@allowed(['private-endpoint', 'vnet-integration'])
param postgresNetworking string

@description('Empty to create a private Premium registry here, or the resource ID of the landing zone\'s registry.')
param existingRegistryId string

@description('The Entra tenant that signs users in and administers PostgreSQL.')
param tenantId string

@description('managed-identity (option A, federated credential) or certificate (option B, in Key Vault), as Q3 decides.')
@allowed(['managed-identity', 'certificate'])
param entraCredential string

@description('32 random bytes, base64, passed only on the first deploy to create session-signing-key. Empty keeps the existing secret.')
@secure()
param sessionSigningKey string

var suffix = uniqueString(resourceGroup().id)
var names = {
  vnet: 'vnet-lt'
  routeTable: 'rt-lt-cae'
  workspace: 'log-lt'
  environment: 'cae-lt'
  postgres: 'psql-lt-${suffix}'
  storage: 'stlt${suffix}'
  keyVault: 'kv-lt-${suffix}'
  registry: 'acrlt${suffix}'
}
var createRegistry = empty(existingRegistryId)
var registryParts = split(existingRegistryId, '/')
var postgresInVnet = postgresNetworking == 'vnet-integration'

// Built-in role definition IDs. The vault roles are named vault* because gitleaks reads any ID beside a
// name holding "key" or "secret" as a credential: vaultReadRole is Key Vault Secrets User and
// vaultCryptoRole is Key Vault Crypto User.
var roles = {
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d'
  vaultReadRole: '4633458b-17de-408a-b874-0445c86b69e6'
  vaultCryptoRole: '12338af0-0e69-4776-bea7-57ae8d297424'
  storageBlobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
}

// Identities: the app, the migrate job (PostgreSQL administrator, which owns the schema) and the
// smoke-test job (registry pull only).
resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'id-lt-app'
  location: location
}

resource migrateIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'id-lt-migrate'
  location: location
}

resource smokeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'id-lt-smoke'
  location: location
}

// Network: all egress from the app goes to the hub firewall; the data services are reachable only
// through private endpoints (or, for PostgreSQL, its delegated subnet).
resource routeTable 'Microsoft.Network/routeTables@2025-05-01' = {
  name: names.routeTable
  location: location
  properties: {
    disableBgpRoutePropagation: true
    routes: [
      {
        name: 'all-to-hub-firewall'
        properties: { addressPrefix: '0.0.0.0/0', nextHopType: 'VirtualAppliance', nextHopIpAddress: hubFirewallIp }
      }
    ]
  }
}

var baseSubnets = [
  {
    name: 'snet-cae'
    properties: {
      addressPrefix: cidrSubnet(vnetAddressPrefix, 23, 0)
      routeTable: { id: routeTable.id }
      delegations: [{ name: 'environments', properties: { serviceName: 'Microsoft.App/environments' } }]
    }
  }
  {
    name: 'snet-pe'
    properties: {
      addressPrefix: cidrSubnet(vnetAddressPrefix, 27, 16)
      privateEndpointNetworkPolicies: 'Enabled'
    }
  }
]
var postgresSubnet = {
  name: 'snet-psql'
  properties: {
    addressPrefix: cidrSubnet(vnetAddressPrefix, 28, 34)
    delegations: [{ name: 'flexibleServers', properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' } }]
  }
}
var postgresSubnets = postgresInVnet ? [postgresSubnet] : []

resource vnet 'Microsoft.Network/virtualNetworks@2025-05-01' = {
  name: names.vnet
  location: location
  properties: {
    addressSpace: { addressPrefixes: [vnetAddressPrefix] }
    dhcpOptions: { dnsServers: dnsServers }
    subnets: concat(baseSubnets, postgresSubnets)
  }
}

var caeSubnetId = resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, 'snet-cae')
var peSubnetId = resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, 'snet-pe')

// Logs: one workspace receives every resource's diagnostic settings.
resource workspace 'Microsoft.OperationalInsights/workspaces@2025-07-01' = {
  name: names.workspace
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// PostgreSQL: Entra sign-in only, TLS 1.2 or later, pgaudit for DDL and role changes, 7-day backups.
resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' = {
  name: names.postgres
  location: location
  sku: { name: 'Standard_B2s', tier: 'Burstable' }
  properties: {
    version: '16'
    storage: { storageSizeGB: 32, autoGrow: 'Disabled' }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    authConfig: { activeDirectoryAuth: 'Enabled', passwordAuth: 'Disabled', tenantId: tenantId }
    network: postgresInVnet
      ? {
          delegatedSubnetResourceId: resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, 'snet-psql')
          privateDnsZoneArmResourceId: privateDnsZoneIds.postgres
          publicNetworkAccess: 'Disabled'
        }
      : { publicNetworkAccess: 'Disabled' }
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2025-08-01' = {
  parent: postgres
  name: 'launch_tracker'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

module postgresAdmin 'modules/postgres-admin.bicep' = {
  name: 'psql-admin'
  params: {
    serverName: postgres.name
    principalId: migrateIdentity.properties.principalId
    principalName: migrateIdentity.name
    tenantId: tenantId
  }
  dependsOn: [database]
}

// Server parameters are applied one at a time: PostgreSQL rejects concurrent changes.
// shared_preload_libraries needs a restart, which deploy.sh does when the server reports it pending.
resource secureTransport 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = {
  parent: postgres
  name: 'require_secure_transport'
  properties: { value: 'on', source: 'user-override' }
  dependsOn: [postgresAdmin]
}

resource tlsMinimum 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = {
  parent: postgres
  name: 'ssl_min_protocol_version'
  properties: { value: 'TLSv1.2', source: 'user-override' }
  dependsOn: [secureTransport]
}

resource preload 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = {
  parent: postgres
  name: 'shared_preload_libraries'
  properties: { value: 'pgaudit', source: 'user-override' }
  dependsOn: [tlsMinimum]
}

resource extensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = {
  parent: postgres
  name: 'azure.extensions'
  properties: { value: 'PGAUDIT', source: 'user-override' }
  dependsOn: [preload]
}

resource auditClasses 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = {
  parent: postgres
  name: 'pgaudit.log'
  properties: { value: 'DDL,ROLE', source: 'user-override' }
  dependsOn: [extensions]
}

resource connectionLogs 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = {
  parent: postgres
  name: 'log_connections'
  properties: { value: 'on', source: 'user-override' }
  dependsOn: [auditClasses]
}

// 2021-05-01-preview is the newest version of this type; the linter lists only the older, unscoped 2016-09-01.
#disable-next-line use-recent-api-versions
resource postgresDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: postgres
  name: 'to-log-lt'
  properties: {
    workspaceId: workspace.id
    logs: [{ category: 'PostgreSQLLogs', enabled: true }]
  }
}

// Blob storage: identity access only, no public access; imports expire after 30 days; deleted
// blobs and containers are kept for 14 days; no versioning and no exports container.
resource storage 'Microsoft.Storage/storageAccounts@2025-06-01' = {
  name: names.storage
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_GZRS' }
  properties: {
    accessTier: 'Hot'
    allowSharedKeyAccess: false
    allowBlobPublicAccess: false
    allowCrossTenantReplication: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: 'Disabled'
    networkAcls: { defaultAction: 'Deny', bypass: 'None' }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2025-06-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: { enabled: true, days: 14 }
    containerDeleteRetentionPolicy: { enabled: true, days: 14 }
    isVersioningEnabled: false
  }
}

resource containers 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01' = [
  for container in ['attachments', 'imports']: {
    parent: blobService
    name: container
    properties: { publicAccess: 'None' }
  }
]

resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2025-06-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'delete-imports-after-30-days'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: { blobTypes: ['blockBlob'], prefixMatch: ['imports/'] }
            actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: 30 } } }
          }
        }
      ]
    }
  }
  dependsOn: [containers]
}

// 2021-05-01-preview is the newest version of this type; the linter lists only the older, unscoped 2016-09-01.
#disable-next-line use-recent-api-versions
resource blobDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: blobService
  name: 'to-log-lt'
  properties: {
    workspaceId: workspace.id
    logs: [
      { category: 'StorageRead', enabled: true }
      { category: 'StorageWrite', enabled: true }
      { category: 'StorageDelete', enabled: true }
    ]
  }
}

// Key Vault: RBAC only, purge-protected, holding the session signing key.
resource keyVault 'Microsoft.KeyVault/vaults@2025-05-01' = {
  name: names.keyVault
  location: location
  properties: {
    tenantId: tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Disabled'
    networkAcls: { defaultAction: 'Deny', bypass: 'None' }
  }
}

resource signingKey 'Microsoft.KeyVault/vaults/secrets@2025-05-01' = if (!empty(sessionSigningKey)) {
  parent: keyVault
  name: 'session-signing-key'
  properties: { value: sessionSigningKey, contentType: 'base64, 32 random bytes' }
}

// 2021-05-01-preview is the newest version of this type; the linter lists only the older, unscoped 2016-09-01.
#disable-next-line use-recent-api-versions
resource keyVaultDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: keyVault
  name: 'to-log-lt'
  properties: {
    workspaceId: workspace.id
    logs: [{ category: 'AuditEvent', enabled: true }]
  }
}

// Container registry: private Premium, no admin user, no anonymous pull. Skipped when the landing
// zone provides one.
resource registry 'Microsoft.ContainerRegistry/registries@2025-04-01' = if (createRegistry) {
  name: names.registry
  location: location
  sku: { name: 'Premium' }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
    publicNetworkAccess: 'Disabled'
    networkRuleBypassOptions: 'AzureServices'
    dataEndpointEnabled: false
    zoneRedundancy: 'Enabled'
  }
}

// 2021-05-01-preview is the newest version of this type; the linter lists only the older, unscoped 2016-09-01.
#disable-next-line use-recent-api-versions
resource registryDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (createRegistry) {
  scope: registry
  name: 'to-log-lt'
  properties: {
    workspaceId: workspace.id
    logs: [
      { category: 'ContainerRegistryLoginEvents', enabled: true }
      { category: 'ContainerRegistryRepositoryEvents', enabled: true }
    ]
  }
}

module postgresEndpoint 'modules/private-endpoint.bicep' = if (!postgresInVnet) {
  name: 'pe-psql'
  params: {
    name: 'pe-${names.postgres}'
    location: location
    subnetId: peSubnetId
    serviceId: postgres.id
    groupId: 'postgresqlServer'
    privateDnsZoneId: privateDnsZoneIds.postgres
  }
}

module blobEndpoint 'modules/private-endpoint.bicep' = {
  name: 'pe-blob'
  params: {
    name: 'pe-${names.storage}-blob'
    location: location
    subnetId: peSubnetId
    serviceId: storage.id
    groupId: 'blob'
    privateDnsZoneId: privateDnsZoneIds.blob
  }
}

module keyVaultEndpoint 'modules/private-endpoint.bicep' = {
  name: 'pe-kv'
  params: {
    name: 'pe-${names.keyVault}'
    location: location
    subnetId: peSubnetId
    serviceId: keyVault.id
    groupId: 'vault'
    privateDnsZoneId: privateDnsZoneIds.keyVault
  }
}

module registryEndpoint 'modules/private-endpoint.bicep' = if (createRegistry) {
  name: 'pe-acr'
  params: {
    name: 'pe-${names.registry}'
    location: location
    subnetId: peSubnetId
    serviceId: registry.id
    groupId: 'registry'
    privateDnsZoneId: privateDnsZoneIds.registry
  }
}

// Least-privilege roles, the only ones the controls report accepts: all three identities pull from
// the registry; only the app reads the signing key (and signs with the certificate, option B) and
// uses Blob storage.
module registryPull 'modules/registry-pull.bicep' = {
  name: 'registry-pull'
  scope: resourceGroup(createRegistry ? subscription().subscriptionId : registryParts[2], createRegistry ? resourceGroup().name : registryParts[4])
  params: {
    registryName: createRegistry ? registry.name : last(registryParts)
    principalIds: [appIdentity.properties.principalId, migrateIdentity.properties.principalId, smokeIdentity.properties.principalId]
  }
}

resource appSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, 'id-lt-app', roles.vaultReadRole)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.vaultReadRole)
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource appCrypto 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (entraCredential == 'certificate') {
  scope: keyVault
  name: guid(keyVault.id, 'id-lt-app', roles.vaultCryptoRole)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.vaultCryptoRole)
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource appBlob 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, 'id-lt-app', roles.storageBlobDataContributor)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.storageBlobDataContributor)
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Container Apps environment: internal only, in snet-cae, logs to the workspace.
resource environment 'Microsoft.App/managedEnvironments@2025-07-01' = {
  name: names.environment
  location: location
  properties: {
    vnetConfiguration: { infrastructureSubnetId: caeSubnetId, internal: true }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    zoneRedundant: false
    appLogsConfiguration: { destination: 'azure-monitor' }
  }
}

// 2021-05-01-preview is the newest version of this type; the linter lists only the older, unscoped 2016-09-01.
#disable-next-line use-recent-api-versions
resource environmentDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: environment
  name: 'to-log-lt'
  properties: {
    workspaceId: workspace.id
    logs: [
      { category: 'ContainerAppConsoleLogs', enabled: true }
      { category: 'ContainerAppSystemLogs', enabled: true }
    ]
  }
}

// The environment's own private zone, so the app's internal FQDN resolves inside the spoke. The
// platform team links it to the hub resolver for users on the company network.
module environmentZone 'modules/environment-zone.bicep' = {
  name: 'environment-zone'
  params: {
    domain: environment.properties.defaultDomain
    staticIp: environment.properties.staticIp
    vnetId: vnet.id
  }
}

output environmentName string = environment.name
output environmentDomain string = environment.properties.defaultDomain
output registryName string = createRegistry ? registry.name : last(registryParts)
output registryLoginServer string = createRegistry ? registry!.properties.loginServer : '${last(registryParts)}.azurecr.io'
output postgresName string = postgres.name
output postgresHost string = postgres.properties.fullyQualifiedDomainName
output storageName string = storage.name
output storageBlobUrl string = storage.properties.primaryEndpoints.blob
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
output workspaceName string = workspace.name
output vnetName string = vnet.name
output routeTableName string = routeTable.name
