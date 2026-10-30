// The migrate job's script (jobs.bicep embeds it): node --input-type=module -e "<this file>", run in /app.
// As id-lt-migrate, the server's Entra administrator, it first makes the app's managed identity a database
// role (APP_DB_USER) and gives it lt_app, the role 0001_init.sql grants the app's rights to, then runs the
// migrations (dist/migrate.js). Each step is skipped when already done, so every deploy can run it.
import pg from 'pg';
import { managedIdentity } from './dist/managed-identity.js';

const { PGHOST, PGUSER, AZURE_CLIENT_ID, APP_DB_USER, APP_DB_USER_OBJECT_ID } = process.env;
const POSTGRES_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';

const client = new pg.Client({
  host: PGHOST,
  database: 'postgres',
  user: PGUSER,
  password: async () => (await managedIdentity(AZURE_CLIENT_ID).getToken(POSTGRES_SCOPE)).token,
  ssl: { rejectUnauthorized: true },
});
const exists = async role => (await client.query('select 1 from pg_roles where rolname = $1', [role])).rowCount > 0;

try {
  await client.connect();
  if (!(await exists(APP_DB_USER))) {
    await client.query("select * from pgaadauth_create_principal_with_oid($1, $2, 'service', false, false)", [APP_DB_USER, APP_DB_USER_OBJECT_ID]);
    console.log(`Made managed identity ${APP_DB_USER} a database role.`);
  }
  if (!(await exists('lt_app'))) await client.query('create role lt_app nologin');
  await client.query(`grant lt_app to ${client.escapeIdentifier(APP_DB_USER)}`);
  console.log(`${APP_DB_USER} has the lt_app role.`);
} catch (error) {
  console.error(
    `The database roles could not be set up on ${PGHOST} as ${PGUSER}: ${error instanceof Error ? error.message : String(error)}. ` +
      'Check that this identity is the server\'s Entra administrator (lt-infra sets it), then deploy again. No migration ran.',
  );
  process.exit(1);
} finally {
  await client.end().catch(() => undefined);
}

await import('./dist/migrate.js');
