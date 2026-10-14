const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { formalizeRequirements } = require('../dist/formalize.cjs');
const { analyzeRequirements } = require('../dist/analysis.cjs');
const { contentDigest } = require('../src/schemas');
const historical = require('./fixtures/historical-failed-models.json');
const corrected = require('./fixtures/historical-corrected-models.json');

const linux = { skip: process.platform !== 'linux' && 'Real analysis runs in the Linux Docker image.' };
const representations = ['pt-lustre', 'pt-smv', 'ft-inf', 'ft-fin'];
const typeErrorColumns = {
  'SRS-10-08:remaining_fraction': [10, 75],
  'SRS-18-11:clear_counters': [40],
  'SRS-23-04:combined_moments': [28],
  'SRS-23-03:combined_moments': [27],
  'SRS-23-05:combined_moments': [28],
  'SRS-23-08:ones_initialization': [87],
  'SRS-23-08:squared_gradient_update': [186],
  'SRS-23-08:gradient_average_update': [132],
  'SRS-23-08:uncentered_denominator': [37, 113],
  'SRS-23-08:centered_denominator': [36, 150],
  'SRS-23-08:plain_parameter_update': [25, 45],
  'SRS-23-08:momentum_parameter_update': [25, 45]
};

function preflight(input) {
  return formalizeRequirements({
    requirements: input.requirements.map(({ id, fretish }) => ({ id, fretish })),
    representations,
    variables: input.variables.map(({ name, type }) => ({ name, type }))
  });
}

function assertCorrectedOutcome(report, allowUnknown) {
  assert.ok((allowUnknown ? ['realizable', 'unknown'] : ['realizable']).includes(report.result),
    JSON.stringify({ result: report.result, diagnostics: report.diagnostics }));
  assert.equal(report.checks.length, 1);
  const check = report.checks[0];
  const events = JSON.parse(check.stdout);
  const timeout = events.some(event => event.value === 'Wallclock timeout.' ||
    (event.level === 'fatal' && event.value?.endsWith('Lib.TimeoutWall')));
  assert.ok([0, 30, 40].includes(check.exit_code) || timeout, 'Unrecognized backend exit without timeout evidence.');
  const conclusions = new Map();
  let context;
  let contractStarted = false;
  for (const event of events) {
    if (event.objectType === 'analysisStart') {
      context = event.context || 'contract';
      if (context === 'contract') contractStarted = true;
    } else if (event.objectType === 'analysisStop') context = null;
    else if (context && event.objectType === 'realizabilityCheck') conclusions.set(context, event);
  }
  assert.ok(contractStarted, 'The raw output must show contract analysis started.');
  for (const [name, reported, recorded] of [
    ['contract', report.contract_result, check.result],
    ['environment', report.environment_result, check.environment_result]
  ]) {
    const conclusion = conclusions.get(name);
    assert.ok(conclusion?.result == null || ['realizable', 'unknown'].includes(conclusion.result),
      `Unexpected ${name} conclusion requires review: ${conclusion?.result}`);
    const expected = conclusion?.runtime?.timeout ? 'unknown' : conclusion?.result ?? (timeout ? 'unknown' : null);
    assert.ok(['realizable', 'unknown'].includes(expected), `Missing ${name} conclusion or timeout evidence.`);
    assert.equal(reported, expected, name);
    assert.equal(recorded, expected.toUpperCase(), name);
  }
  assert.equal(report.result, [report.contract_result, report.environment_result].includes('unknown') ? 'unknown' : 'realizable');
  assert.deepEqual(report.diagnostics.map(item => item.code), report.environment_result === 'unknown' ? ['unknown_environment'] : []);
  if (report.result === 'realizable') assert.equal(check.exit_code, 0);
}

