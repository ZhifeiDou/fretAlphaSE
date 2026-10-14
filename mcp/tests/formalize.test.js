const assert = require('node:assert/strict');
const { test } = require('node:test');
const { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runInNewContext } = require('node:vm');
const { promisify } = require('node:util');
const { formalizeRequirements } = require('../dist/formalize.cjs');

test('checks declared types before simplifying or generating formulas', () => {
  const variables = [{ name: 'reward', type: 'real' }, { name: 'steps', type: 'int' }, { name: 'enabled', type: 'bool' }];
  for (const expression of [
    'reward = 0', 'reward = 1', 'reward = steps', 'reward = steps / 2',
    'reward + 1 > 0.0', 'steps + enabled = 1', 'enabled < enabled',
    'absReal(1) = reward', 'minInt(steps) = steps',
    'preReal(0, reward) = reward', 'ite(enabled, reward, reward)',
    '(true | (reward = 0))', 'reward', '!steps'
  ]) {
    const output = formalizeRequirements({
      requirements: [{ id: 'typed', fretish: `Controller shall always satisfy ${expression}` }],
      representations: ['pt-lustre', 'ft-inf'], variables
    });
    const result = output.results[0];
    assert.equal(result.status, 'invalid', expression);
    assert.deepEqual(result.formulas, [], expression);
    assert.equal(result.diagnostics[0].code, 'type_error', expression);
    assert.ok(result.diagnostics[0].location, expression);
  }
});

test('preserves numeric spelling and accepts well-typed operators and built-ins', () => {
  const variables = [{ name: 'reward', type: 'real' }, { name: 'steps', type: 'int' }, { name: 'enabled', type: 'bool' }];
  for (const expression of [
    'reward = 0.0', 'reward = 1.0', 'reward = -1.0', 'reward = 1e3',
    'reward = 1E-3', 'steps = 9007199254740993', 'steps / 2 = 1',
    'reward / 2.0 = 1.0', 'steps mod 2 = 0', '-steps <= 0',
    'enabled = enabled', 'enabled xor !enabled',
    'absReal(reward) >= 0.0', 'absInt(steps) >= 0',
    'maxReal(reward, 1.0) >= minReal(reward, 1.0)',
    'maxInt(steps, 1) >= minInt(steps, 1)',
    'preReal(0.0, reward) = reward', 'preInt(0, steps) = steps',
    'preBool(false, enabled)', 'ite(enabled, enabled, !enabled)',
    'persisted(2, enabled)', 'occurred(1, 2, enabled)'
  ]) {
    const request = {
      requirements: [{ id: 'typed', fretish: `Controller shall always satisfy ${expression}` }],
      representations: ['pt-lustre', 'ft-inf']
    };
    const checked = formalizeRequirements({ ...request, variables }).results[0];
    const unchecked = formalizeRequirements(request).results[0];
    assert.equal(checked.status, 'formalized', `${expression}: ${JSON.stringify(checked.diagnostics)}`);
    assert.deepEqual(checked, unchecked, expression);
  }
});

test('preserves legal symbols that share Object prototype names in every representation', () => {
  for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty',
    'propertyIsEnumerable', 'isPrototypeOf', 'toLocaleString']) {
    const request = {
      requirements: [{ id: name, fretish: `Controller shall always satisfy ${name} = 0` }],
      representations: ['ft-inf', 'ft-fin', 'pt-smv', 'pt-lustre']
    };
    for (const input of [request, { ...request, variables: [{ name, type: 'int' }] }]) {
      const result = formalizeRequirements(input).results[0];
      assert.equal(result.status, 'formalized', `${name}: ${JSON.stringify(result.diagnostics)}`);
      assert.deepEqual(result.diagnostics, []);
      assert.deepEqual(result.formulas, [
        { representation: 'ft-inf', formula: `(G (${name} = 0))` },
        { representation: 'ft-fin', formula: `(LAST V (${name} = 0))` },
        { representation: 'pt-smv', formula: `(H (${name} = 0))` },
        { representation: 'pt-lustre', formula: `H((${name} = 0))` }
      ]);
    }
    const mismatch = formalizeRequirements({ ...request, variables: [{ name, type: 'real' }] }).results[0];
    assert.equal(mismatch.status, 'invalid', name);
    assert.deepEqual(mismatch.formulas, []);
    assert.equal(mismatch.diagnostics[0].code, 'type_error', name);
    assert.match(mismatch.diagnostics[0].message, /real, int/);
  }
});

