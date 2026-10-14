const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { analyzeRequirements } = require('../dist/analysis.cjs');
const { contentDigest } = require('../src/schemas');

const linux = { skip: process.platform !== 'linux' && 'Real analysis runs in the Linux Docker image.' };
function input(guarantees, assumptions = []) {
  return {
    request_id: randomUUID(), component: 'Controller',
    requirements: [
      ...assumptions.map((fretish, i) => ({ id: `A${i}`, fretish, kind: 'assumption', source_refs: ['source:environment'] })),
      ...guarantees.map((fretish, i) => ({ id: `G${i}`, fretish, kind: 'guarantee', source_refs: ['source:behavior'] }))
    ],
    variables: [
      { name: 'p', type: 'bool', role: 'input', meaning: 'Environment trigger' },
      { name: 'q', type: 'bool', role: 'output', meaning: 'Controller response' }
    ],
    time_model: { kind: 'discrete_steps', description: 'One controller input/output evaluation per step.' },
    options: { timeout_ms: 30000, diagnose: true }
  };
}
async function analyze(t, request) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'fret-analysis-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const report = await analyzeRequirements(request, directory);
  assert.equal(report.input_digest, contentDigest(request));
  assert.deepEqual(report.requested_ids, request.requirements.map(item => item.id));
  assert.match(report.toolchain.fret, /^sha256:[a-f0-9]{64}$/);
  for (const check of report.checks) {
    assert.equal(check.lustre_digest, contentDigest(check.lustre));
    assert.ok(check.stdout.length);
    assert.equal(check.command[0], 'kind2');
  }
  return report;
}

test('real backend distinguishes realizability from satisfiability', linux, async t => {
  const good = await analyze(t, input(['Whenever p Controller shall immediately satisfy q']));
  assert.equal(good.result, 'realizable');
  assert.equal(good.environment_result, 'realizable');
  const bad = await analyze(t, input(['Controller shall always satisfy p']));
  assert.equal(bad.result, 'unrealizable');
  assert.ok(JSON.parse(bad.checks[0].stdout).some(event => event.objectType === 'satisfiabilityCheck' && event.result === 'satisfiable'));
  assert.deepEqual(bad.diagnosis.conflicts, [['G0']]);
});

test('real FRET diagnoses a temporal conflict with exact input IDs and backend trace', linux, async t => {
  const request = input([
    'Whenever p Controller shall within 2 ticks satisfy q',
    'Controller shall always satisfy !q'
  ]);
  request.requirements[0].id = 'assumption_is_only_part_of_this_guarantee_ID';
  const report = await analyze(t, request);
  assert.equal(report.result, 'unrealizable');
  assert.deepEqual(report.analyzed_ids, report.requested_ids);
  assert.equal(report.diagnosis.status, 'completed');
  assert.deepEqual(report.diagnosis.conflicts, [report.requested_ids]);
  assert.ok(report.checks[0].counterexample.contract.length);
  assert.deepEqual(report.variable_mapping, { fret_v_0: 'p', fret_v_1: 'q' });
});

test('real diagnosis finds multiple conflicts and a single impossible guarantee', linux, async t => {
  const report = await analyze(t, input([
    'Controller shall always satisfy q', 'Controller shall always satisfy !q',
    'Controller shall always satisfy (q <-> p)'
  ]));
  assert.equal(report.diagnosis.status, 'completed');
  assert.deepEqual(report.diagnosis.conflicts.map(ids => [...ids].sort().join(',')).sort(), ['G0,G1', 'G0,G2', 'G1,G2']);
  const single = await analyze(t, input(['Controller shall always satisfy (q & !q)']));
  assert.deepEqual(single.diagnosis.conflicts, [['G0']]);
});

test('explicit assumptions affect the result and an impossible environment never passes', linux, async t => {
  const report = await analyze(t, input([
    'Whenever p Controller shall immediately satisfy q', 'Whenever p Controller shall immediately satisfy !q'
  ], ['Controller shall always satisfy !p']));
  assert.equal(report.result, 'realizable');
  assert.deepEqual(report.assumption_ids, ['A0']);
  assert.match(report.checks[0].lustre, /assume "fret_r_0"/);
  const invalid = await analyze(t, input(['Controller shall always satisfy q'], ['Controller shall always satisfy (p & !p)']));
  assert.equal(invalid.result, 'invalid');
  assert.equal(invalid.contract_result, 'realizable');
  assert.equal(invalid.environment_result, 'unrealizable');
  assert.ok(invalid.checks[0].counterexample.environment.length);
});