test('historical replay accepts only outcomes supported by contract and environment evidence', async t => {
  // Controlled evidence exercises the live replay assertions; it is not a solver proof.
  const events = [
    { objectType: 'analysisStart', context: 'contract' },
    { objectType: 'realizabilityCheck', result: 'realizable' },
    { objectType: 'analysisStop' },
    { objectType: 'analysisStart', context: 'environment' },
    { objectType: 'realizabilityCheck', result: 'realizable' },
    { objectType: 'analysisStop' }
  ];
  const report = {
    result: 'realizable', contract_result: 'realizable', environment_result: 'realizable', diagnostics: [],
    checks: [{ result: 'REALIZABLE', environment_result: 'REALIZABLE', exit_code: 0, stdout: JSON.stringify(events) }]
  };
  assertCorrectedOutcome(report, false);
  assertCorrectedOutcome(report, true);
  for (const [name, contract, environment, evidence, exitCode] of [
    ['explicit contract unknown', 'unknown', 'realizable', [{ ...events[1], result: 'unknown' }], 30],
    ['runtime timeout', 'unknown', 'realizable', [{ ...events[1], runtime: { timeout: true } }], 0],
    ['wallclock timeout', 'unknown', 'unknown', [{ objectType: 'log', value: 'Wallclock timeout.' }], 30],
    ['fatal timeout', 'unknown', 'unknown', [{ objectType: 'log', level: 'fatal', value: 'Exception: Lib.TimeoutWall' }], 2],
    ['environment unknown', 'realizable', 'unknown', [{ ...events[4], result: 'unknown' }], 30]
  ]) {
    await t.test(name, () => {
      const candidate = structuredClone(report);
      candidate.result = 'unknown';
      candidate.contract_result = contract;
      candidate.environment_result = environment;
      candidate.diagnostics = environment === 'unknown' ? [{ code: 'unknown_environment' }] : [];
      const check = candidate.checks[0];
      check.result = contract.toUpperCase();
      check.environment_result = environment.toUpperCase();
      check.exit_code = exitCode;
      const raw = structuredClone(events);
      if (contract === 'realizable') raw.splice(4, 1, ...evidence);
      else if (environment === 'realizable') raw.splice(1, 1, ...evidence);
      else raw.splice(1, raw.length - 1, ...evidence);
      check.stdout = JSON.stringify(raw);
      assertCorrectedOutcome(candidate, true);
      assert.throws(() => assertCorrectedOutcome(candidate, false), assert.AssertionError);
      candidate.result = 'realizable';
      assert.throws(() => assertCorrectedOutcome(candidate, true), assert.AssertionError);
    });
  }
  for (const [name, change] of [
    ...['error', 'invalid', 'unsupported', 'unrealizable', 'unknown'].map(result =>
      [result, candidate => { candidate.result = result; }]),
    ['missing check', candidate => { candidate.checks = []; }],
    ['missing raw evidence', candidate => { candidate.checks[0].stdout = '[]'; }],
    ['missing environment conclusion', candidate => { candidate.checks[0].stdout = JSON.stringify(events.slice(0, 3)); }],
    ['unrealizable raw conclusion', candidate => {
      const raw = structuredClone(events); raw[1].result = 'unrealizable'; candidate.checks[0].stdout = JSON.stringify(raw);
    }],
    ['backend error exit', candidate => { candidate.checks[0].exit_code = 2; }],
    ['mismatched recorded conclusion', candidate => { candidate.checks[0].result = 'UNKNOWN'; }],
    ['mismatched report conclusion', candidate => { candidate.environment_result = 'unknown'; }]
  ]) {
    await t.test(`rejects ${name}`, () => {
      const candidate = structuredClone(report);
      change(candidate);
      assert.throws(() => assertCorrectedOutcome(candidate, true), assert.AssertionError);
    });
  }
});

test('the historical corpus preserves all 16 original job inputs and report digests', () => {
  assert.equal(historical.cases.length, 16);
  assert.equal(new Set(historical.cases.map(item => item.original.job_id)).size, 16);
  assert.equal(corrected.cases.length, 16);
  assert.equal(historical.cases.filter(item => item.original.report.result === 'invalid').length, 10);
  assert.equal(historical.cases.filter(item => item.original.report.result === 'error').length, 6);
  for (const { component, original, provenance } of historical.cases) {
    assert.equal(original.input.component, component);
    assert.equal(contentDigest(original.input), original.input_digest);
    assert.equal(original.report.input_digest, original.input_digest);
    assert.equal(contentDigest(original.report), original.report_digest);
    assert.equal(original.report.toolchain.fret, 'sha256:c45764cc1cc48928217709c243e3b800bddd47101d81254862dd1fdc4ac37ce4');
    assert.match(provenance.archive_sha256, /^sha256:[a-f0-9]{64}$/);
    assert.match(provenance.raw_output_sha256, /^sha256:[a-f0-9]{64}$/);
    assert.ok(provenance.session_id && provenance.part_id && provenance.message_id);
    for (const check of original.report.checks) assert.equal(contentDigest(check.lustre), check.lustre_digest);

    const candidate = corrected.cases.find(item => item.original_job_id === original.job_id);
    assert.ok(candidate, component);
    assert.ok(candidate.remaining_gaps.length, component);
    const restored = structuredClone(candidate.input);
    const changes = new Map(candidate.changes.map(change => [change.id, change]));
    assert.equal(changes.size, candidate.changes.length);
    for (const requirement of restored.requirements) {
      const change = changes.get(requirement.id);
      if (!change) continue;
      assert.equal(requirement.fretish, change.after);
      assert.notEqual(change.before, change.after);
      assert.ok(change.rationale.length);
      requirement.fretish = change.before;
      changes.delete(requirement.id);
    }
    assert.equal(changes.size, 0);
    assert.deepEqual(restored, original.input, 'Corrections may change only their explicitly documented FRETish clauses.');
  }
});

