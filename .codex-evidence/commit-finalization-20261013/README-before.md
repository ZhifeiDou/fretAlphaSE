# FRET analysis MCP

This service exposes FRET computation over Streamable HTTP at `/mcp`:

| Tool | Purpose |
| --- | --- |
| `formalize_requirements` | Compile FRETish into temporal formulas, explanations and diagnostics. |
| `start_realizability_check` | Start a durable analysis of a single component, with optional conflict diagnosis. |
| `get_analysis` | Retrieve the caller's fixed input, job status and complete report. |
| `cancel_analysis` | Stop the caller's analysis worker and its solver process group. |

The implementation reuses FRET's parser, semantic tables, Lustre templates,
contract construction and diagnosis engine. It runs Kind 2 **2.2.0** with Z3
**4.14.1**. No Electron GUI or desktop database is opened. Requirements management,
trace evaluation and test generation are not exposed by these tools.

These tools give an Approver executable evidence about the submitted model.
They do not establish fidelity to the source requirement or correctness of an
implementation. AlphaSE must separately grant permissions, instruct its agents
to use the tools, and bind official evidence to exact candidate/upstream versions.
This repository does not change AlphaSE's prompts, artifact schema or approval gate.

## Build and deploy

The compiler can run locally with Node.js >= 22.17.0:

```powershell
Set-Location C:\fretAlphaSE\mcp
npm ci
npm run build
$env:MCP_FRET_FORGEJO_BASE_URL = 'http://127.0.0.1:8111'
$env:MCP_FRET_ROLES_CONFIG_PATH = 'C:\path\to\trusted-roles.toml'
npm start
```

Set the actual Forgejo address and roles file for the deployment. Without
`MCP_FRET_ANALYSIS_DIR`, the service supports compilation only. Analysis requires
Linux, the pinned backends, and writable persistent storage. Use the Docker image:

```text
docker build --file mcp/Dockerfile --tag alphase/fret-mcp:0.2.0 .
```

Build from the repository root. The image supports **Linux amd64**. Node is pinned
by image digest; Kind 2 and Z3 archives and their licenses are pinned by version
and SHA-256. The runtime runs as `node`, with production dependencies and five
bundles (`server`, `worker`, `formalize`, `analysis`, `analysis-worker`). Backends
are checked before the service starts listening. The image health check checks
the TCP listener; an authenticated MCP call also checks identity and permissions.

The service needs these deployment settings (adapt addresses/network to AlphaSE):

```yaml
services:
  fret-mcp:
    image: alphase/fret-mcp:0.2.0
    init: true
    stop_grace_period: 10s
    environment:
      MCP_FRET_FORGEJO_BASE_URL: ${FRET_FORGEJO_URL:?Set the reachable Forgejo URL}
      MCP_FRET_ROLES_CONFIG_PATH: /etc/alphase/config.toml
      MCP_FRET_RESOURCE_SERVER_URL: http://fret-mcp:8004/mcp
      MCP_FRET_ANALYSIS_DIR: /var/lib/fret-mcp
    ports:
      - "127.0.0.1:8768:8004"
    volumes:
      - ${FRET_ROLES_FILE:?Set the trusted config path}:/etc/alphase/config.toml:ro
      - fret_analysis_data:/var/lib/fret-mcp
volumes:
  fret_analysis_data:
```

Join the deployment network from which Forgejo is reachable. The named volume
preserves results across container replacement. A bind-mounted data directory
must be writable by UID 1000. Each store belongs to one service instance, enforced
by a SQLite exclusive lock. Node 22.17's built-in SQLite emits an experimental API
warning; the image fixes that Node version, and persistence/restart behavior is
tested. Store schema version is 1; an incompatible store fails startup.

## Authentication and permissions

Clients send `Authorization: Bearer <Forgejo token>` on every request. The service
validates it through Forgejo `GET /api/v1/user`. Forgejo supplies identity only;
requirements and solver results are not read from or written to Forgejo.
The verified login must be an enabled role plus a positive issue number, such as
`approver_8`. Permissions come from the operator-controlled TOML file:

