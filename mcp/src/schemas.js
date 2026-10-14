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
  toolchain: z.strictObject({ fret: text, adapter: text, kind2: text, z3: text }),
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
});
const analysisStatus = z.strictObject({
  job_id: z.uuid(), request_id: z.uuid(), input_digest: digest,
  status: z.enum(['running', 'completed', 'cancelled', 'timed_out', 'interrupted', 'error']),
  phase: z.enum(['preparing', 'checking', 'diagnosing', 'finished']),
  created_at: z.iso.datetime(), finished_at: z.iso.datetime().nullable(),
  report_digest: digest.nullable(), report: analysisReport.nullable(),
  error: z.strictObject({ code: text, message: text }).nullable(),
  input: analysisInput
});

module.exports = { formalizeInput, formalizeOutput, analysisInput, analysisReference, analysisReport, analysisStatus, contentDigest };
