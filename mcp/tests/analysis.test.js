const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { analyzeRequirements } = require('../dist/analysis.cjs');
const { formalizeRequirements } = require('../dist/formalize.cjs');
const { contentDigest, analysisCheckEvidence } = require('../src/schemas');

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
  const phases = [];
  const report = await analyzeRequirements(request, directory, phase => phases.push(phase));
  assert.equal(report.input_digest, contentDigest(request));
  assert.deepEqual(report.requested_ids, request.requirements.map(item => item.id));
  assert.match(report.toolchain.fret, /^sha256:[a-f0-9]{64}$/);
  if (report.checks.length === 0) {
    // Version discovery still runs; no contract or diagnosis solving may start.
    assert.deepEqual(phases, []);
    assert.deepEqual(fs.readdirSync(directory), []);
  }
  let previousTimeout = Math.floor(request.options.timeout_ms / 1000);
  for (const check of report.checks) {
    assert.equal(check.lustre_digest, contentDigest(check.lustre));
    assert.ok(check.stdout.length);
    assert.equal(check.command[0], 'kind2');
    const seconds = Number(check.command[check.command.indexOf('--timeout') + 1]);
    assert.ok(seconds < request.options.timeout_ms / 1000, 'solver must leave preparation/return budget');
    assert.ok(seconds <= previousTimeout, 'diagnosis must share the decreasing task budget');
    previousTimeout = seconds;
  }
  return report;
}

test('formal analysis retains declaration, role, and evidence schema validation', async t => {
  for (const [label, change, issuePath] of [
    ['invalid name', request => { request.variables[0].name = 'bad-name'; }, ['variables', 0, 'name']],
    ['invalid type', request => { request.variables[0].type = 'number'; }, ['variables', 0, 'type']],
    ['duplicate name', request => { request.variables[1].name = 'p'; }, ['variables', 1, 'name']],
    ['missing role', request => { delete request.variables[0].role; }, ['variables', 0, 'role']],
    ['missing meaning', request => { request.variables[0].meaning = ' '; }, ['variables', 0, 'meaning']],
    ['no output', request => { request.variables[1].role = 'input'; }, ['variables']],
    ['no source', request => { request.requirements[0].source_refs = []; }, ['requirements', 0, 'source_refs']],
    ['no guarantee', request => { request.requirements[0].kind = 'assumption'; }, ['requirements']],
    ['duplicate requirement', request => { request.requirements.push({ ...request.requirements[0] }); }, ['requirements', 1, 'id']]
  ]) {
    const request = input(['Controller shall always satisfy q']);
    change(request);
    await assert.rejects(() => analyze(t, request), error => {
      assert.ok(error.issues?.some(issue => JSON.stringify(issue.path) === JSON.stringify(issuePath)), label);
      return true;
    }, label);
  }
});

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