```toml
[agents.roles.approver]
enabled = true
[agents.roles.approver.mcp]
allowed_tools = [
  "formalize_requirements",
  "start_realizability_check",
  "get_analysis",
  "cancel_analysis"
]
```

Grant the tools independently to author roles if desired. Unrelated AlphaSE
config fields are ignored. Restart to reload permissions. Caller-supplied role
fields are rejected. Tools outside a role's allowlist are neither discoverable
nor callable. A job belongs to the verified user ID and login, across MCP
sessions. Another Approver can submit its own analysis of the same fixed input;
it cannot read or cancel another identity's job.

Sessions are bound to the verified identity, and tokens are revalidated on every
request. Missing/invalid credentials return 401, unauthorized roles or another
user's session return 403, and unavailable Forgejo authentication returns 503.
There is no anonymous mode, cached-token fallback or OAuth login flow.

`POST /mcp` supports initialization, discovery and calls using SSE responses;
`DELETE /mcp` ends a session. `GET /mcp` returns 405. JSON-RPC batches and browser
Origin headers are rejected. Hostnames are restricted to loopback, the configured
bind host, and `MCP_FRET_RESOURCE_SERVER_URL`. HTTP JSON bodies are limited to
1 MiB, without compression. Inputs/outputs are available as schemas in `tools/list`.

## Formalization

```json
{
  "requirements": [{"id": "R1", "fretish": "Controller shall always satisfy enabled"}],
  "representations": ["ft-inf", "ft-fin", "pt-smv", "pt-lustre"]
}
```

`ft-inf` and `ft-fin` are future-time formulas over infinite/finite traces;
`pt-smv` and `pt-lustre` are past-time formulas in the named syntax. The response
has `representations`, `time_basis: "discrete_steps"`, and ordered `results`.
Each result retains its ID, formulas, explanation and diagnostics. Status is
`formalized`, `partial`, `not_formalized`, `invalid` or `error`. Quoted free text
and probabilistic requirements are not silently converted into ordinary LTL.
The invariant above produces `(G enabled)` and `H(enabled)` in the respective
infinite-future and Lustre representations.

Explanations contain FRET HTML, not sanitized UI markup. Error locations are
one-based lines and UTF-16 columns, or null when unavailable. Duplicate/blank
IDs, unsupported representations, extra fields and empty batches are rejected.
A formula is evidence of the encoded meaning; compilation is not analysis.

Supply optional `variables` to check declared types through the native compiler:

```json
{
  "requirements": [{"id": "R1", "fretish": "Controller shall always satisfy reward >= 0.0"}],
  "representations": ["ft-inf", "pt-lustre"],
  "variables": [{"name": "reward", "type": "real"}]
}
```

Each declaration has only `name` and `type` (`bool`, `int`, or `real`). Names use
letters, digits and underscores, starting with a letter. Duplicate names are
rejected even when their types agree. Supplying `variables`, including `[]`,
enables strict checking of source expressions before simplification: undeclared
variables, incompatible types and unsupported operations receive diagnostics.
An empty array declares no product variables; native constants and predefined
symbols retain their native meaning. There is no implicit int/real conversion
or rewriting of numeric literals. Omitting `variables` generates representations
without checking declared types.

A typed batch shares one declaration environment and must contain only one
FRETish component. Separate components require separate typed calls. A mixed
batch marks every successfully compiled component entry `invalid` with
`component_mismatch` and no formulas; entries with parse/type errors retain
those diagnostics. Untyped calls may still compile multiple components.
Declaration environments do not persist between calls or sessions.

