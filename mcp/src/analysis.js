const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ejs = require('ejs');
const { compile } = require('../../fret-electron/app/parser/FretSemantics');
const { predefinedVars } = require('../../fret-electron/app/parser/Constants');
const { createContract } = require('../../fret-electron/analysis/contractBuilder');
const { runKind2 } = require('../../fret-electron/analysis/realizabilityCheck');
const DiagnosisEngine = require('../../fret-electron/analysis/DiagnosisEngine');
const { formalizeRequirements } = require('./formalize');
const { compileInvariant } = require('./invariant_compilation');
const { analysisInput, analysisReport, contentDigest } = require('./schemas');

// Use the same FRET templates as the desktop exporter, without its database or
// legacy template-loader dependency. No temporal semantics are reimplemented.
const templates = [
  require('../../fret-electron/support/CommonTemplates/LibraryOfOperators.ejs'),
  require('../../fret-electron/support/CommonTemplates/DelayOperators.ejs'),
  require('../../fret-electron/support/RealizabilityTemplates/kind2/ComponentSignature.ejs'),
  require('../../fret-electron/support/RealizabilityTemplates/kind2/InternalVariables.ejs'),
  require('../../fret-electron/support/RealizabilityTemplates/kind2/PropertyDefinitions.ejs')
].map(source => ejs.compile(source));

function renderContract(contract) {
  return templates.map(render => render({ ...contract, i: 0, j: 0 })).join('\n');
}

function backendVersions() {
  const version = (command, argument) => execFileSync(command, [argument], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 65536, windowsHide: true
  }).trim();
  const kind2 = version('kind2', '--version');
  const z3 = version('z3', '--version');
  if (!/^kind2 v2\.2\.0$/.test(kind2) || !/^Z3 version 4\.14\.1\b/.test(z3)) {
    throw new Error('This analysis adapter requires Kind 2 2.2.0 and Z3 4.14.1.');
  }
  return { fret: FRET_SOURCE_DIGEST, adapter: '0.4.0', kind2, z3 };
}

