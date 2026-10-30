import assert from 'node:assert/strict';
import test from 'node:test';
import { GCC_GATE_DEFINITIONS, createGccTemplate, gateById, gateDueDate, gateState, readinessForLine, setGateValue } from './launch-gates.js';

const stores = [{ code: 'TST', opening: '2026-12-01' }];
const template = createGccTemplate();

test('GCC store launch defines the 14 specified gates and their ownership metadata', () => {
  assert.equal(GCC_GATE_DEFINITIONS.length, 14);
  assert.deepEqual(
    GCC_GATE_DEFINITIONS.map(gate => gate.name),
    [
      'Listing',
      'Vendor comms',
      'Floor plan',
      'Vendor agreement (VPA)',
      'Registration / new data set-up',
      'Marketing OK',
      'Vendor set-up',
      'Item creation (ICF)',
      'Schematics',
      'Fixture',
      'Purchase order',
      'Delivery',
      'VM install',
      'At launch',
    ],
  );
  assert.ok(GCC_GATE_DEFINITIONS.every(gate => gate.ownerTeam && Number.isInteger(gate.dueOffset) && gate.values.length));
  assert.equal(gateById(template, 'listing').values.find(value => value.id === 'no').closesStore, true);
});

test('purple and blue US brands skip vendor set-up and ICF and use the US DC PO value', () => {
  for (const brandCode of ['purple', 'blue']) {
    const line = { fields: { 'brand-code': brandCode }, gates: { 'purchase-order': { TST: 'not-raised' } } };
    assert.deepEqual(gateState(line, gateById(template, 'vendor-setup'), null).display, 'US brand');
    assert.equal(gateState(line, gateById(template, 'icf'), null).applicable, false);
    assert.equal(gateState(line, gateById(template, 'purchase-order'), 'TST').valueId, 'picked-us-dc');
  }
});

test('Grey and Listing No close the affected store gates', () => {
  const grey = { fields: { 'brand-code': 'grey' }, gates: { listing: { TST: 'yes' }, vpa: 'signed' } };
  assert.equal(gateState(grey, gateById(template, 'delivery'), 'TST').applicable, false);
  assert.equal(gateState(grey, gateById(template, 'vpa'), null).applicable, true);

  const notListed = { fields: { 'brand-code': 'yellow' }, gates: { listing: { TST: 'no' }, delivery: { TST: 'delivered' } } };
  const delivery = gateState(notListed, gateById(template, 'delivery'), 'TST');
  assert.equal(delivery.applicable, false);
  assert.match(delivery.display, /Not listed/);
});

test('DOUBLE placements inherit every brand-level answer from the primary line', () => {
  const primary = { id: 'LINE-1', gates: { vpa: 'signed' } };
  const double = { doubleOf: primary.id, gates: { vpa: 'pending' } };
  const state = gateState(double, gateById(template, 'vpa'), null, id => (id === primary.id ? primary : null));
  assert.equal(state.valueId, 'signed');
  assert.equal(state.done, true);
  assert.equal(state.inherited, true);
});

test('readiness is done divided by applicable gates and excludes skipped gates', () => {
  const line = { fields: { 'brand-code': 'purple' }, gates: {} };
  for (const gate of template.gates) {
    const firstDone = gate.values.find(value => value.done);
    if (!firstDone) continue;
    if (gate.scope === 'store') setGateValue(line, gate, 'TST', firstDone.id);
    else setGateValue(line, gate, null, firstDone.id);
  }
  const readiness = readinessForLine(line, template, stores);
  assert.equal(readiness.percent, 100);
  assert.equal(readiness.applicable, 12);
});

test('due offsets are applied to each store opening', () => {
  assert.equal(gateDueDate('2026-12-01', -30), '2026-11-01');
  assert.equal(gateDueDate('2026-12-01', 0), '2026-12-01');
});
