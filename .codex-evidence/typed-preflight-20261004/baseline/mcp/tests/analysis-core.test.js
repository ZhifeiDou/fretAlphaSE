const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const DiagnosisEngine = require('../../fret-electron/analysis/DiagnosisEngine');
const { createContract } = require('../../fret-electron/analysis/contractBuilder');

function diagnosis(t, ids, verdict) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'fret-diagnosis-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const contract = { componentName: 'Test', properties: [
    { reqid: 'environment', kind: 'assumption', value: 'allowed' },
    ...ids.map(reqid => ({ reqid, kind: 'guarantee', value: reqid }))
  ] };
  return new DiagnosisEngine(contract, 'kind2', [], {
    workDirectory: directory,
    renderContract: JSON.stringify,
    async checkContract(file) {
      const { properties } = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(properties.filter(p => p.kind === 'assumption').length, 1);
      const result = verdict(properties.filter(p => p.kind === 'guarantee').map(p => p.reqid));
      return { result, jsonOutput: [], traceInfo: null };
    }
  });
}

test('diagnosis handles a realizable set without inventing a conflict', { timeout: 3000 }, async t => {
  const [error, result] = await diagnosis(t, ['a', 'b', 'c'], () => 'REALIZABLE').main();
  assert.equal(error, null);
  assert.equal(result[0], 'REALIZABLE');
  assert.deepEqual(result[1].Conflicts, []);
});

test('diagnosis finds all minimal conflicts under the same explicit assumptions', { timeout: 3000 }, async t => {
  const expected = [['a', 'bc'], ['ab', 'c'], ['d']];
  const engine = diagnosis(t, ['a', 'bc', 'ab', 'c', 'd'], ids =>
    expected.some(conflict => conflict.every(id => ids.includes(id))) ? 'UNREALIZABLE' : 'REALIZABLE');
  const [error, result] = await engine.main();
  assert.equal(error, null);
  assert.equal(result[0], 'UNREALIZABLE');
  const normalized = values => values.map(ids => JSON.stringify([...ids].sort())).sort();
  assert.deepEqual(normalized(result[1].Conflicts.map(c => c.Conflict)), normalized(expected));
});

test('an inconclusive subset prevents completed diagnosis', { timeout: 3000 }, async t => {
  const [error, result] = await diagnosis(t, ['a', 'b'], ids => ids.length === 2 ? 'UNREALIZABLE' : 'UNKNOWN').main();
  assert.match(error, /unknown/i);
  assert.equal(result, null);
});

test('the pure contract builder retains variable types and rejects an unsupported type', () => {
  const contract = createContract([
    { variable_name: 'trigger', idType: 'Input', dataType: 'boolean' },
    { variable_name: 'count', idType: 'Output', dataType: 'integer' },
    { variable_name: 'value', idType: 'Output', dataType: 'double' }
  ]);
  assert.deepEqual(contract.inputVariables, [{ name: 'trigger', type: 'bool' }]);
  assert.deepEqual(contract.outputVariables, [{ name: 'count', type: 'int' }, { name: 'value', type: 'real' }]);
  assert.throws(() => createContract([{ variable_name: 'x', idType: 'Input', dataType: 'object' }]), /Unsupported/);
});
