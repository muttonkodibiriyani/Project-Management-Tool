import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from './app.js';
import type { AuthOptions } from './auth/plugin.js';
import { entraClient } from './auth/entra.js';
import { postgresSessions } from './auth/sessions.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { createContainer, createPool, databaseCheck, storageCheck } from './dependencies.js';
import { expireIdempotencyKeys } from './api/rows.js';
import { healthReporter } from './health.js';
import { managedIdentity } from './managed-identity.js';

function stop(message: string): never {
  console.error(message);
  process.exit(1);
}

let config: Config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) stop(error.message);
  throw error;
}
if (!existsSync(join(config.publicDir, 'index.html'))) {
  stop(`Launch Tracker cannot start: there is no web app in ${config.publicDir}. Build gr8r-studio (npm run build) and set PUBLIC_DIR to its dist folder.`);
}

const pool = createPool(config.database, error => {
  app.log.warn({ err: error }, 'an idle PostgreSQL connection closed; the next query reconnects');
});
const health = healthReporter([databaseCheck(pool, config.database), storageCheck(createContainer(config.storage), config.storage)], {
  commit: config.commit,
  imageDigest: config.imageDigest,
});
const sessions = postgresSessions(pool);
const { auth: authConfig } = config;
const auth: AuthOptions =
  authConfig.mode === 'entra'
    ? {
        mode: 'entra',
        sessions,
        signingKey: authConfig.signingKey,
        publicOrigin: authConfig.publicOrigin,
        entra: entraClient({
          tenantId: authConfig.tenantId,
          clientId: authConfig.clientId,
          redirectUri: `${authConfig.publicOrigin}/auth/callback`,
          assertion: managedIdentity(authConfig.managedIdentityClientId),
        }),
      }
    : { mode: 'dev', sessions, signingKey: authConfig.signingKey };
const app = buildApp({ publicDir: config.publicDir, health, pool, auth, logger: true, proxyHops: config.proxyHops });

const HOUR_MS = 3_600_000;
const expireKeys = () => {
  expireIdempotencyKeys(pool).catch((error: unknown) => {
    app.log.warn({ err: error }, 'old idempotency keys could not be removed; the next hourly run tries again');
  });
};
expireKeys();
setInterval(expireKeys, HOUR_MS).unref();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.log.info(`${signal} received, closing`);
    void app
      .close()
      .then(() => pool.end())
      .then(() => process.exit(0));
  });
}

try {
  await app.listen({ host: '0.0.0.0', port: config.port });
  app.log.info({ commit: config.commit, imageDigest: config.imageDigest, authMode: authConfig.mode }, 'Launch Tracker is serving');
} catch (error) {
  stop(`Launch Tracker cannot listen on port ${config.port}: ${error instanceof Error ? error.message : String(error)}. Free the port or set PORT.`);
}
