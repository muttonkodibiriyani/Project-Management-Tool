// The app: one revision per deploy, by digest, in multiple-revision mode so the previous revision
// can be re-activated. A new revision starts with no traffic while another serves; deploy.sh moves
// traffic to it only after the smoke test passes. The first revision serves as soon as it is healthy.
@allowed(['uaenorth'])
param location string

@description('The image in the registry, by digest: <login server>/launch-tracker@sha256:<64 hex>.')
param image string

@description('The digest alone, which the app reports and the smoke test checks.')
param imageDigest string

@description('The new revision\'s suffix.')
param revisionSuffix string

@description('The revision that keeps all traffic until the smoke test passes. Empty on the first deploy.')
param liveRevision string

@description('The revision rollback goes back to, kept as the app\'s lt-previous-revision tag. Empty until the second deploy.')
param previousRevision string

param registryLoginServer string
param environmentName string
param postgresHost string
param storageBlobUrl string
param keyVaultUri string
param tenantId string
param entraClientId string
@description('The https address people open the app at; Entra redirects back to <publicOrigin>/auth/callback.')
param publicOrigin string

var firstTraffic = [{ latestRevision: true, weight: 100 }]
var nextTraffic = [{ revisionName: liveRevision, weight: 100 }, { latestRevision: true, weight: 0 }]
var traffic = empty(liveRevision) ? firstTraffic : nextTraffic

resource environment 'Microsoft.App/managedEnvironments@2025-07-01' existing = {
  name: environmentName
}

resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = {
  name: 'id-lt-app'
}

resource app 'Microsoft.App/containerApps@2025-07-01' = {
  name: 'ca-launch-tracker'
  location: location
  tags: empty(previousRevision) ? {} : { 'lt-previous-revision': previousRevision }
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${appIdentity.id}': {} } }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Multiple'
      ingress: {
        // The environment is internal, so this reaches the VNet and peered networks, not the internet.
        external: true
        targetPort: 8080
        transport: 'http'
        allowInsecure: false
        traffic: traffic
      }
      registries: [{ server: registryLoginServer, identity: appIdentity.id }]
      secrets: [
        {
          name: 'session-signing-key'
          keyVaultUrl: '${keyVaultUri}secrets/session-signing-key'
          identity: appIdentity.id
        }
      ]
    }
    template: {
      revisionSuffix: revisionSuffix
      scale: { minReplicas: 1, maxReplicas: 1 }
      containers: [
        {
          name: 'launch-tracker'
          image: image
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'IMAGE_DIGEST', value: imageDigest }
            { name: 'NODE_ENV', value: 'production' }
            { name: 'AUTH_MODE', value: 'entra' }
            { name: 'ENTRA_TENANT_ID', value: tenantId }
            { name: 'ENTRA_CLIENT_ID', value: entraClientId }
            { name: 'PUBLIC_ORIGIN', value: publicOrigin }
            { name: 'SESSION_SIGNING_KEY', secretRef: 'session-signing-key' }
            { name: 'PGHOST', value: postgresHost }
            { name: 'PGDATABASE', value: 'launch_tracker' }
            { name: 'PGUSER', value: appIdentity.name }
            { name: 'AZURE_CLIENT_ID', value: appIdentity.properties.clientId }
            { name: 'BLOB_ACCOUNT_URL', value: storageBlobUrl }
            { name: 'BLOB_CONTAINER', value: 'attachments' }
          ]
          probes: [
            { type: 'Liveness', httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 30 }
            { type: 'Readiness', httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 10 }
          ]
        }
      ]
    }
  }
}

output fqdn string = app.properties.configuration.ingress.fqdn
output latestRevision string = app.properties.latestRevisionName
