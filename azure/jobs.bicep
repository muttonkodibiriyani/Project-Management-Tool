// The two jobs that run the CI image before and after each app revision, both by digest:
// caj-lt-migrate sets up the app's database role and applies the schema (deploy.sh waits for it before
// rolling out the app), and caj-lt-smoke runs the smoke test and the sign-in probe inside the
// environment, where the internal ingress is reachable.
@allowed(['uaenorth'])
param location string

@description('The image in the registry, by digest: <login server>/launch-tracker@sha256:<64 hex>.')
param image string

param registryLoginServer string
param environmentName string
param postgresHost string

// No container command: the image is distroless, its only node is its ENTRYPOINT /nodejs/bin/node (not on
// PATH), and a command would replace it. Each job passes only args, as the image's own CMD does.

resource environment 'Microsoft.App/managedEnvironments@2025-07-01' existing = {
  name: environmentName
}

resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = {
  name: 'id-lt-app'
}

resource migrateIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = {
  name: 'id-lt-migrate'
}

resource smokeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = {
  name: 'id-lt-smoke'
}

resource migrate 'Microsoft.App/jobs@2025-07-01' = {
  name: 'caj-lt-migrate'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${migrateIdentity.id}': {} } }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      replicaTimeout: 900
      replicaRetryLimit: 0
      registries: [{ server: registryLoginServer, identity: migrateIdentity.id }]
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: image
          // db-roles.mjs gives the app's identity its database role, then runs dist/migrate.js.
          args: ['--input-type=module', '-e', loadTextContent('db-roles.mjs')]
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'PGHOST', value: postgresHost }
            { name: 'PGDATABASE', value: 'launch_tracker' }
            { name: 'PGUSER', value: migrateIdentity.name }
            { name: 'AZURE_CLIENT_ID', value: migrateIdentity.properties.clientId }
            { name: 'APP_DB_USER', value: appIdentity.name }
            { name: 'APP_DB_USER_OBJECT_ID', value: appIdentity.properties.principalId }
          ]
        }
      ]
    }
  }
}

resource smoke 'Microsoft.App/jobs@2025-07-01' = {
  name: 'caj-lt-smoke'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${smokeIdentity.id}': {} } }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      replicaTimeout: 300
      replicaRetryLimit: 0
      registries: [{ server: registryLoginServer, identity: smokeIdentity.id }]
    }
    template: {
      containers: [
        {
          name: 'smoke'
          image: image
          args: ['dist/smoke.js', '--help']
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
        }
      ]
    }
  }
}