`formalized` means that every requested representation was generated. Whether
declared types were checked depends on that call's actual input. Keep the full
request and response together; a status detached from its input is insufficient
evidence. Authors should pass the final candidate's real declarations and repeat
preflight after text or type changes. Successful typed compilation does not
establish analysis readiness (component, I/O, reserved symbols and duration
checks still apply), realizability, source fidelity, Requirement-to-Spec temporal
refinement, or implementation correctness. Official AlphaSE evidence remains
bound to the fixed candidate/upstream versions by Artifact's analysis workflow.
Author preflight cannot replace that evidence.

## Realizability and diagnosis

An analysis input is one immutable component model. For example, these two
requirements are individually realizable but conflict when considered together:

```js
const input = {
  request_id: crypto.randomUUID(), // persist before submitting; retry with the same value
  component: 'Controller',
  requirements: [
    { id: 'R1', fretish: 'Whenever p Controller shall within 2 ticks satisfy q',
      kind: 'guarantee', source_refs: ['approved-spec:R1@version-3'] },
    { id: 'R2', fretish: 'Controller shall always satisfy !q',
      kind: 'guarantee', source_refs: ['approved-spec:R2@version-2'] }
  ],
  variables: [
    { name: 'p', type: 'bool', role: 'input', meaning: 'Request from the environment' },
    { name: 'q', type: 'bool', role: 'output', meaning: 'Controller response' }
  ],
  time_model: { kind: 'discrete_steps', description: 'One controller evaluation per step.' },
  options: { timeout_ms: 30000, diagnose: true }
};
```

Use the official MCP client from the `mcp` package (set `FRET_CLIENT_TOKEN`):

