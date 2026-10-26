const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const bundle = process.env.FRET_MCP_TEST_BUNDLE_DIR || path.resolve(__dirname, '../dist');
const { compileInvariant, analyzeRequirements } = require(path.join(bundle, 'analysis.cjs'));
const { formalizeRequirements } = require(path.join(bundle, 'formalize.cjs'));
const { analysisReport } = require('../src/schemas');
const models = require('./fixtures/pt-invariant-controller-models.json');
const linux = { skip: process.platform !== 'linux' && 'Pinned native backends run in the isolated Linux image.' };

function compiled(ptSmv, ftInf, variables = ['p', 'q', 'r']) {
  return compileInvariant({ ptSmv, ftInf, variables, ptLustre: 'original Lustre stays unchanged' });
}

test('invariant compilation uses complete AST matches and preserves unmatched formulas', () => {
  assert.deepEqual(compiled('H(p -> q)', 'G(p -> q)'), {
    formula: '(p => q)', relation: 'equivalent', rules: ['historical_current']
  });
  assert.deepEqual(compiled('((H (!p)) | (! (q S (q & p))))', 'G(p -> F !q)'), {
    formula: '(p => not (q))', relation: 'sufficient', rules: ['eventual_monitor_current']
  });
  for (const [past, future] of [
    ['H(p) trailing', 'G(p)'], ['H(p) @', 'G(p)'],
    ['H[0,2](p)', 'G(p)'], ['((H(p)) | q)', 'G(p | q)'],
    ['H(Y p)', 'G(p)'], ['H(And(p,q))', 'G(p & q)'],
    ['(H(!p) | !(q S (q & p)))', 'G(p -> F !q)'],
    ['((H (!p)) | (! (q S (q & r))))', 'G(p -> F !q)'],
    ['((H (!p)) | (! (q S (q & p))))', 'G(p -> F q)'],
    ['((H (!p)) | (! ((Y q) S ((Y q) & p))))', 'G(p -> F !q)']
  ]) {
    assert.deepEqual(compiled(past, future), {
      formula: 'original Lustre stays unchanged', relation: 'unsupported', rules: []
    }, past);
  }
  const names = ['Historically', 'Not', 'And'];
  const result = compiled('H(Historically -> (Not & And))', 'G(Historically -> (Not & And))', names);
  assert.equal(result.formula, '(Historically => (Not and And))');
  assert.equal(result.relation, 'equivalent');
});

test('both invariant laws preserve every finite prefix, including after a violated monitor recovers', () => {
  for (let length = 1; length <= 6; length++) {
    for (let trace = 0; trace < 4 ** length; trace++) {
      let noTrigger = true, since = false, oldPrefix = true, newPrefix = true;
      let historical = true, historicalPrefix = true, currentPrefix = true;
      for (let step = 0; step < length; step++) {
        const value = Math.floor(trace / 4 ** step) % 4;
        const trigger = Boolean(value & 1), response = Boolean(value & 2);
        noTrigger &&= !trigger;
        since = !response && (trigger || since);
        oldPrefix &&= noTrigger || !since;
        newPrefix &&= !trigger || response;
        assert.equal(oldPrefix, newPrefix, `eventual prefix ${length}/${trace}/${step}`);
        historical &&= response;
        historicalPrefix &&= historical;
        currentPrefix &&= response;
        assert.equal(historicalPrefix, currentPrefix, `historical prefix ${length}/${trace}/${step}`);
      }
    }
  }
  // This delayed response satisfies G(stop -> F !moving), but its first prefix
  // fails the stronger PT-invariant contract. Positive implication is one-way.
  const stop = [true, false], moving = [true, false];
  assert.ok(stop.every((trigger, i) => !trigger || moving.slice(i).some(value => !value)));
  assert.equal(!stop[0] || !moving[0], false);
});