for (const { component, original } of historical.cases) {
  const candidate = corrected.cases.find(item => item.original_job_id === original.job_id);

  test(`historical original ${component}: public typed preflight rejects the exact failed clauses`, () => {
    const output = preflight(original.input);
    assert.deepEqual(output.results.map(item => item.id), original.report.requested_ids);
    assert.deepEqual(output.results.filter(item => item.status === 'invalid').map(item => item.id),
      candidate.changes.map(item => item.id));
    for (const result of output.results) {
      if (result.status === 'formalized') {
        assert.deepEqual(result.diagnostics, []);
        continue;
      }
      assert.equal(result.status, 'invalid', result.id);
      assert.deepEqual(result.formulas, []);
      if (original.report.result === 'invalid') {
        const archived = original.report.formalization.results.find(item => item.id === result.id);
        assert.deepEqual(result.diagnostics, archived.diagnostics);
      } else {
        assert.deepEqual(result.diagnostics.map(item => item.code), typeErrorColumns[result.id].map(() => 'type_error'));
        assert.deepEqual(result.diagnostics.map(item => item.location), typeErrorColumns[result.id].map(column => ({ line: 1, column })));
        for (const diagnostic of result.diagnostics) assert.match(diagnostic.message, /real, int|int, real/);
      }
    }
  });

  test(`historical corrected ${component}: every retained clause compiles through public declarations`, () => {
    const output = preflight(candidate.input);
    assert.deepEqual(output.results.map(item => item.id), original.report.requested_ids);
    for (const result of output.results) {
      assert.equal(result.status, 'formalized', JSON.stringify(result));
      assert.deepEqual(result.diagnostics, []);
      assert.deepEqual(result.formulas.map(item => item.representation), representations);
    }
  });

  test(`historical analysis ${component}: original stops before solving; corrected retains the complete contract`, linux, async t => {
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'fret-historical-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const rejected = await analyzeRequirements(original.input, directory);
    assert.equal(rejected.input_digest, original.input_digest);
    assert.equal(rejected.result, 'invalid');
    assert.deepEqual(rejected.checks, []);
    assert.deepEqual(rejected.analyzed_ids, []);
    assert.deepEqual(rejected.requested_ids, original.report.requested_ids);
    assert.deepEqual(rejected.formalization, preflight(original.input));

    const report = await analyzeRequirements(candidate.input, directory);
    t.diagnostic(JSON.stringify({ component, corrected_input_digest: report.input_digest, result: report.result,
      contract_result: report.contract_result, environment_result: report.environment_result,
      diagnostics: report.diagnostics, toolchain: report.toolchain,
      checks: report.checks.map(check => ({ result: check.result, lustre_digest: check.lustre_digest, exit_code: check.exit_code })) }));
    assert.equal(report.input_digest, contentDigest(candidate.input));
    assert.deepEqual(report.requested_ids, original.report.requested_ids);
    assert.deepEqual(report.formalization, preflight(candidate.input));
    assert.ok(report.checks.length, JSON.stringify(report.diagnostics));
    assert.deepEqual(report.checks[0].requirement_ids, original.report.requested_ids);
    for (const check of report.checks) {
      assert.equal(check.lustre_digest, contentDigest(check.lustre));
      assert.equal(check.command[0], 'kind2');
      assert.ok(check.stdout.length);
    }
    assert.deepEqual(report.analyzed_ids, original.report.requested_ids);
    // RMSprop's frozen 60-second run was unknown; a new run may establish
    // realizability, but only with explicit contract and environment evidence.
    assertCorrectedOutcome(report, component === 'RMSpropTFLikeNumerics');
  });
}
