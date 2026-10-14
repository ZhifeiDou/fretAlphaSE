const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const DiagnosisEngine = require('../../fret-electron/analysis/DiagnosisEngine');
const { createContract } = require('../../fret-electron/analysis/contractBuilder');

function diagnosis(t, ids, verdict, engineName = 'kind2', engineOptions = []) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'fret-diagnosis-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const contract = { componentName: 'Test', properties: [
    { reqid: 'environment', kind: 'assumption', value: 'allowed' },
    ...ids.map(reqid => ({ reqid, kind: 'guarantee', value: reqid }))
  ] };
  return new DiagnosisEngine(contract, engineName, engineOptions, {
    workDirectory: directory,
    renderContract: JSON.stringify,
    async checkContract(file, engine, options) {
      const { properties } = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(properties.filter(p => p.kind === 'assumption').length, 1);
      assert.equal(engine, engineName);
      const result = verdict(properties.filter(p => p.kind === 'guarantee').map(p => p.reqid), options);
      return typeof result === 'string' ? { result, jsonOutput: [], traceInfo: null } : result;
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

test('JKind rechecks minimal conflicts without fixpoint and preserves their counterexamples', { timeout: 3000 }, async t => {
  const options = ['-json', '-fixpoint', '-timeout', '30'];
  const originalOptions = [...options];
  const expected = [['a', 'b'], ['c']];
  const calls = [];
  const traces = new Map();
  const engine = diagnosis(t, ['a', 'b', 'c', 'd'], (ids, requestedOptions) => {
    calls.push({ ids, options: [...requestedOptions] });
    const result = expected.some(conflict => conflict.every(id => ids.includes(id))) ? 'UNREALIZABLE' : 'REALIZABLE';
    if (requestedOptions.includes('-fixpoint')) return { result, jsonOutput: { Answer: { text: result } } };
    const jsonOutput = { K: 2, Counterexample: [
      { name: ids.join('_'), type: 'bool', 'Step 0': false, 'Step 1': true }
    ] };
    traces.set(JSON.stringify(ids), jsonOutput);
    return { result, jsonOutput };
  }, 'jkind', options);
  const originalContract = structuredClone(engine.contract);
  const [error, result] = await engine.main();
  assert.equal(error, null);
  assert.equal(result[0], 'UNREALIZABLE');
  const normalized = values => values.map(ids => JSON.stringify([...ids].sort())).sort();
  assert.deepEqual(normalized(result[1].Conflicts.map(conflict => conflict.Conflict)), normalized(expected));
  assert.equal(result[1].Counterexamples.length, expected.length);
  const rechecks = calls.filter(call => !call.options.includes('-fixpoint'));
  assert.deepEqual(normalized(rechecks.map(call => call.ids)), normalized(expected));
  assert.ok(calls.some(call => call.ids.length === 4 && call.options.includes('-fixpoint')));
  for (const call of calls) {
    assert.deepEqual(call.options, call.options.includes('-fixpoint') ? originalOptions : ['-json', '-timeout', '30']);
  }
  for (const counterexample of result[1].Counterexamples) {
    const trace = traces.get(JSON.stringify(counterexample.requirements));
    assert.equal(counterexample.traceLength, trace.K);
    assert.deepEqual(counterexample.Counterexample, trace.Counterexample);
    assert.deepEqual(counterexample.backendOutput, trace);
  }
  assert.deepEqual(engine.contract, originalContract);
  assert.deepEqual(options, originalOptions);
  assert.equal(engine.engineOptions, options);
});

test('an inconclusive or changed JKind counterexample recheck prevents completed diagnosis', { timeout: 3000 }, async t => {
  for (const result of ['REALIZABLE', 'UNKNOWN', 'ERROR']) {
    await t.test(result, async t => {
      const engine = diagnosis(t, ['a', 'b'], (ids, options) => options.includes('-fixpoint') ?
        (ids.includes('a') ? 'UNREALIZABLE' : 'REALIZABLE') : { result, error: 'JKind failed.' },
        'jkind', ['-json', '-fixpoint']);
      if (result === 'UNKNOWN') {
        const [error, report] = await engine.main();
        assert.match(error, /unknown/i);
        assert.equal(report, null);
      } else {
        await assert.rejects(engine.main(), result === 'ERROR' ? /JKind failed/ : /counterexample.*unrealizable/i);
      }
    });
  }
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