test('the archived 14- and 15-clause models all have structurally proven relations without mutating input', () => {
  for (const model of models) {
    const before = structuredClone(model.input);
    const formalized = formalizeRequirements({
      requirements: model.input.requirements.map(({ id, fretish }) => ({ id, fretish })),
      variables: model.input.variables.map(({ name, type }) => ({ name, type })),
      representations: ['pt-lustre', 'pt-smv', 'ft-inf', 'ft-fin']
    });
    const results = formalized.results.map(item => {
      assert.equal(item.status, 'formalized');
      const formulas = Object.fromEntries(item.formulas.map(f => [f.representation, f.formula]));
      return compileInvariant({ ptSmv: formulas['pt-smv'], ptLustre: formulas['pt-lustre'],
        ftInf: formulas['ft-inf'], variables: model.input.variables.map(v => v.name) });
    });
    assert.equal(results.filter(r => r.relation === 'equivalent').length, model.expected_equivalent);
    assert.equal(results.filter(r => r.relation === 'sufficient').length, model.expected_sufficient);
    assert.ok(results.every(r => r.rules.length && !/\b(?:H|SI)\(/.test(r.formula)));
    assert.deepEqual(model.input, before);
  }
});

function request(guarantees, assumptions = [], names = ['p', 'q']) {
  return {
    request_id: randomUUID(), component: 'Controller',
    requirements: [
      ...assumptions.map((fretish, i) => ({ id: `guarantee_in_assumption_${i}`, kind: 'assumption', fretish, source_refs: ['source:environment'] })),
      ...guarantees.map((fretish, i) => ({ id: `assumption_in_guarantee_${i}`, kind: 'guarantee', fretish, source_refs: ['source:behavior'] }))
    ],
    variables: names.map((name, i) => ({ name, type: 'bool', role: i ? 'output' : 'input', meaning: `Signal ${name}` })),
    time_model: { kind: 'discrete_steps', description: 'One synchronous controller step.' },
    options: { timeout_ms: 5000, diagnose: true }
  };
}

async function analyzed(t, input) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'fret-invariant-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return analyzeRequirements(input, directory);
}

test('native analysis realizes both complete controller regressions and preserves compilation audit', linux, async t => {
  for (const model of models) {
    const started = process.hrtime.bigint();
    const report = await analyzed(t, structuredClone(model.input));
    t.diagnostic(JSON.stringify({ model: model.name, variables: model.input.variables.length,
      clauses: model.input.requirements.length, elapsed_ms: Number(process.hrtime.bigint() - started) / 1000000,
      adapter: report.toolchain.adapter, source_digest: report.toolchain.fret,
      bundle_sha256: createHash('sha256').update(fs.readFileSync(path.join(bundle, 'analysis.cjs'))).digest('hex'),
      contract_result: report.contract_result, environment_result: report.environment_result,
      native_checks: JSON.parse(report.checks[0].stdout).filter(e => e.objectType === 'realizabilityCheck')
        .map(e => ({ result: e.result, runtime: e.runtime })) }));
    assert.equal(report.result, 'realizable', JSON.stringify(report.diagnostics));
    assert.equal(report.contract_result, 'realizable');
    assert.equal(report.environment_result, 'realizable');
    assert.equal(report.compilation.relation, 'sufficient');
    assert.equal(report.compilation.clauses.length, model.input.requirements.length);
    assert.equal(report.checks[0].exit_code, 0);
    assert.equal(report.checks[0].requirement_ids.length, model.input.requirements.length);
    assert.deepEqual(report.formalization, formalizeRequirements({
      requirements: model.input.requirements.map(({ id, fretish }) => ({ id, fretish })),
      variables: model.input.variables.map(({ name, type }) => ({ name, type })),
      representations: ['pt-lustre', 'pt-smv', 'ft-inf', 'ft-fin']
    }));
    for (const clause of report.compilation.clauses) {
      const original = report.formalization.results.find(item => item.id === clause.id);
      assert.equal(clause.original_pt_lustre, original.formulas.find(f => f.representation === 'pt-lustre').formula);
    }
    const absent = structuredClone(report);
    delete absent.compilation;
    assert.throws(() => analysisReport.parse(absent), /compilation semantics/);
    const unsupported = structuredClone(report);
    unsupported.compilation.relation = 'unsupported';
    unsupported.checks = [];
    unsupported.analyzed_ids = [];
    assert.throws(() => analysisReport.parse(unsupported), /analysis verdict/);
    const changedRole = structuredClone(report);
    changedRole.compilation.clauses[0].kind = 'assumption';
    assert.throws(() => analysisReport.parse(changedRole), /explicit role/);
  }
});