test('one unsupported or invalid item prevents silent partial-set analysis', linux, async t => {
  for (const [text, expected] of [
    ['"Free text only"', 'unsupported'],
    ['Controller shall with probability >= 0.9 eventually satisfy q', 'unsupported'],
    ['Controller shall within 0.5 ticks satisfy q', 'unsupported'],
    ['DifferentComponent shall always satisfy q', 'invalid'],
    ['Controller shall always satisfy missing', 'invalid'],
    ['Controller shall satisfy @', 'invalid']
  ]) {
    const report = await analyze(t, input(['Controller shall always satisfy q', text]));
    assert.equal(report.result, expected, text);
    assert.deepEqual(report.analyzed_ids, []);
    assert.deepEqual(report.checks, []);
    assert.equal(report.formalization.results.length, 2);
  }
});

test('numeric models reject type errors before calling the backend', linux, async t => {
  const request = input(['Controller shall always satisfy (q > p)']);
  request.variables.forEach(v => { v.type = 'real'; });
  assert.equal((await analyze(t, request)).result, 'realizable');
  request.variables.forEach(v => { v.type = 'bool'; });
  const invalid = await analyze(t, request);
  assert.equal(invalid.result, 'invalid');
  assert.deepEqual(invalid.checks, []);
  assert.deepEqual(invalid.analyzed_ids, []);
  assert.equal(invalid.diagnostics[0].id, 'G0');
  assert.equal(invalid.diagnostics[0].code, 'type_error');
  assert.match(invalid.diagnostics[0].message, /bool/);
});

test('real reward constants preserve per-clause type diagnostics and exact valid formulas', linux, async t => {
  const request = input(['Controller shall always satisfy q = 0', 'Controller shall always satisfy q = 0.0']);
  request.variables[1].type = 'real';
  const invalid = await analyze(t, request);
  assert.equal(invalid.result, 'invalid');
  assert.deepEqual(invalid.checks, []);
  assert.deepEqual(invalid.analyzed_ids, []);
  assert.equal(invalid.diagnostics[0].id, 'G0');
  assert.equal(invalid.diagnostics[0].code, 'type_error');
  assert.match(invalid.diagnostics[0].message, /real.*int/);
  assert.deepEqual(invalid.formalization.results[0].diagnostics[0].location, { line: 1, column: 33 });
  assert.deepEqual(invalid.formalization.results.map(r => r.status), ['invalid', 'formalized']);

  for (const literal of ['0.0', '1.0', '-1.0', '1e3']) {
    const fixed = input([`Controller shall always satisfy q = ${literal}`]);
    fixed.variables[1].type = 'real';
    const report = await analyze(t, fixed);
    assert.equal(report.result, 'realizable', literal);
    assert.equal(report.environment_result, 'realizable', literal);
    assert.deepEqual(report.analyzed_ids, ['G0']);
    assert.ok(report.checks[0].lustre.includes(`fret_v_1 = ${literal}`), literal);
  }
});

test('unsupported scalar operations and functions are rejected without running Kind 2', linux, async t => {
  for (const [expression, code] of [
    ['q = (p ^ 2)', 'unsupported_operator'],
    ['unknownFunction(p) = q', 'unsupported_function']
  ]) {
    const request = input([`Controller shall satisfy ${expression}`]);
    request.variables.forEach(variable => { variable.type = 'int'; });
    const report = await analyze(t, request);
    assert.equal(report.result, 'unsupported', expression);
    assert.deepEqual(report.checks, []);
    assert.deepEqual(report.analyzed_ids, []);
    assert.equal(report.diagnostics[0].id, 'G0');
    assert.equal(report.diagnostics[0].code, code);
  }
});

test('reserved temporal operator names are rejected before solver execution', linux, async t => {
  for (const name of ['H', 'FTP']) {
    const request = input([`Controller shall always satisfy ${name}`]);
    request.variables[1].name = name;
    const report = await analyze(t, request);
    assert.equal(report.result, 'invalid', name);
    assert.match(report.diagnostics[0].message, /reserved/);
    assert.deepEqual(report.checks, []);
  }
});

test('a real backend timeout is unknown and preserves its execution evidence', linux, async t => {
  const request = input([
    'Whenever p Controller shall within 5000 ticks satisfy q', 'Controller shall always satisfy !q'
  ]);
  request.options = { timeout_ms: 1000, diagnose: false };
  const report = await analyze(t, request);
  assert.equal(report.result, 'unknown', JSON.stringify(report.diagnostics));
  assert.equal(report.contract_result, 'unknown');
  assert.match(report.checks[0].stdout, /TimeoutWall|Wallclock timeout/);
});