test('locates type errors in source conditions, including leading whitespace', () => {
  const variables = [{ name: 'reward', type: 'real' }, { name: 'enabled', type: 'bool' }];
  for (const [fretish, marker] of [
    ['\r\n  Controller shall\n    satisfy reward = 0', 'reward'],
    ['Whenever reward Controller shall satisfy enabled', 'reward'],
    ['In mode reward Controller shall satisfy enabled', 'reward'],
    ['While reward > 0 Controller shall satisfy enabled', 'reward'],
    ['Controller shall until reward satisfy enabled', 'reward']
  ]) {
    const { results: [result] } = formalizeRequirements({
      requirements: [{ id: 'location', fretish }], representations: ['pt-lustre'], variables
    });
    assert.equal(result.status, 'invalid', fretish);
    const diagnostic = result.diagnostics[0];
    assert.equal(diagnostic.code, 'type_error', fretish);
    const prefix = fretish.slice(0, fretish.indexOf(marker)).split('\n');
    assert.deepEqual(diagnostic.location, { line: prefix.length, column: prefix.at(-1).length + 1 }, fretish);
    assert.match(diagnostic.message, /reward/);
  }
});

test('keeps type environments local to each compilation and reports undeclared symbols', () => {
  const request = {
    requirements: [{ id: 'R1', fretish: 'Controller shall satisfy value = 1' }],
    representations: ['pt-lustre']
  };
  for (const [type, status] of [['real', 'invalid'], ['int', 'formalized'], ['bool', 'invalid'], ['int', 'formalized']]) {
    assert.equal(formalizeRequirements({ ...request, variables: [{ name: 'value', type }] }).results[0].status, status);
  }
  const result = formalizeRequirements({ ...request, variables: [] }).results[0];
  assert.equal(result.status, 'invalid');
  assert.equal(result.diagnostics[0].code, 'undeclared_variable');
  assert.match(result.diagnostics[0].message, /value/);
  assert.equal(formalizeRequirements(request).results[0].status, 'formalized');
});

test('distinguishes unavailable backend operations from type mismatches', () => {
  const variables = [{ name: 'value', type: 'int' }];
  for (const [expression, code] of [
    ['value ^ 2 = 4', 'unsupported_operator'],
    ['unknownFunction(value)', 'unsupported_function'],
    ['toString(value)', 'unsupported_function'],
    ['absInt() = value', 'type_error']
  ]) {
    const { results: [result] } = formalizeRequirements({
      requirements: [{ id: 'unsupported', fretish: `Controller shall satisfy ${expression}` }],
      representations: ['pt-lustre'], variables
    });
    assert.equal(result.status, 'invalid', expression);
    assert.deepEqual(result.formulas, [], expression);
    assert.equal(result.diagnostics[0].code, code, expression);
  }
});

test('empty declarations allow constant expressions and native predefined symbols', () => {
  for (const expression of ['true', '1 = 1', '1.0 = 1.0', 'FTP']) {
    const { results: [result] } = formalizeRequirements({
      requirements: [{ id: 'constant', fretish: `Controller shall satisfy ${expression}` }],
      representations: ['pt-lustre'], variables: []
    });
    assert.equal(result.status, 'formalized', expression);
    assert.deepEqual(result.diagnostics, []);
  }
});

