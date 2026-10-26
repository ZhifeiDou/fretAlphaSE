const { z } = require('zod');
const { createHash } = require('node:crypto');

function contentDigest(value) {
  const bytes = typeof value === 'string' ? value : JSON.stringify(value, (key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
  return `sha256:${createHash('sha256').update(bytes, 'utf8').digest('hex')}`;
}

const representation = z.enum(['ft-inf', 'ft-fin', 'pt-smv', 'pt-lustre']);
const requestedRepresentations = z.array(representation).min(1).refine(
  values => new Set(values).size === values.length,
  'representations must be unique.'
);
const requirementId = z.string().refine(value => value.trim().length > 0, 'id must not be blank.');
const symbol = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/);
const variableDeclaration = z.strictObject({ name: symbol, type: z.enum(['bool', 'int', 'real']) });

const formalizeInput = z.strictObject({
  requirements: z.array(z.strictObject({ id: requirementId, fretish: z.string() })).min(1)
    .superRefine((requirements, context) => {
      const ids = new Set();
      requirements.forEach(({ id }, index) => {
        if (ids.has(id)) {
          context.addIssue({ code: 'custom', path: [index, 'id'], message: `Duplicate requirement id: ${id}.` });
        }
        ids.add(id);
      });
    }),
  representations: requestedRepresentations,
  variables: z.array(variableDeclaration).superRefine((variables, context) => {
    const names = new Set();
    variables.forEach(({ name }, index) => {
      if (names.has(name)) {
        context.addIssue({ code: 'custom', path: [index, 'name'], message: `Duplicate variable name: ${name}.` });
      }
      names.add(name);
    });
  }).optional()
});

const formalizeOutput = z.strictObject({
  representations: requestedRepresentations,
  time_basis: z.literal('discrete_steps'),
  results: z.array(z.strictObject({
    id: requirementId,
    status: z.enum(['formalized', 'partial', 'not_formalized', 'invalid', 'error']),
    formulas: z.array(z.strictObject({ representation, formula: z.string().min(1) })),
    explanation: z.strictObject({ format: z.literal('html'), text: z.string() }).nullable(),
    diagnostics: z.array(z.strictObject({
      code: z.string().min(1),
      message: z.string(),
      location: z.strictObject({ line: z.int().positive(), column: z.int().positive() }).nullable(),
      representation: representation.optional()
    }))
  })).min(1)
});

const text = z.string().refine(value => value.trim().length > 0, 'Text must not be blank.');
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const analysisInput = z.strictObject({
  request_id: z.uuid(),
  component: symbol,
  requirements: z.array(z.strictObject({
    id: requirementId,
    fretish: z.string(),
    kind: z.enum(['assumption', 'guarantee']),
    source_refs: z.array(text).min(1)
  })).min(1),
  variables: z.array(variableDeclaration.extend({
    role: z.enum(['input', 'output']),
    meaning: text
  })).min(1),
  time_model: z.strictObject({ kind: z.literal('discrete_steps'), description: text }),
  options: z.strictObject({
    timeout_ms: z.int().positive().max(3600000),
    diagnose: z.boolean()
  })
}).superRefine((input, context) => {
  for (const [field, key] of [['requirements', 'id'], ['variables', 'name']]) {
    const seen = new Set();
    input[field].forEach((item, index) => {
      if (seen.has(item[key])) context.addIssue({ code: 'custom', path: [field, index, key], message: 'Duplicate identity.' });
      seen.add(item[key]);
    });
  }
  if (!input.requirements.some(item => item.kind === 'guarantee')) {
    context.addIssue({ code: 'custom', path: ['requirements'], message: 'At least one guarantee is required.' });
  }
  if (!input.variables.some(item => item.role === 'output')) {
    context.addIssue({ code: 'custom', path: ['variables'], message: 'At least one system output is required.' });
  }
});

const analysisReference = z.strictObject({ job_id: z.uuid() });
const analysisCancellation = z.strictObject({
  job_id: z.uuid().optional(),
  request: analysisInput.optional()
}).superRefine((value, context) => {
  if ((value.job_id === undefined) === (value.request === undefined)) {
    context.addIssue({ code: 'custom', message: 'Supply exactly one of job_id or the exact analysis request.' });
  }
}).describe('Cancel by exactly one selector: job_id, or request containing the complete original analysis input.');
const analysisRead = analysisReference.extend({ snapshot_digest: digest.optional(), offset: z.int().nonnegative().optional() })
  .superRefine((value, context) => {
    if ((value.snapshot_digest === undefined) !== (value.offset === undefined)) {
      context.addIssue({ code: 'custom', message: 'Snapshot digest and byte offset must be supplied together.' });
    }
  });
const analysisToolchain = z.strictObject({ fret: text, adapter: text, kind2: text, z3: text });
const analysisReport = z.strictObject({
  schema_version: z.literal(1),
  input_digest: digest,
  result: z.enum(['realizable', 'unrealizable', 'unknown', 'invalid', 'unsupported', 'error']),
  contract_result: z.enum(['realizable', 'unrealizable', 'unknown']).nullable(),
  environment_result: z.enum(['realizable', 'unrealizable', 'unknown']).nullable(),
  requested_ids: z.array(requirementId),
  analyzed_ids: z.array(requirementId),
  diagnostics: z.array(z.strictObject({ id: requirementId.nullable(), code: text, message: text })),
  formalization: formalizeOutput,
  compilation: z.strictObject({
    semantics: z.literal('pt_invariant'), source_semantics: z.literal('ft_inf'),
    relation: z.enum(['equivalent', 'sufficient', 'unsupported']),
    clauses: z.array(z.strictObject({
      id: requirementId, kind: z.enum(['assumption', 'guarantee']),
      relation: z.enum(['equivalent', 'sufficient', 'unsupported']),
      original_pt_lustre: text, optimized_pt_lustre: text,
      rules: z.array(z.enum(['historical_current', 'eventual_monitor_current']))
    }))
  }).optional(),
  toolchain: analysisToolchain,
  time_model: analysisInput.shape.time_model,
  assumption_ids: z.array(requirementId),
  guarantee_ids: z.array(requirementId),
  variable_mapping: z.record(z.string(), z.string()),
  checks: z.array(z.strictObject({
    name: text, requirement_ids: z.array(requirementId), result: z.enum(['REALIZABLE', 'UNREALIZABLE', 'UNKNOWN', 'ERROR']),
    environment_result: z.enum(['REALIZABLE', 'UNREALIZABLE', 'UNKNOWN']).nullable(),
    lustre: text, lustre_digest: digest, command: z.array(z.string()),
    stdout: z.string(), stderr: z.string(), exit_code: z.int().nullable(), counterexample: z.unknown()
  })),
  diagnosis: z.strictObject({
    status: z.enum(['not_requested', 'not_run', 'not_needed', 'completed', 'unknown', 'error']),
    conflicts: z.array(z.array(requirementId).min(1)),
    message: z.string().nullable()
  })
}).superRefine((value, context) => {
  if (value.toolchain.adapter !== '0.4.0') return;
  const compilation = value.compilation;
  const problem = message => context.addIssue({ code: 'custom', path: ['compilation'], message });
  if (!compilation) { problem('FRET 0.4 reports require explicit compilation semantics.'); return; }
  if (compilation.relation === 'unsupported') {
    if (!['invalid', 'unsupported', 'error'].includes(value.result)) problem('Unsupported semantics cannot carry an analysis verdict.');
    if (value.checks.length || value.analyzed_ids.length) problem('Unsupported semantics must stop before analysis.');
    return;
  }
  const clauses = compilation.clauses;
  if (JSON.stringify(clauses.map(item => item.id)) !== JSON.stringify(value.requested_ids) ||
      clauses.some(item => item.kind === 'assumption' ? item.relation !== 'equivalent' : item.relation === 'unsupported') ||
      clauses.some(item => !(item.kind === 'assumption' ? value.assumption_ids : value.guarantee_ids).includes(item.id))) {
    problem('Supported compilation must cover every requested clause with a safe relation and its explicit role.');
  }
  const relation = clauses.some(item => item.relation === 'sufficient') ? 'sufficient' : 'equivalent';
  if (compilation.relation !== relation) problem('Aggregate compilation relation differs from its clauses.');
  if (compilation.relation === 'sufficient' &&
      (value.result === 'unrealizable' || value.diagnosis.conflicts.length ||
       (value.contract_result === 'unrealizable' && value.environment_result === 'realizable' && value.result !== 'unknown'))) {
    problem('A negative sufficient PT check cannot establish infinite-future unrealizability or conflicts.');
  }
});
const boundedUtf8 = limit => z.string().refine(value => Buffer.byteLength(value, 'utf8') <= limit,
  `Evidence exceeds its ${limit} byte limit.`);
const analysisCheckEvidence = z.strictObject({
  name: text.max(255), requirement_ids: z.array(requirementId), command: z.array(z.string()).max(128),
  started_at: z.iso.datetime().nullable(), finished_at: z.iso.datetime().nullable(), toolchain: analysisToolchain,
  lustre: boundedUtf8(1024 * 1024), lustre_digest: digest, lustre_bytes: z.int().nonnegative(),
  lustre_truncated: z.boolean(), stdout: boundedUtf8(65536), stderr: boundedUtf8(65536),
  stdout_truncated: z.boolean(), stderr_truncated: z.boolean(),
  exit_code: z.int().nullable(), signal: z.string().nullable(), output_complete: z.boolean()
}).superRefine((value, context) => {
  const captured = Buffer.byteLength(value.lustre, 'utf8');
  if (value.lustre_truncated ? captured >= value.lustre_bytes :
    captured !== value.lustre_bytes || contentDigest(value.lustre) !== value.lustre_digest) {
    context.addIssue({ code: 'custom', path: ['lustre'], message: 'Generated source evidence differs from its size/digest.' });
  }
  if (value.output_complete && (value.finished_at === null || value.signal !== null || value.exit_code === null)) {
    context.addIssue({ code: 'custom', path: ['output_complete'], message: 'Complete output requires an observed normal process exit.' });
  }
  if (value.finished_at === null && (value.exit_code !== null || value.signal !== null)) {
    context.addIssue({ code: 'custom', path: ['finished_at'], message: 'Unfinished check cannot claim a process exit.' });
  }
  if ((value.started_at === null) !== (value.command.length === 0) ||
      (value.started_at === null && (value.finished_at !== null || value.output_complete ||
        value.stdout.length || value.stderr.length || value.stdout_truncated || value.stderr_truncated))) {
    context.addIssue({ code: 'custom', path: ['started_at'], message: 'Prepared input cannot claim observed solver execution.' });
  }
});
const analysisDiagnostics = z.strictObject({
  last_phase: z.enum(['preparing', 'checking', 'diagnosing']), phase_started_at: z.iso.datetime(),
  last_check: analysisCheckEvidence.nullable(), checkpoint: analysisReport.nullable(),
  checkpoint_digest: digest.nullable()
}).superRefine((value, context) => {
  if (value.checkpoint === null ? value.checkpoint_digest !== null :
    value.checkpoint_digest !== contentDigest(value.checkpoint)) {
    context.addIssue({ code: 'custom', path: ['checkpoint_digest'], message: 'Checkpoint differs from its digest.' });
  }
});
const analysisStatus = z.strictObject({
  job_id: z.uuid(), request_id: z.uuid(), input_digest: digest,
  status: z.enum(['running', 'completed', 'cancelled', 'timed_out', 'interrupted', 'error']),
  phase: z.enum(['preparing', 'checking', 'diagnosing', 'finished']),
  created_at: z.iso.datetime(), finished_at: z.iso.datetime().nullable(),
  report_digest: digest.nullable(), report: analysisReport.nullable(),
  error: z.strictObject({ code: text, message: text }).nullable(),
  input: analysisInput,
  diagnostics: analysisDiagnostics
}).superRefine((job, context) => {
  const problem = (path, message) => context.addIssue({ code: 'custom', path, message });
  const ids = job.input.requirements.map(item => item.id);
  if (job.input_digest !== contentDigest(job.input)) problem(['input_digest'], 'Job input digest differs from its input.');
  if (job.status !== 'completed' && (job.report !== null || job.report_digest !== null)) {
    problem(['report'], 'Unfinished analysis cannot carry a final report.');
  }
  const checkpoint = job.diagnostics.checkpoint;
  if (job.status === 'completed' && checkpoint !== null) problem(['diagnostics', 'checkpoint'], 'Final report replaces the primary checkpoint.');
  if (job.diagnostics.last_phase === 'diagnosing' && job.status !== 'completed' && checkpoint?.result !== 'unrealizable') {
    problem(['diagnostics', 'last_phase'], 'Diagnosis requires a persisted unrealizable primary check.');
  }
  if (checkpoint && (checkpoint.input_digest !== job.input_digest ||
      JSON.stringify(checkpoint.requested_ids) !== JSON.stringify(ids) || checkpoint.checks.length !== 1 ||
      JSON.stringify(checkpoint.checks[0].requirement_ids) !== JSON.stringify(ids))) {
    problem(['diagnostics', 'checkpoint'], 'Checkpoint must bind the entire exact primary input.');
  }
  const checkIds = job.diagnostics.last_check?.requirement_ids ?? [];
  if (new Set(checkIds).size !== checkIds.length || checkIds.some(id => !ids.includes(id))) {
    problem(['diagnostics', 'last_check', 'requirement_ids'], 'Check evidence is outside the exact input.');
  }
});
const analysisView = z.strictObject({
  job_id: z.uuid(), request_id: z.uuid(), input_digest: digest,
  status: analysisStatus.shape.status, phase: analysisStatus.shape.phase,
  created_at: z.iso.datetime(), finished_at: z.iso.datetime().nullable(),
  last_phase: analysisDiagnostics.shape.last_phase, phase_started_at: z.iso.datetime(),
  snapshot: z.strictObject({ digest, bytes: z.int().positive(), page_bytes: z.literal(65536) }).nullable(),
  page: z.strictObject({ offset: z.int().nonnegative(), next_offset: z.int().positive().nullable(),
    text: boundedUtf8(65536) }).nullable()
}).superRefine((value, context) => {
  const running = value.status === 'running';
  if (running !== (value.finished_at === null) || running === (value.phase === 'finished') ||
      running !== (value.snapshot === null) || (running && value.page !== null)) {
    context.addIssue({ code: 'custom', message: 'Running/terminal analysis view metadata disagrees.' });
  }
  if (value.page && value.snapshot) {
    const next = value.page.offset + Buffer.byteLength(value.page.text, 'utf8');
    if (!value.page.text.length || value.page.offset >= value.snapshot.bytes || next > value.snapshot.bytes ||
        value.page.next_offset !== (next < value.snapshot.bytes ? next : null)) {
      context.addIssue({ code: 'custom', path: ['page'], message: 'Snapshot page does not advance its exact byte offset.' });
    }
  }
});

module.exports = { formalizeInput, formalizeOutput, analysisInput, analysisReference, analysisCancellation, analysisRead, analysisReport, analysisStatus,
  analysisCheckEvidence, analysisDiagnostics, analysisView, contentDigest };
