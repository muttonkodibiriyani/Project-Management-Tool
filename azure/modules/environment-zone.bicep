// The environment's own private zone, so the app's internal FQDN resolves inside the spoke. The
// platform team links it to the hub resolver for users on the company network. A module, because
// the zone is named after the environment's generated domain.
param domain string
param staticIp string
param vnetId string

resource zone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: domain
  location: 'global'
}

resource wildcard 'Microsoft.Network/privateDnsZones/A@2024-06-01' = {
  parent: zone
  name: '*'
  properties: { ttl: 300, aRecords: [{ ipv4Address: staticIp }] }
}

resource link 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: zone
  name: 'vnet-lt'
  location: 'global'
  properties: { virtualNetwork: { id: vnetId }, registrationEnabled: false }
}
