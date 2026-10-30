// AcrPull on an existing registry the landing zone provides, which may sit in another resource group.
param registryName string
param principalIds array

resource registry 'Microsoft.ContainerRegistry/registries@2025-04-01' existing = {
  name: registryName
}

var acrPull = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')

resource pull 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in principalIds: {
    scope: registry
    name: guid(registry.id, principalId, acrPull)
    properties: { roleDefinitionId: acrPull, principalId: principalId, principalType: 'ServicePrincipal' }
  }
]