test('typed batches reject every compiled component in a mixed scope without affecting untyped batches', () => {
  const requirements = [
    { id: 'one', fretish: 'Whenever enabled ControllerA shall satisfy value = 1' },
    { id: 'two', fretish: 'ControllerB shall always satisfy value = 2' },
    { id: 'bad', fretish: 'ControllerA shall satisfy @' }
  ];
  const variables = [{ name: 'enabled', type: 'bool' }, { name: 'value', type: 'int' }];
  for (const entries of [requirements, [...requirements].reverse()]) {
    const request = { requirements: entries, representations: ['pt-lustre'], variables };
    const snapshot = structuredClone(request);
    const { results } = formalizeRequirements(request);
    assert.deepEqual(request, snapshot);
    assert.deepEqual(results.map(result => result.id), entries.map(entry => entry.id));
    for (const result of results) {
      assert.equal(result.status, 'invalid');
      assert.deepEqual(result.formulas, []);
      assert.equal(result.diagnostics[0].code, result.id === 'bad' ? 'syntax_error' : 'component_mismatch');
      if (result.id !== 'bad') assert.equal(result.diagnostics[0].location, null);
    }
  }
  const { results } = formalizeRequirements({ requirements, representations: ['pt-lustre'] });
  assert.deepEqual(results.map(result => result.status), ['formalized', 'formalized', 'invalid']);
});

test('generates an invariant using the requested temporal logic and syntax', () => {
  const output = formalizeRequirements({
    requirements: [{ id: 'R1', fretish: 'Controller shall always satisfy enabled' }],
    representations: ['ft-inf', 'ft-fin', 'pt-smv', 'pt-lustre']
  });
  assert.equal(output.time_basis, 'discrete_steps');
  const result = output.results[0];
  assert.equal(result.status, 'formalized');
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.formulas, [
    { representation: 'ft-inf', formula: '(G enabled)' },
    { representation: 'ft-fin', formula: '(LAST V enabled)' },
    { representation: 'pt-smv', formula: '(H enabled)' },
    { representation: 'pt-lustre', formula: 'H(enabled)' }
  ]);
  assert.equal(result.explanation.format, 'html');
  assert.match(result.explanation.text, /enabled/);
});

test('does not report quoted free text as formalized', () => {
  const { results: [result] } = formalizeRequirements({
    requirements: [{ id: 'free', fretish: '"The controller should be useful."' }],
    representations: ['ft-inf']
  });
  assert.equal(result.status, 'not_formalized');
  assert.deepEqual(result.formulas, []);
  assert.equal(result.diagnostics[0].code, 'freeform_text');
});

test('rejects ambiguous request identity and unsupported representation choices', () => {
  const requirement = { id: 'R1', fretish: 'Controller shall always satisfy enabled' };
  assert.throws(() => formalizeRequirements({ requirements: [requirement, requirement], representations: ['ft-inf'] }), /Duplicate requirement id/);
  assert.throws(() => formalizeRequirements({ requirements: [requirement], representations: ['unknown'] }), /representations/);
  assert.throws(() => formalizeRequirements({ requirements: [requirement], representations: ['ft-inf', 'ft-inf'] }), /representations/);
});

test('preserves the distinction between a rising edge and a condition holding', () => {
  const output = formalizeRequirements({
    requirements: [
      { id: 'edge', fretish: 'When p Controller shall immediately satisfy q' },
      { id: 'holding', fretish: 'Whenever p Controller shall immediately satisfy q' }
    ],
    representations: ['pt-smv']
  });
  assert.deepEqual(output.results.map(result => result.formulas), [
    [{ representation: 'pt-smv', formula: '(H ((p & (Z (! p))) -> q))' }],
    [{ representation: 'pt-smv', formula: '(H (p -> q))' }]
  ]);
});

