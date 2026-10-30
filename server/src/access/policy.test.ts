import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APP_ROLES, type AppRole } from '../auth/roles.js';
import { allows, editsGate, editsLine, isAccess, permissions, type Actor } from './policy.js';

const ENTRA_TEAMS: Partial<Record<AppRole, string>> = { BrandTeam: 'brand', Supply: 'supply', VM: 'vm', Comms: 'comms' };
const actor = (...roles: AppRole[]): Actor => ({ userId: 'u1', roles, teams: roles.flatMap(role => ENTRA_TEAMS[role] ?? []) });
const GATES = [
  { key: 'listing', ownerTeam: 'brand' },
  { key: 'icf', ownerTeam: 'supply' },
  { key: 'fixtures', ownerTeam: 'vm' },
  { key: 'press', ownerTeam: 'comms' },
  { key: 'registration', ownerTeam: 'registration' },
];
const ALL_GATES = GATES.map(gate => gate.key);
const NOBODY = { admin: false, manageLaunches: false, import: false, export: true, margins: false, contacts: true, comment: true, editLines: 'none' };

// API contract section 2, one row per role.
const EXPECTED: Record<AppRole, ReturnType<typeof permissions>> = {
  'Workspace.Admin': { ...NOBODY, admin: true, manageLaunches: true, import: true, margins: true, teams: [], editableGates: ALL_GATES, editLines: 'all' },
  'Launch.Manager': { ...NOBODY, manageLaunches: true, import: true, margins: true, teams: [], editableGates: ALL_GATES, editLines: 'all' },
  BrandTeam: { ...NOBODY, teams: ['brand'], editableGates: ['listing'], editLines: 'own' },
  Supply: { ...NOBODY, margins: true, teams: ['supply'], editableGates: ['icf'], editLines: 'none' },
  VM: { ...NOBODY, teams: ['vm'], editableGates: ['fixtures'], editLines: 'none' },
  Comms: { ...NOBODY, teams: ['comms'], editableGates: ['press'], editLines: 'none' },
  Viewer: { ...NOBODY, export: false, contacts: false, comment: false, teams: [], editableGates: [], editLines: 'none' },
};

for (const role of APP_ROLES) {
  test(`${role} gets exactly the rights in the API contract`, () => {
    assert.deepEqual(permissions({}, actor(role), GATES), EXPECTED[role]);
  });
}

test('several roles give the union of their rights', () => {
  const rights = permissions({}, actor('BrandTeam', 'Supply'), GATES);
  assert.deepEqual(rights.editableGates, ['listing', 'icf']);
  assert.equal(rights.margins, true);
  assert.equal(rights.editLines, 'own');
});

test('a manual team gives its gates and margins, but never to a Viewer', () => {
  const commercial: Actor = { userId: 'u1', roles: ['Comms'], teams: ['comms', 'commercial', 'registration'] };
  const rights = permissions({}, commercial, GATES);
  assert.equal(rights.margins, true);
  assert.deepEqual(rights.editableGates, ['press', 'registration']);
  const viewer: Actor = { userId: 'u1', roles: ['Viewer'], teams: ['commercial', 'registration'] };
  assert.equal(editsGate(viewer, 'registration'), false);
  assert.equal(permissions({}, viewer, GATES).margins, false);
});

test('workspace settings change who sees margins and contacts', () => {
  const settings = { marginAccess: { roles: ['Launch.Manager'], teams: [] }, contactAccess: { roles: [], teams: ['vm'] } };
  assert.equal(permissions(settings, actor('Supply'), []).margins, false);
  assert.equal(permissions(settings, actor('Launch.Manager'), []).margins, true);
  assert.equal(permissions(settings, actor('VM'), []).contacts, true);
  assert.equal(permissions(settings, actor('BrandTeam'), []).contacts, false);
});

test('route access: any member, editors, or listed roles; nobody without a known role', () => {
  for (const role of APP_ROLES) {
    assert.equal(allows('any', actor(role)), true);
    assert.equal(allows('editor', actor(role)), role !== 'Viewer');
    assert.equal(allows(['Launch.Manager', 'Workspace.Admin'], actor(role)), role === 'Launch.Manager' || role === 'Workspace.Admin');
  }
  assert.equal(allows('any', { roles: [] }), false);
  assert.equal(allows('editor', { roles: ['Global.Admin'] }), false);
});

test('only declared access values are accepted', () => {
  assert.equal(isAccess('any'), true);
  assert.equal(isAccess(['Launch.Manager']), true);
  for (const bad of [undefined, 'anyone', [], ['Admin'], ['Viewer', 'admin']]) assert.equal(isAccess(bad), false, JSON.stringify(bad));
});

test('BrandTeam edits the lines assigned to them or to their brand team; managers edit all', () => {
  const brand = actor('BrandTeam');
  assert.equal(editsLine(brand, { assigneeId: 'u1', brandTeam: null }), true);
  assert.equal(editsLine(brand, { assigneeId: 'u2', brandTeam: 'brand' }), true);
  assert.equal(editsLine(brand, { assigneeId: 'u2', brandTeam: 'other' }), false);
  assert.equal(editsLine(actor('Supply'), { assigneeId: 'u1', brandTeam: null }), false);
  assert.equal(editsLine(actor('Launch.Manager'), { assigneeId: null, brandTeam: null }), true);
});