test('numeric models reject type errors before contract solving', linux, async t => {
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

test('formal analysis preserves public typed diagnostics, source locations, and all input IDs', linux, async t => {
  const request = input([
    'Controller shall always satisfy q',
    '\r\n  Controller shall\n    always satisfy (true | (q > p))',
    '\n  Controller shall satisfy missing',
    '  Controller shall\n   satisfy @',
    'Controller shall satisfy q trailing'
  ]);
  const preflight = formalizeRequirements({
    requirements: request.requirements.map(({ id, fretish }) => ({ id, fretish })),
    variables: request.variables.map(({ name, type }) => ({ name, type })),
    representations: ['pt-lustre', 'pt-smv', 'ft-inf', 'ft-fin']
  });
  const report = await analyze(t, request);
  assert.equal(report.result, 'invalid');
  assert.deepEqual(report.analyzed_ids, []);
  assert.deepEqual(report.checks, []);
  assert.equal(report.diagnosis.status, 'not_run');
  assert.deepEqual(report.formalization, preflight);
  assert.deepEqual(report.formalization.results.map(result => [result.id, result.status]), [
    ['G0', 'formalized'], ['G1', 'invalid'], ['G2', 'invalid'], ['G3', 'invalid'], ['G4', 'invalid']
  ]);
  for (const [index, code, marker] of [[1, 'type_error', 'q'], [2, 'undeclared_variable', 'missing'], [3, 'syntax_error', '@']]) {
    const result = report.formalization.results[index];
    const diagnostic = result.diagnostics.find(item => item.code === code);
    const lines = request.requirements[index].fretish.split('\n');
    const lineIndex = lines.findIndex(line => line.includes(marker));
    assert.deepEqual(diagnostic.location, { line: lineIndex + 1, column: lines[lineIndex].indexOf(marker) + 1 });
    assert.ok(report.diagnostics.some(item => item.id === result.id && item.code === code));
  }
  assert.equal(report.formalization.results[4].diagnostics[0].code, 'requirement_error');
  assert.equal(report.formalization.results[4].diagnostics[0].location, null);
});

test('typed compilation does not bypass formal component and duration validation', linux, async t => {
  for (const [fretish, expected, code] of [
    ['OtherController shall always satisfy q', 'invalid', 'component_mismatch'],
    ['Controller shall within 0.5 ticks satisfy q', 'unsupported', 'unsupported_duration'],
    ['Controller shall within 10001 ticks satisfy q', 'unsupported', 'unsupported_duration']
  ]) {
    const request = input([fretish]);
    const report = await analyze(t, request);
    assert.equal(report.formalization.results[0].status, 'formalized', fretish);
    assert.equal(report.result, expected, fretish);
    assert.ok(report.diagnostics.some(item => item.id === 'G0' && item.code === code), fretish);
    assert.deepEqual(report.checks, []);
    assert.deepEqual(report.analyzed_ids, []);
  }
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

test('integer constants remain integers in genuine backend analysis', linux, async t => {
  for (const literal of ['0', '-1', '9007199254740993']) {
    const request = input([`Controller shall always satisfy q = ${literal}`]);
    request.variables[1].type = 'int';
    const report = await analyze(t, request);
    assert.equal(report.result, 'realizable', literal);
    assert.equal(report.environment_result, 'realizable', literal);
    assert.deepEqual(report.analyzed_ids, ['G0']);
    assert.ok(report.checks[0].lustre.includes(`fret_v_1 = ${literal}`), literal);
  }
});

test('separate components retain independent realizability with reused variable names', linux, async t => {
  for (const [component, expression] of [['FirstController', 'q'], ['SecondController', '!q']]) {
    const request = input([`${component} shall always satisfy ${expression}`]);
    request.component = component;
    const report = await analyze(t, request);
    assert.equal(report.result, 'realizable', component);
    assert.deepEqual(report.analyzed_ids, ['G0']);
    assert.deepEqual(report.diagnosis.conflicts, []);
  }
});

test('unsupported scalar operations and functions are rejected before contract solving', linux, async t => {
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
    if (name === 'FTP') assert.equal(report.formalization.results[0].status, 'formalized');
  }
});

test('a budget without a full solver second returns unknown without launching Kind2', linux, async t => {
  const request = input([
    'Whenever p Controller shall within 5000 ticks satisfy q', 'Controller shall always satisfy !q'
  ]);
  request.options = { timeout_ms: 1000, diagnose: false };
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'fret-short-budget-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const report = await analyzeRequirements(request, directory);
  assert.equal(report.result, 'unknown', JSON.stringify(report.diagnostics));
  assert.equal(report.contract_result, null);
  assert.deepEqual(report.checks, []);
  assert.deepEqual(report.analyzed_ids, []);
  assert.equal(report.diagnostics[0].code, 'timeout');
});

test('slow source acknowledgement consumes budget once and final evidence is drained before return', linux, async t => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'fret-slow-evidence-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const request = input(['Controller shall always satisfy q']);
  request.options = { timeout_ms: 6000, diagnose: false };
  const deadline = process.hrtime.bigint() + 6000000000n;
  let preparedCount = 0;
  let preparedAcknowledged;
  const snapshots = [];
  const report = await analyzeRequirements(request, directory, undefined, {
    deadline_ns: deadline.toString(),
    persist: async update => {
      if (!update.check) return;
      if (update.check.started_at === null) {
        preparedCount += 1;
        assert.deepEqual(update.check.command, []);
        await delay(1200);
        preparedAcknowledged = process.hrtime.bigint();
      } else await delay(50);
      snapshots.push(update.check);
    }
  });
  assert.equal(preparedCount, 1, 'source persistence must not loop waiting for a sub-second acknowledgement');
  assert.equal(report.result, 'realizable');
  assert.equal(report.checks.length, 1);
  const command = report.checks[0].command;
  const seconds = Number(command[command.indexOf('--timeout') + 1]);
  assert.ok(seconds >= 1);
  assert.ok(seconds <= Math.floor(Number(deadline - preparedAcknowledged) / 1000000000) - 1);
  const final = snapshots.at(-1);
  assert.equal(final.output_complete, true);
  assert.equal(final.exit_code, 0);
  assert.equal(final.signal, null);
  assert.ok(final.finished_at);
  assert.deepEqual(final.command, command);
  assert.equal(final.stdout, report.checks[0].stdout);
  assert.equal(final.lustre_digest, report.checks[0].lustre_digest);
});

test('generated-input and UTF-8 diagnostic prefixes enforce their byte and completeness limits', () => {
  const original = 'x'.repeat(1024 * 1024) + '😀';
  const check = {
    name: 'FretContract.lus', requirement_ids: ['G0'], command: ['kind2'],
    started_at: '2026-10-23T00:00:00.000Z', finished_at: null,
    toolchain: { fret: 'sha256:' + 'a'.repeat(64), adapter: '0.3.0', kind2: 'kind2 v2.2.0', z3: 'Z3 version 4.14.1 - 64 bit' },
    lustre: original.slice(0, 1024 * 1024), lustre_digest: contentDigest(original),
    lustre_bytes: Buffer.byteLength(original), lustre_truncated: true,
    stdout: 'é'.repeat(32768), stderr: '', stdout_truncated: true, stderr_truncated: false,
    exit_code: null, signal: null, output_complete: false
  };
  assert.deepEqual(analysisCheckEvidence.parse(check), check);
  assert.throws(() => analysisCheckEvidence.parse({ ...check, stdout: check.stdout + 'x' }), /65536/);
  assert.throws(() => analysisCheckEvidence.parse({ ...check, lustre: check.lustre + 'é' }), /1048576/);
  assert.throws(() => analysisCheckEvidence.parse({ ...check, lustre_truncated: false }), /size\/digest/);
  assert.throws(() => analysisCheckEvidence.parse({ ...check, output_complete: true }), /normal process exit/);
  assert.throws(() => analysisCheckEvidence.parse({ ...check, exit_code: 0 }), /Unfinished check/);
});