async function analyzeRequirements(request, workDirectory, progress = () => {}, execution = {}) {
  const input = analysisInput.parse(request);
  const deadline = execution.deadline_ns ? BigInt(execution.deadline_ns) :
    process.hrtime.bigint() + BigInt(input.options.timeout_ms) * 1000000n;
  const persist = async update => { await execution.persist?.(update); };
  const phase = async value => { progress(value); await persist({ phase: value }); };
  const variableTypes = new Map(input.variables.map(variable => [variable.name, variable.type]));
  const formalization = formalizeRequirements({ requirements: input.requirements.map(({ id, fretish }) => ({ id, fretish })),
    representations: ['pt-lustre', 'pt-smv', 'ft-inf', 'ft-fin'],
    variables: input.variables.map(({ name, type }) => ({ name, type })) });
  const report = {
    schema_version: 1, input_digest: contentDigest(input), result: 'invalid',
    contract_result: null, environment_result: null,
    requested_ids: input.requirements.map(item => item.id), analyzed_ids: [], diagnostics: [], formalization,
    toolchain: backendVersions(), time_model: input.time_model,
    compilation: { semantics: 'pt_invariant', source_semantics: 'ft_inf', relation: 'unsupported', clauses: [] },
    assumption_ids: input.requirements.filter(item => item.kind === 'assumption').map(item => item.id),
    guarantee_ids: input.requirements.filter(item => item.kind === 'guarantee').map(item => item.id),
    variable_mapping: {}, checks: [],
    diagnosis: { status: input.options.diagnose ? 'not_run' : 'not_requested', conflicts: [], message: null }
  };
  const diagnostic = (id, code, message) => report.diagnostics.push({ id, code, message });
  const semanticDiagnostics = [];
  const semanticDiagnostic = (id, code, message) => semanticDiagnostics.push({ id, code, message });
  for (const variable of input.variables) {
    if (predefinedVars.includes(variable.name)) {
      diagnostic(null, 'reserved_variable', `${variable.name} is reserved by FRET and cannot be declared as a product variable.`);
    }
  }
  const contract = createContract(input.variables.map((variable, index) => {
    const name = `fret_v_${index}`;
    report.variable_mapping[name] = variable.name;
    return { variable_name: name, idType: variable.role === 'input' ? 'Input' : 'Output',
      dataType: { bool: 'boolean', int: 'integer', real: 'double' }[variable.type] };
  }));
  contract.componentName = 'FretContract';
  contract.delays = [];
  const symbolMapping = new Map(Object.entries(report.variable_mapping).map(([generated, original]) => [original, generated]));
  const propertyIds = new Map();
  for (const [index, item] of input.requirements.entries()) {
    const result = formalization.results[index];
    const lustre = result.formulas.find(formula => formula.representation === 'pt-lustre');
    if (!lustre || ['invalid', 'error', 'not_formalized'].includes(result.status)) {
      if (result.diagnostics.length) {
        for (const value of result.diagnostics) diagnostic(item.id, value.code, value.message);
      } else diagnostic(item.id, result.status, 'No Lustre formula.');
      continue;
    }
    const semantics = compile(item.fretish, variableTypes).collectedSemantics;
    if (semantics.component_name !== input.component) {
      diagnostic(item.id, 'component_mismatch', 'FRETish component differs from the declared component.');
      continue;
    }
    const missing = semantics.variables.filter(name => !symbolMapping.has(name));
    if (missing.length) {
      diagnostic(item.id, 'undeclared_variables', `Declare these variables: ${missing.join(', ')}`);
      continue;
    }
    if (semantics.duration !== undefined) {
      const duration = Number(semantics.duration);
      if (!Number.isSafeInteger(duration) || duration < 0 || duration > 10000) {
        diagnostic(item.id, 'unsupported_duration', 'Analysis requires an integer duration of 0–10000 discrete steps (template expansion limit).');
        continue;
      }
      contract.delays.push(String(duration));
    }
    const optimized = compileInvariant({
      ptSmv: result.formulas.find(formula => formula.representation === 'pt-smv')?.formula,
      ptLustre: lustre.formula,
      ftInf: result.formulas.find(formula => formula.representation === 'ft-inf')?.formula,
      variables: variableTypes.keys()
    });
    report.compilation.clauses.push({ id: item.id, kind: item.kind, relation: optimized.relation,
      original_pt_lustre: lustre.formula, optimized_pt_lustre: optimized.formula, rules: optimized.rules });
    if (optimized.relation === 'unsupported') {
      semanticDiagnostic(item.id, 'unsupported_analysis_semantics',
        'The analysis compiler cannot establish the relation between this PT-invariant contract and its infinite-future formula. Formalization remains available.');
    } else if (item.kind === 'assumption' && optimized.relation !== 'equivalent') {
      semanticDiagnostic(item.id, 'unsupported_analysis_semantics',
        'An environment assumption must be equivalent to its infinite-future formula; a stronger PT assumption would restrict the source input domain.');
    }
    const reqid = `fret_r_${index}`;
    propertyIds.set(reqid, item.id);
    // Rename identifiers in the generated expression in one pass. Product IDs
    // and source prose are never inserted into executable Lustre or comments.
    const value = optimized.formula.replace(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g, (name, offset, formula) =>
      /^\s*\(/.test(formula.slice(offset + name.length)) ? name : symbolMapping.get(name) ?? (name === 'FTP' ? '__FTP' : name));
    contract.properties.push({ reqid, kind: item.kind, value,
      fullText: `${reqid}; PT-invariant; rules: ${optimized.rules.join(',') || 'none'}` });
  }
  contract.delays = [...new Set(contract.delays)].sort((a, b) => Number(a) - Number(b));
  if (report.diagnostics.length) {
    report.result = report.diagnostics.some(item => ['not_formalized', 'freeform_text', 'unsupported_representation',
      'unsupported_duration', 'unsupported_function', 'unsupported_operator'].includes(item.code)) ? 'unsupported' : 'invalid';
    return analysisReport.parse(report);
  }
  if (semanticDiagnostics.length) {
    report.result = 'unsupported';
    report.diagnostics.push(...semanticDiagnostics);
    return analysisReport.parse(report);
  }
  report.compilation.relation = report.compilation.clauses.some(item => item.relation === 'sufficient') ?
    'sufficient' : 'equivalent';
  const checkContract = async (filePath, engine, options) => {
    if (engine !== 'kind2') throw new Error('Only the pinned Kind 2 backend is supported.');
    const lustre = fs.readFileSync(filePath, 'utf8');
    const present = contract.properties.filter(item => new RegExp(`\\b${item.reqid}\\b`).test(lustre)).map(item => propertyIds.get(item.reqid));
    const sourceBytes = Buffer.from(lustre, 'utf8');
    const source = {
      name: path.basename(filePath), requirement_ids: present, toolchain: report.toolchain,
      lustre: sourceBytes.length > 1024 * 1024 ?
        new TextDecoder('utf-8', { ignoreBOM: true }).decode(sourceBytes.subarray(0, 1024 * 1024), { stream: true }) : lustre,
      lustre_digest: contentDigest(lustre), lustre_bytes: sourceBytes.length,
      lustre_truncated: sourceBytes.length > 1024 * 1024
    };
    const output = await runKind2(filePath, options, {
      cwd: workDirectory, deadline_ns: deadline.toString(),
      observe: evidence => persist({ check: { ...source, ...evidence } })
    });
    report.checks.push({ name: path.basename(filePath), requirement_ids: present,
      result: output.result, environment_result: output.environmentResult, lustre, lustre_digest: contentDigest(lustre), command: output.command,
      stdout: output.stdout, stderr: output.stderr, exit_code: output.exitCode,
      counterexample: { contract: output.traceInfo, environment: output.environmentTrace } });
    if (output.result === 'ERROR') throw new Error(output.error);
    return output;
  };
  const options = ['-json', '--enable', 'CONTRACTCK'];
  await phase('checking');
  try {
    const filePath = path.join(workDirectory, 'FretContract.lus');
    fs.writeFileSync(filePath, renderContract(contract), 'utf8');
    const output = await checkContract(filePath, 'kind2', options);
    report.contract_result = output.result.toLowerCase();
    report.environment_result = output.environmentResult.toLowerCase();
    report.result = report.contract_result;
    report.analyzed_ids = output.analysisStarted ? [...report.requested_ids] : [];
    if (report.environment_result === 'unrealizable') {
      report.result = 'invalid';
      diagnostic(null, 'unrealizable_environment', 'The declared environment assumptions are not realizable. The contract result cannot be used as successful evidence.');
    } else if (report.environment_result === 'unknown') {
      report.result = 'unknown';
      diagnostic(null, 'unknown_environment', 'The backend did not establish environment realizability.');
    }
    if (report.result === 'unrealizable' && report.compilation.relation === 'sufficient') {
      report.result = 'unknown';
      diagnostic(null, 'inconclusive_infinite_contract',
        'Kind 2 found the stronger PT-invariant contract unrealizable. This does not establish that the original infinite-future guarantees are unrealizable.');
      report.diagnosis.message = 'Conflict diagnosis is not inferred for the weaker infinite-future guarantees.';
    }
    if (report.result === 'realizable' && input.options.diagnose) report.diagnosis.status = 'not_needed';
    // Optional conflict diagnosis may run out of time. Persist the completed
    // primary check first, and await durable acknowledgement before starting it.
    await persist({ checkpoint: analysisReport.parse(report) });
    if (report.result === 'unrealizable' && input.options.diagnose) {
      await phase('diagnosing');
      const engine = new DiagnosisEngine(contract, 'kind2', options, { workDirectory, renderContract, checkContract });
      try {
        const [error, result] = await engine.main();
        if (error) report.diagnosis = { status: 'unknown', conflicts: [], message: String(error) };
        else if (result[0] !== 'UNREALIZABLE') throw new Error('Diagnosis disagrees with the original analysis.');
        else report.diagnosis = { status: 'completed', message: null,
          conflicts: result[1].Conflicts.map(conflict => conflict.Conflict.map(id => propertyIds.get(id))) };
      } catch (error) {
        report.diagnosis = { status: error.code === 'analysis_budget_exhausted' ? 'unknown' : 'error',
          conflicts: [], message: error.message };
      }
    }
  } catch (error) {
    report.result = error.code === 'analysis_budget_exhausted' ? 'unknown' : 'error';
    diagnostic(null, error.code === 'analysis_budget_exhausted' ? 'timeout' : 'backend_error', error.message);
  }
  return analysisReport.parse(report);
}

module.exports = { analyzeRequirements, backendVersions, renderContract, compileInvariant };