test('unsupported timed/next contracts and stronger assumptions retain formulas and stop before solver', linux, async t => {
  for (const input of [
    request(['Whenever p Controller shall within 2 ticks satisfy q']),
    request(['Whenever p Controller shall at the next timepoint satisfy q']),
    request(['Controller shall always satisfy q'], ['Whenever p Controller shall eventually satisfy !p'])
  ]) {
    const report = await analyzed(t, input);
    assert.equal(report.result, 'unsupported');
    assert.equal(report.compilation.relation, 'unsupported');
    assert.deepEqual(report.checks, []);
    assert.deepEqual(report.analyzed_ids, []);
    assert.ok(report.diagnostics.some(d => d.code === 'unsupported_analysis_semantics'));
    assert.ok(report.formalization.results.every(r => r.status === 'formalized' && r.formulas.length === 4));
  }
});

test('explicit kinds and colliding variable names retain their roles through native compilation', linux, async t => {
  const input = request(['Whenever fret_v_1 Controller shall eventually satisfy fret_v_0'],
    ['Controller shall always satisfy !fret_v_1'], ['fret_v_1', 'fret_v_0']);
  const report = await analyzed(t, input);
  assert.equal(report.result, 'realizable');
  assert.deepEqual(report.compilation.clauses.map(c => [c.kind, c.relation]), [
    ['assumption', 'equivalent'], ['guarantee', 'sufficient']
  ]);
  assert.match(report.checks[0].lustre, /assume "fret_r_0"/);
  assert.match(report.checks[0].lustre, /guarantee "fret_r_1"/);
  assert.deepEqual(report.variable_mapping, { fret_v_0: 'fret_v_1', fret_v_1: 'fret_v_0' });
});

test('a raw negative sufficient contract cannot become a future-time conflict verdict', linux, async t => {
  const report = await analyzed(t, request([
    'Whenever p Controller shall eventually satisfy q',
    'Whenever p Controller shall eventually satisfy !q'
  ]));
  // Alternating q satisfies both future eventual responses for every input p.
  // Their invariant monitors instead require q and !q together on a trigger.
  assert.equal(report.contract_result, 'unrealizable');
  assert.equal(report.environment_result, 'realizable');
  assert.equal(report.result, 'unknown');
  assert.equal(report.checks[0].result, 'UNREALIZABLE');
  assert.equal(report.diagnosis.status, 'not_run');
  assert.deepEqual(report.diagnosis.conflicts, []);
  assert.ok(report.diagnostics.some(d => d.code === 'inconclusive_infinite_contract'));
  assert.throws(() => analysisReport.parse({ ...report, result: 'unrealizable' }), /negative sufficient/);
});

test('native model checking proves prefix equivalence and exposes non-equivalence of point values', linux, t => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'fret-prefix-equivalence-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'Equivalence.lus');
  fs.writeFileSync(file, `node H(x:bool) returns (y:bool); let y = x -> (x and pre y); tel
node SI(x,y:bool) returns (z:bool); let z = y and (x or (false -> pre z)); tel
node Equivalence(p,q:bool) returns (old_ok,new_ok,prefix_equivalent,pointwise_equal:bool);
let old_ok = H(not p) or not SI(p,not q); new_ok = not p or q;
prefix_equivalent = H(old_ok) = H(new_ok); pointwise_equal = old_ok = new_ok;
--%PROPERTY "prefix_equivalent" prefix_equivalent;
--%PROPERTY "pointwise_equal" pointwise_equal;
tel\n`);
  const result = spawnSync('kind2', ['--lus_main', 'Equivalence', '-json', '--enable', 'IC3QE', '--timeout', '5', file],
    { encoding: 'utf8', timeout: 8000 });
  assert.equal(result.error, undefined);
  const properties = JSON.parse(result.stdout).filter(event => event.objectType === 'property');
  const answers = Object.fromEntries(properties.map(p => [p.name, p.answer?.value]));
  assert.equal(answers.prefix_equivalent, 'valid');
  assert.equal(answers.pointwise_equal, 'falsifiable');
});