```js
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { setTimeout: delay } = require('node:timers/promises');

async function analyze(input) {
  const client = new Client({ name: 'approver', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8768/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.FRET_CLIENT_TOKEN}` } }
  });
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(result.content[0].text);
    return result.structuredContent;
  };
  try {
    await client.connect(transport);
    let job = await call('start_realizability_check', input);
    while (job.status === 'running') {
      await delay(500);
      job = await call('get_analysis', { job_id: job.job_id });
    }
    return job;
  } finally {
    try { await transport.terminateSession(); } finally { await client.close(); }
  }
}
```

The tested example returns `completed`, report result `unrealizable`, and
`diagnosis.conflicts: [["R1", "R2"]]`, with backend deadlocking traces. `completed`
means computation finished, not that the model passed. Check the report result.

Assumptions use `kind: "assumption"`; ID spelling has no effect on their role.
At least one guarantee and one system output are required. Types are `bool`,
`int`, `real`, with explicit input/output roles. Source references and variable
meanings are retained as supplied; FRET does not verify their authority. All
requirements must name the declared component and all referenced variables must
be declared. User IDs are mapped to generated Lustre names, with the mapping
preserved in evidence. FRET built-in names such as `FTP` cannot be declared as
product variables. A missing formula, unsupported item or undeclared variable
prevents the whole set from being passed to the solver; no item is silently dropped.

Analysis type-checks the original FRETish expressions against those declarations
before formula simplification and solver execution. Boolean conditions must be
`bool`; arithmetic and numeric comparisons require matching `int` or `real`
operands (`mod` requires integers). Equality also accepts matching booleans.
There is no implicit integer-to-real conversion: a real `reward` must be compared
with `0.0` or `1.0`, not `0` or `1`. Decimal and exponent literals, including
`1e3`, have type `real`; integer spelling has type `int`. Numeric spelling and
generated formulas are not rewritten. Integer division retains type `int`.

Type errors produce `report.result: "invalid"`, per-requirement `type_error`
diagnostics and no backend checks or analyzed IDs. The report's `formalization`
retains the original requirement ID and one-based source line/column for each
diagnostic. The checker also validates existing built-in function signatures;
unavailable function signatures or scalar exponentiation are `unsupported` for
this analysis backend. Backend checks remain authoritative for generated Lustre.
The standalone `formalize_requirements` tool has no declared type environment:
its `formalized` status alone does not establish type correctness for analysis.

This adapter analyzes FRET's past-time Lustre contracts. It does not accept
arbitrary Lustre assignments, custom function implementations, internal variables,
external model imports, probabilistic analysis or component decomposition. Built-in
FRET functions also remain subject to backend type checking. An unsupported function
or type is an error, not an assumed truth. Durations must be integer values in
0?10000 steps, a limit on native template expansion. Physical-unit words do not
change the step interpretation; callers must establish sampling and convert units
before submitting. Neither timing parameters nor environment assumptions are invented.

The overall `report.result` is:

| Result | Meaning |
| --- | --- |
| `realizable` | Kind 2 established contract and environment realizability for this submitted model. |
| `unrealizable` | The contract is unrealizable under the submitted realizable environment. |
| `unknown` | A required backend check is inconclusive or timed out. |
| `invalid` | Invalid input/formalization, or an unrealizable environment assumption set. |
| `unsupported` | An input feature cannot be analyzed by this adapter. |
| `error` | Backend or adapter failure, with diagnostics. |

`contract_result` and `environment_result` retain the separate backend conclusions.
For impossible environment assumptions, a vacuously realizable contract cannot
produce an overall `realizable` result. This environment check does not establish
reachability of every individual requirement trigger. An assumption can still
exclude a trigger; Approver must assess whether it is justified by the source.

With `diagnose: true`, an unrealizable contract is passed to FRET's diagnosis
engine. It uses delta debugging and a hitting-set tree with every assumption held
fixed, returning inclusion-minimal conflicting guarantee sets. Any unknown/error
prevents `diagnosis.status: "completed"`. Diagnosis status is separate from the
already obtained contract result; an incomplete diagnosis cannot erase that result.

## Evidence and task lifecycle

Every job records the exact input, a canonical SHA-256 input digest, requested and
actually analyzed IDs, generated formulas, FRET source digest, adapter/backend
versions, declared time model, assumptions, variable mapping, and diagnostics.
Every backend check retains the generated Lustre and its digest, command, exit
code, stdout/stderr and raw contract/environment traces. Temporary file paths in
backend output describe the original execution; use the embedded Lustre/trace
content, not those paths, after workspace cleanup. The final report has its own
digest. Canonical JSON sorts object keys recursively, preserves array order and
string contents, and uses UTF-8; Lustre digests hash the exact UTF-8 text.

`request_id` is required for reliable retries after a lost submission response.
The same owner, request ID and input return the same job; different input under
that ID returns `request_conflict`. To rerun a cancelled or finished analysis,
submit a new request ID. There is no queue; exhausted capacity returns `busy`.

Analysis jobs use a separate Linux process group and a UUID workspace under the
configured data directory. The total wall-clock budget includes startup, model
preparation and all diagnosis queries. A worker has a 256 MiB V8 old-space limit,
which is not a total solver/OS memory limit. Use container resource limits for the
whole service when deploying it.

An analysis continues across HTTP disconnect, MCP cancellation of the submission
request, session deletion and reconnect. Use `cancel_analysis` to stop it.
Cancellation kills its worker/solver process group and waits for worker exit.
`SIGTERM`/`SIGINT` interrupt active jobs and close the store; an unexpected parent
disconnect terminates the worker group. Restart marks unfinished records
`interrupted`; it does not automatically rerun them. Container init reaps children.

Job states are `running`, `completed`, `cancelled`, `timed_out`, `interrupted`,
`error`. Running phases are `preparing`, `checking`, `diagnosing`; no fabricated
percentage is returned. Cancelled/timed-out/interrupted jobs have no final report.
Only a complete report is committed, before temporary workspace cleanup. Reports
are retained in SQLite without an automatic expiry; deleting the persistent
volume deletes that evidence. Never share one data directory between replicas.

Compilation calls keep their shorter lifecycle: timeout, MCP cancellation, lost
HTTP connection and session deletion terminate that call's worker. They are not
persisted analysis jobs. Tool invocation failures use `isError: true` and JSON
`{code, message}`; invalid FRETish or inconclusive computation is represented in
structured per-item/report results. Neither kind of failure means success.

| Environment variable | Default / purpose |
| --- | --- |
| `MCP_FRET_FORGEJO_BASE_URL` | Required; trusted Forgejo identity URL |
| `MCP_FRET_ROLES_CONFIG_PATH` | Required; trusted AlphaSE-format TOML |
| `MCP_FRET_HOST` / `MCP_FRET_PORT` | `127.0.0.1` / `8004`; image binds `0.0.0.0` |
| `MCP_FRET_RESOURCE_SERVER_URL` | Required for an all-interface bind |
| `MCP_FRET_AUTH_TIMEOUT_MS` | `5000` per identity lookup |
| `MCP_FRET_TIMEOUT_MS` / `MCP_FRET_MAX_WORKERS` | `30000` / `2` for compilation |
| `MCP_FRET_ANALYSIS_DIR` | Unset locally; image uses `/var/lib/fret-mcp` |
| `MCP_FRET_ANALYSIS_TIMEOUT_MS` | `900000`; maximum accepted total analysis budget |
| `MCP_FRET_MAX_ANALYSES` | `2` analysis jobs, separate from compilation slots |
| `MCP_FRET_MAX_SESSIONS` / `MCP_FRET_SESSION_IDLE_MS` | `128` / `900000` |

Input `timeout_ms` cannot exceed the server limit or 3600000 ms. Kind 2 output per
invocation is bounded to 16 MiB; exceeding it is an error, with no successful result.
These execution limits describe tool scope and do not weaken a product requirement.

## Verification

`npm test` builds all bundles and runs compiler, core diagnosis and MCP tests.
Linux-only analysis tests skip on Windows; run them against the production image
with the test/source directories mounted read-only. For example, from the root:

```powershell
docker run --rm --init --network none `
  --mount "type=bind,source=$PWD/mcp/tests,target=/opt/fret-mcp/tests,readonly" `
  --mount "type=bind,source=$PWD/mcp/src,target=/opt/fret-mcp/src,readonly" `
  alphase/fret-mcp:0.2.0 node --test `
  tests/analysis.test.js tests/analysis-lifecycle.test.js tests/mcp.test.js `
  tests/historical-models.test.js
```