test('preserves the early-end case in finite bounded-response semantics', () => {
  const { results: [result] } = formalizeRequirements({
    requirements: [{ id: 'bounded', fretish: 'Whenever p Controller shall within 2 ticks satisfy q' }],
    representations: ['ft-fin', 'ft-inf']
  });
  assert.equal(result.status, 'formalized');
  assert.deepEqual(result.formulas, [
    { representation: 'ft-fin', formula: '(LAST V (p -> ((F[0,2] q) | (F[0,1] LAST))))' },
    { representation: 'ft-inf', formula: '(G (p -> (F[0,2] q)))' }
  ]);
});

test('reads scientific-notation durations without truncation or rounding', () => {
  for (const [number, decimal] of [
    ['1e3', '1000'],
    ['1E+3', '1000'],
    ['1.2e2', '120'],
    ['0.10e3', '100'],
    ['1.0e0', '1'],
    ['1e-1', '0.1'],
    ['1.234567890123456789e-1', '0.1234567890123456789']
  ]) {
    const { results: [scientific, expanded] } = formalizeRequirements({
      requirements: [
        { id: 'scientific', fretish: `Controller shall within ${number} ticks satisfy q` },
        { id: 'expanded', fretish: `Controller shall within ${decimal} ticks satisfy q` }
      ],
      representations: ['ft-inf', 'ft-fin', 'pt-smv', 'pt-lustre']
    });
    assert.equal(scientific.status, 'formalized', number);
    assert.equal(expanded.status, 'formalized', decimal);
    assert.deepEqual(scientific.formulas, expanded.formulas, number);
    assert.deepEqual(scientific.explanation, expanded.explanation, number);
  }
  const { results: [result] } = formalizeRequirements({
    requirements: [{ id: 'R1', fretish: 'Controller shall within 1e3 ticks satisfy q' }],
    representations: ['ft-inf']
  });
  assert.equal(result.formulas[0].formula, '(F[0,1000] q)');
});

test('keeps incomplete-text callers working after the duration parser change', async t => {
  const webpack = require('webpack');
  const config = require('../webpack.config.cjs');
  const directory = mkdtempSync(path.join(tmpdir(), 'fret-core-regression-'));
  const bundle = path.join(directory, 'core.cjs');
  t.after(() => {
    if (existsSync(bundle)) unlinkSync(bundle);
    rmdirSync(directory);
  });
  const compiler = webpack({
    ...config,
    entry: path.resolve(__dirname, '../../fret-electron/app/parser/FretSemantics.js'),
    output: { ...config.output, path: directory, filename: 'core.cjs' }
  });
  try {
    const stats = await promisify(compiler.run.bind(compiler))();
    assert.equal(stats.hasErrors() || stats.hasWarnings(), false, stats.toString());
    const { compilePartialText } = require(bundle);
    for (const text of ['Controller shall within', 'Controller shall within ticks satisfy q']) {
      const result = compilePartialText(text);
      assert.ok(result.parseErrors);
      assert.equal(result.collectedSemantics.duration, undefined);
    }
    const result = compilePartialText('Controller shall within 1e3 ticks satisfy q');
    assert.equal(result.parseErrors, undefined);
    assert.equal(result.collectedSemantics.duration, '1000');
  } finally {
    await promisify(compiler.close.bind(compiler))();
  }
});

for (const [name, fretish, location] of [
  ['leading spaces', '  Controller shall satisfy @', { line: 1, column: 28 }],
  ['leading CRLF', '\r\n  Controller shall satisfy @', { line: 2, column: 28 }],
  ['later input line', '  Controller shall\n   satisfy @', { line: 2, column: 12 }],
  ['leading tab', '\n\tController shall satisfy @', { line: 2, column: 27 }]
]) {
  test(`locates lexical errors in the original text: ${name}`, () => {
    const { results: [result] } = formalizeRequirements({
      requirements: [{ id: 'invalid', fretish }],
      representations: ['ft-inf']
    });
    assert.equal(result.status, 'invalid');
    assert.deepEqual(result.formulas, []);
    const diagnostic = result.diagnostics.find(item => item.message.includes("token recognition error at: '@'"));
    assert.ok(diagnostic);
    assert.deepEqual(diagnostic.location, location);
    assert.equal(fretish.split('\n')[location.line - 1][location.column - 1], '@');
  });
}

