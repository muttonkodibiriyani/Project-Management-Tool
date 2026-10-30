// One private endpoint in snet-pe, approved automatically because it is in the same tenant, with its
// A record written to the landing zone's private DNS zone.
param name string
param location string
param subnetId string
param serviceId string
param groupId string
param privateDnsZoneId string

resource endpoint 'Microsoft.Network/privateEndpoints@2025-05-01' = {
  name: name
  location: location
  properties: {
    subnet: { id: subnetId }
    privateLinkServiceConnections: [
      {
        name: name
        properties: { privateLinkServiceId: serviceId, groupIds: [groupId] }
      }
    ]
  }
}

resource dnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2025-05-01' = {
  parent: endpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [{ name: groupId, properties: { privateDnsZoneId: privateDnsZoneId } }]
  }
}
