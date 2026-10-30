import type { AppRole } from './roles.js';
import type { Identity } from './sessions.js';

/** The tenant the test identity provider signs users in to; no real tenant has this ID. */
export const DEV_TENANT_ID = '00000000-0000-4000-8000-000000000000';

const user = (n: number, email: string, name: string, roles: AppRole[]): Identity => ({
  oid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  tenantId: DEV_TENANT_ID,
  email,
  name,
  roles,
});

/** Synthetic people, one per role, for local runs and CI. Nothing here is a real person. */
export const DEV_USERS: readonly Identity[] = [
  user(1, 'admin@example.test', 'Ada Admin', ['Workspace.Admin']),
  user(2, 'manager@example.test', 'Mo Manager', ['Launch.Manager']),
  user(3, 'brand@example.test', 'Bea Brand', ['BrandTeam']),
  user(4, 'supply@example.test', 'Sam Supply', ['Supply']),
  user(5, 'vm@example.test', 'Val Visual', ['VM']),
  user(6, 'comms@example.test', 'Cal Comms', ['Comms']),
  user(7, 'viewer@example.test', 'Vic Viewer', ['Viewer']),
];
