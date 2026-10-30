import assert from 'node:assert/strict';
import { test } from 'node:test';
import { knownRoles } from './roles.js';

test('only known role values are taken from the claim', () => {
  assert.deepEqual(knownRoles(['Viewer', 'Global.Admin', 'workspace.admin', 'BrandTeam', 'Viewer']), ['BrandTeam', 'Viewer']);
  assert.deepEqual(knownRoles('Workspace.Admin'), []);
  assert.deepEqual(knownRoles(undefined), []);
});
