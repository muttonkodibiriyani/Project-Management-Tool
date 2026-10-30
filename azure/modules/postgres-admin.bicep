// The migrate job's identity as the server's Entra administrator, so the migrate job owns the schema
// and creates the app's database role. A module, because the name is the identity's object ID.
param serverName string
param principalId string
param principalName string
param tenantId string

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' existing = {
  name: serverName
}

resource admin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2025-08-01' = {
  parent: server
  name: principalId
  properties: { principalType: 'ServicePrincipal', principalName: principalName, tenantId: tenantId }
}