These tests run real FRET, Kind 2 and Z3 for realizability, temporal conflicts,
assumptions, malformed/unsupported input and backend timeout. They exercise real
MCP submission/reconnect/retrieval and role/ownership checks. Lifecycle tests use
controlled busy/crashing workers for deterministic child-process cancellation,
slot release, isolation, mismatched-result rejection and restart recovery.
Authentication uses a controlled Forgejo HTTP fixture, not an AlphaSE deployment.
They do not run the AlphaSE workflow, a benchmark, or Electron UI.

The historical regression freezes 16 complete failed inputs/reports in
`tests/fixtures/historical-failed-models.json`, with archive identities and
digests. `historical-corrected-models.json` separately records each explicit
text correction, its rationale, and remaining semantic gaps. Original models,
declarations, I/O, thresholds and all 38 clauses are retained; only the listed
syntax and type-compatible literal corrections change the candidate texts.
These candidates preserve archived request IDs for comparison. A new durable
MCP analysis must use a fresh `request_id` for a corrected input.

The 2026-10-04 typed-preflight validation used a newly built isolated image,
Kind 2 2.2.0 and Z3 4.14.1. All 16 originals were rejected before contract
solving; the six former backend type failures now have source type diagnostics.
All 16 corrected models compiled. Actual backend replay proved 15 realizable;
`RMSpropTFLikeNumerics` returned `unknown` at its unchanged 60-second timeout
(exit 30), with contract and environment results unresolved. Its full nonlinear
formulas remain intact. Regression tests distinguish that inconclusive outcome
from successful proof and backend errors. This does not establish source
fidelity or implementation correctness, and is not AlphaSE Agent acceptance.