test('locates missing input at EOF, including all-whitespace input', () => {
  const { results } = formalizeRequirements({
    requirements: [
      { id: 'missing-response', fretish: '\n\tController shall satisfy' },
      { id: 'blank', fretish: '  \r\n' }
    ],
    representations: ['ft-inf']
  });
  assert.deepEqual(results.map(result => result.status), ['invalid', 'invalid']);
  assert.deepEqual(results.map(result => result.diagnostics[0].location), [
    { line: 2, column: 26 },
    { line: 2, column: 1 }
  ]);
});

test('keeps source errors without available positions explicitly unlocated', () => {
  const { results } = formalizeRequirements({
    requirements: [
      { id: 'reserved', fretish: 'Controller shall satisfy MODULE' },
      { id: 'trailing', fretish: 'Controller shall satisfy p trailing' },
      { id: 'probability', fretish: 'Controller shall with probability >= 1.5 eventually satisfy q' }
    ],
    representations: ['ft-inf']
  });
  for (const result of results) {
    assert.equal(result.status, 'invalid');
    assert.deepEqual(result.formulas, []);
    assert.equal(result.diagnostics[0].code, 'requirement_error');
    assert.equal(result.diagnostics[0].location, null);
  }
  assert.match(results[0].diagnostics[0].message, /reserved.*MODULE/);
  assert.match(results[1].diagnostics[0].message, /Trailing unparsed input/);
  assert.match(results[2].diagnostics[0].message, /Illegal probability: 1.5/);
});

test('does not silently discard a probability bound when returning LTL', () => {
  const { results: [result] } = formalizeRequirements({
    requirements: [{ id: 'probability', fretish: 'Controller shall with probability >= 0.9 eventually satisfy q' }],
    representations: ['ft-inf', 'pt-lustre']
  });
  assert.equal(result.status, 'not_formalized');
  assert.deepEqual(result.formulas, []);
  assert.equal(result.diagnostics[0].code, 'unsupported_representation');
  assert.match(result.diagnostics[0].message, /probabilistic/);
  assert.match(result.explanation.text, /0\.9/);
});

test('keeps each result bound to its input across failures and later calls', () => {
  const request = {
    requirements: [
      { id: 'before', fretish: 'Controller shall always satisfy alpha' },
      { id: 'bad', fretish: 'Controller shall satisfy @' },
      { id: 'quoted', fretish: '"Unformalized requirement"' },
      { id: 'after', fretish: 'Controller shall always satisfy omega' }
    ],
    representations: ['ft-inf']
  };
  const originalInput = structuredClone(request);
  const output = formalizeRequirements(request);
  const retainedOutput = structuredClone(output);
  assert.deepEqual(request, originalInput);
  assert.deepEqual(output.results.map(result => [result.id, result.status]), [
    ['before', 'formalized'], ['bad', 'invalid'], ['quoted', 'not_formalized'], ['after', 'formalized']
  ]);
  assert.equal(output.results[0].formulas[0].formula, '(G alpha)');
  assert.equal(output.results[3].formulas[0].formula, '(G omega)');
  formalizeRequirements({
    requirements: [{ id: 'later', fretish: 'Controller shall always satisfy delta' }],
    representations: ['pt-smv']
  });
  assert.deepEqual(output, retainedOutput);
});

test('validates the complete request before starting compilation', () => {
  const valid = { requirements: [{ id: 'R1', fretish: 'Controller shall satisfy p' }], representations: ['ft-inf'] };
  for (const request of [
    null, [], {},
    { ...valid, options: {} },
    { ...valid, representations: [] },
    { ...valid, representations: Array(1) },
    { ...valid, representations: ['__proto__'] },
    { ...valid, variables: null },
    { ...valid, variables: {} },
    { ...valid, variables: [null] },
    { ...valid, variables: [{ name: 'p' }] },
    { ...valid, variables: [{ name: 'p', type: 'Bool' }] },
    { ...valid, variables: [{ name: 'p', type: 'bool', role: 'output' }] },
    { ...valid, variables: [{ name: 'p', type: 'bool' }, { name: 'p', type: 'bool' }] },
    { ...valid, variables: [{ name: 'p', type: 'bool' }, { name: 'p', type: 'int' }] },
    ...['', ' ', '_p', '1p', 'p-q', 'p q', 'p\n'].map(name => ({ ...valid, variables: [{ name, type: 'bool' }] })),
    { ...valid, requirements: [] },
    { ...valid, requirements: [null] },
    { ...valid, requirements: [{ id: ' ', fretish: 'Controller shall satisfy p' }] },
    { ...valid, requirements: [{ id: 'R1', fretish: null }] },
    { ...valid, requirements: [{ id: 'R1', fretish: 'Controller shall satisfy p', options: {} }] }
  ]) {
    assert.throws(() => formalizeRequirements(request), TypeError);
  }
});

test('reports compiler exceptions as errors, with no fabricated source position', () => {
  // Only this failure-path test injects a compiler fault. Formula tests use FRET.
  const isolatedModule = { exports: {} };
  const constants = require('../../fret-electron/app/parser/Constants');
  runInNewContext(readFileSync(path.join(__dirname, '../src/formalize.js'), 'utf8'), {
    module: isolatedModule,
    require(name) {
      if (name.endsWith('/FretSemantics')) return { compile() { throw new Error('Injected compiler fault'); } };
      if (name.endsWith('/Constants')) return constants;
      if (name === './schemas') return require('../src/schemas');
      throw new Error(`Unexpected dependency: ${name}`);
    },
    Error
  });
  const output = isolatedModule.exports.formalizeRequirements({
    requirements: [{ id: 'fault', fretish: 'Controller shall always satisfy enabled' }],
    representations: ['ft-inf']
  });
  const result = JSON.parse(JSON.stringify(output.results[0]));
  assert.equal(result.status, 'error');
  assert.deepEqual(result.formulas, []);
  assert.deepEqual(result.diagnostics, [{
    code: 'computation_error', message: 'Error: Injected compiler fault', location: null
  }]);
});

test('runs the built artifact alone outside the checkout, including semantic tables', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'fret-formalize-'));
  const bundle = path.join(directory, 'formalize.cjs');
  t.after(() => {
    unlinkSync(bundle);
    rmdirSync(directory);
  });
  copyFileSync(path.join(__dirname, '../dist/formalize.cjs'), bundle);
  const child = spawnSync(process.execPath, ['--no-global-search-paths', '-e', `
    const fs = require('node:fs');
    const { formalizeRequirements } = require('./formalize.cjs');
    const request = JSON.parse(fs.readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify(formalizeRequirements(request)));
  `], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 10000,
    input: JSON.stringify({
      requirements: [
        { id: 'portable', fretish: 'Controller shall always satisfy enabled' },
        { id: 'probability', fretish: 'Controller shall with probability >= 0.9 eventually satisfy q' }
      ],
      representations: ['ft-inf', 'pt-lustre']
    })
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  const { results } = JSON.parse(child.stdout);
  assert.equal(results[0].status, 'formalized');
  assert.equal(results[0].formulas[0].formula, '(G enabled)');
  assert.equal(results[0].formulas[1].formula, 'H(enabled)');
  assert.equal(results[1].status, 'not_formalized');
  assert.deepEqual(readdirSync(directory), ['formalize.cjs']);
});
