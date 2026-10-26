const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { AnalysisJobs } = require('../src/analysis_jobs');
const { analysisCancellation, contentDigest } = require('../src/schemas');
const { version } = require('../package.json');

const linux = { skip: process.platform !== 'linux' && 'Analysis process groups require Linux.' };
const owner = { subject: 10, login: 'approver_5' };
const other = { subject: 11, login: 'approver_6' };
const request = (id = 'busy') => ({
  request_id: randomUUID(), component: 'Controller',
  requirements: [{ id, fretish: 'Controller shall always satisfy q', kind: 'guarantee', source_refs: ['source:1'] }],
  variables: [{ name: 'q', type: 'bool', role: 'output', meaning: 'Controlled output' }],
  time_model: { kind: 'discrete_steps', description: 'One evaluation per step.' },
  options: { timeout_ms: 10000, diagnose: false }
});

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { assert.ok(Date.now() < deadline, message); await delay(10); }
}

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'fret-cancel-test-'));
  const marker = path.join(directory, 'workers.jsonl');
  const worker = path.join(directory, 'worker.cjs');
  // This worker exercises persistence and OS process lifetime only. It never
  // compiles a model or invokes a solver, and its completed report says invalid.
  fs.writeFileSync(worker, `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const { contentDigest } = require(${JSON.stringify(path.resolve(__dirname, '../src/schemas'))});
    process.once('message', ({ input }) => {
      if (input.requirements[0].id.startsWith('complete')) {
        fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify([process.pid]) + '\\n');
        const report = {
          schema_version: 1, input_digest: contentDigest(input), result: 'invalid',
          contract_result: null, environment_result: null,
          requested_ids: input.requirements.map(item => item.id), analyzed_ids: [], diagnostics: [],
          formalization: { representations: ['pt-lustre'], time_basis: 'discrete_steps',
            results: input.requirements.map(item => ({ id: item.id, status: 'invalid',
              formulas: [], explanation: null, diagnostics: [] })) },
          compilation: { semantics: 'pt_invariant', source_semantics: 'ft_inf', relation: 'unsupported', clauses: [] },
          toolchain: { fret: 'sha256:' + 'a'.repeat(64), adapter: ${JSON.stringify(version)},
            kind2: 'controlled test worker', z3: 'not invoked' },
          time_model: input.time_model,
          assumption_ids: input.requirements.filter(item => item.kind === 'assumption').map(item => item.id),
          guarantee_ids: input.requirements.filter(item => item.kind === 'guarantee').map(item => item.id),
          variable_mapping: {}, checks: [],
          diagnosis: { status: 'not_requested', conflicts: [], message: null }
        };
        if (input.requirements[0].id === 'complete-legacy') {
          report.toolchain.adapter = '0.3.0';
          delete report.compilation;
        }
        process.send({ report }, () => process.disconnect());
      } else {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify([process.pid, child.pid]) + '\\n');
        setInterval(() => {}, 1000);
      }
    });
  `);
  const settings = { analysisDirectory: path.join(directory, 'analyses'), analysisWorkerPath: worker, ...options };
  const jobs = new AnalysisJobs(settings);
  t.after(async () => { await jobs.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { jobs, settings, directory, marker };
}

function readSnapshot(jobs, view, caller = owner) {
  assert.notEqual(view.status, 'running');
  assert.ok(view.snapshot);
  const pieces = [];
  let offset = 0;
  while (offset !== null) {
    const page = jobs.read({ job_id: view.job_id, snapshot_digest: view.snapshot.digest, offset }, caller);
    assert.equal(page.job_id, view.job_id);
    assert.equal(page.request_id, view.request_id);
    assert.equal(page.input_digest, view.input_digest);
    assert.deepEqual(page.snapshot, view.snapshot);
    assert.equal(page.page.offset, offset);
    pieces.push(Buffer.from(page.page.text, 'utf8'));
    offset = page.page.next_offset;
  }
  const bytes = Buffer.concat(pieces);
  assert.equal(bytes.length, view.snapshot.bytes);
  assert.equal(contentDigest(bytes.toString('utf8')), view.snapshot.digest);
  return JSON.parse(bytes.toString('utf8'));
}

async function stopped(pids) {
  for (const pid of pids) {
    await waitUntil(() => {
      try { process.kill(pid, 0); return false; }
      catch (error) { assert.equal(error.code, 'ESRCH'); return true; }
    }, `controlled process ${pid} survived cancellation`);
  }
}

test('cancellation requires exactly one complete selector', () => {
  const input = request();
  assert.equal(analysisCancellation.safeParse({ job_id: randomUUID() }).success, true);
  assert.equal(analysisCancellation.safeParse({ request: input }).success, true);
  for (const selector of [{}, { job_id: randomUUID(), request: input },
    { request: { request_id: input.request_id } }, { request: input, unknown: true }]) {
    assert.equal(analysisCancellation.safeParse(selector).success, false);
  }
});

test('cancellation before start is durable, exact, and absorbs a late start without a worker', linux, async t => {
  const { jobs, settings, marker } = fixture(t);
  const input = request();
  input.time_model.description = 'Exact source 😀 é '.repeat(6000);
  const original = structuredClone(input);
  const pending = jobs.cancel({ request: input }, owner);
  input.requirements[0].fretish = 'mutated after cancellation';
  const late = jobs.start(original, owner);
  const cancelled = await pending;
  assert.deepEqual(late, cancelled);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.phase, 'finished');
  assert.equal(cancelled.error.code, 'cancelled_before_start');
  assert.equal(cancelled.report, null);
  assert.equal(cancelled.report_digest, null);
  assert.equal(cancelled.diagnostics.last_check, null);
  assert.equal(cancelled.diagnostics.checkpoint, null);
  assert.equal(jobs.active.size, 0);
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(fs.readdirSync(path.join(settings.analysisDirectory, 'work')), []);
  const view = jobs.read({ job_id: cancelled.job_id }, owner);
  assert.ok(view.snapshot.bytes > 65536);
  assert.deepEqual(readSnapshot(jobs, view).input, original);
  assert.equal(view.input_digest, contentDigest(original));
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  assert.deepEqual(await jobs.cancel({ request: reordered }, owner), cancelled);
  assert.deepEqual(jobs.read({ job_id: cancelled.job_id }, owner), view);
});

test('an unstarted request can be cancelled while every execution slot is occupied', linux, async t => {
  const { jobs, marker } = fixture(t, { maxAnalyses: 1 });
  const busy = jobs.start(request(), owner);
  await waitUntil(() => fs.existsSync(marker), 'controlled worker did not start');
  const input = request('unstarted');
  assert.throws(() => jobs.start(input, owner), { code: 'busy' });
  const cancelled = await jobs.cancel({ request: input }, owner);
  assert.equal(cancelled.error.code, 'cancelled_before_start');
  assert.equal(jobs.active.size, 1);
  assert.equal(jobs.get(busy.job_id, owner).status, 'running');
  assert.equal(jobs.start(input, owner).job_id, cancelled.job_id);
  assert.equal(fs.readFileSync(marker, 'utf8').trim().split('\n').length, 1);
});

test('lost start acknowledgement cancels by exact request and waits for processes and capacity', linux, async t => {
  const { jobs, marker } = fixture(t, { maxAnalyses: 1 });
  const input = request();
  jobs.start(input, owner); // The caller did not receive or persist its job_id.
  await waitUntil(() => fs.existsSync(marker), 'controlled worker did not start');
  const pids = JSON.parse(fs.readFileSync(marker, 'utf8').trim());
  const same = jobs.findRequest(input, owner);
  const [cancelled, repeated] = await Promise.all([
    jobs.cancel({ request: input }, owner), jobs.cancel({ job_id: same.job_id }, owner)
  ]);
  assert.equal(cancelled.job_id, same.job_id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.error.code, 'cancelled');
  assert.equal(cancelled.report, null);
  assert.deepEqual(repeated, cancelled);
  assert.equal(jobs.active.size, 0, 'cancel acknowledgement must follow slot release');
  await stopped(pids);
  const view = jobs.read({ job_id: cancelled.job_id }, owner);
  assert.deepEqual(readSnapshot(jobs, view), cancelled);
  const next = jobs.start(request('next'), owner);
  assert.equal(next.status, 'running');
  await jobs.cancel({ job_id: next.job_id }, owner);
});

test('a completed result wins a later cancellation and retains the same snapshot', linux, async t => {
  const { jobs } = fixture(t);
  const input = request('complete');
  const running = jobs.start(input, owner);
  await waitUntil(() => jobs.get(running.job_id, owner).status !== 'running', 'controlled completion did not persist');
  const completed = jobs.get(running.job_id, owner);
  assert.equal(completed.status, 'completed', JSON.stringify(completed.error));
  assert.equal(completed.report.result, 'invalid');
  const view = jobs.read({ job_id: completed.job_id }, owner);
  const [byRequest, byId] = await Promise.all([
    jobs.cancel({ request: input }, owner), jobs.cancel({ job_id: completed.job_id }, owner)
  ]);
  assert.deepEqual(byRequest, completed);
  assert.deepEqual(byId, completed);
  assert.deepEqual(jobs.start(input, owner), completed);
  assert.deepEqual(jobs.read({ job_id: completed.job_id }, owner), view);
  assert.deepEqual(readSnapshot(jobs, view), completed);
});

test('cancellation binds owner and exact canonical input without stopping another owner', linux, async t => {
  const { jobs, marker } = fixture(t);
  const input = request();
  const running = jobs.start(input, owner);
  await waitUntil(() => fs.existsSync(marker), 'controlled worker did not start');
  await assert.rejects(jobs.cancel({ request: { ...input, component: 'Changed' } }, owner), { code: 'request_conflict' });
  assert.equal(jobs.get(running.job_id, owner).status, 'running');
  await assert.rejects(jobs.cancel({ job_id: running.job_id }, other), { code: 'analysis_not_found' });
  const separate = await jobs.cancel({ request: input }, other);
  assert.notEqual(separate.job_id, running.job_id);
  assert.equal(separate.error.code, 'cancelled_before_start');
  assert.equal(jobs.get(running.job_id, owner).status, 'running');
  assert.throws(() => jobs.get(separate.job_id, owner), { code: 'analysis_not_found' });
  assert.throws(() => jobs.start({ ...input, component: 'Changed' }, other), { code: 'request_conflict' });
  const cancelled = await jobs.cancel({ request: input }, owner);
  await assert.rejects(jobs.cancel({ request: { ...input, component: 'Changed' } }, owner), { code: 'request_conflict' });
  assert.equal(cancelled.job_id, running.job_id);
});

test('cancelled-before-start snapshots survive restart and still absorb delayed submission', linux, async t => {
  const { jobs, settings, marker } = fixture(t);
  const input = request();
  const cancelled = await jobs.cancel({ request: input }, owner);
  const view = jobs.read({ job_id: cancelled.job_id }, owner);
  await jobs.close();
  const restarted = new AnalysisJobs(settings);
  try {
    assert.deepEqual(restarted.get(cancelled.job_id, owner), cancelled);
    assert.deepEqual(restarted.read({ job_id: cancelled.job_id }, owner), view);
    assert.deepEqual(readSnapshot(restarted, view).input, input);
    assert.deepEqual(restarted.start(input, owner), cancelled);
    assert.deepEqual(await restarted.cancel({ request: input }, owner), cancelled);
    assert.equal(restarted.active.size, 0);
    assert.equal(fs.existsSync(marker), false);
  } finally { await restarted.close(); }
});

test('cancellation does not require an execution timeout budget or allocate a slot', linux, async t => {
  const { jobs, marker } = fixture(t, { analysisTimeoutMs: 1 });
  const input = request();
  assert.throws(() => jobs.start(input, owner), { code: 'timeout_limit' });
  const cancelled = await jobs.cancel({ request: input }, owner);
  assert.equal(cancelled.error.code, 'cancelled_before_start');
  assert.deepEqual(jobs.start(input, owner), cancelled);
  assert.equal(jobs.active.size, 0);
  assert.equal(fs.existsSync(marker), false);
});


test('historical 0.3 completed snapshots remain readable without metadata injection or rehashing', linux, async t => {
  const { jobs, settings } = fixture(t);
  const input = request('complete-legacy');
  const running = jobs.start(input, owner);
  await waitUntil(() => jobs.get(running.job_id, owner).status !== 'running', 'legacy fixture did not complete');
  const completed = jobs.get(running.job_id, owner);
  assert.equal(completed.status, 'completed', JSON.stringify(completed.error));
  assert.equal(completed.report.toolchain.adapter, '0.3.0');
  assert.equal(Object.hasOwn(completed.report, 'compilation'), false);
  const view = jobs.read({ job_id: completed.job_id }, owner);
  const original = jobs.db.prepare('SELECT data FROM jobs WHERE id=?').get(completed.job_id).data;
  await jobs.close();
  const restarted = new AnalysisJobs(settings);
  try {
    assert.deepEqual(restarted.get(completed.job_id, owner), completed);
    assert.deepEqual(restarted.read({ job_id: completed.job_id }, owner), view);
    assert.deepEqual(readSnapshot(restarted, view), completed);
    assert.deepEqual(await restarted.cancel({ request: input }, owner), completed);
    assert.equal(restarted.db.prepare('SELECT data FROM jobs WHERE id=?').get(completed.job_id).data, original);
  } finally { await restarted.close(); }
});


test('failed worker-start persistence cannot acknowledge a running record as cancelled', linux, async t => {
  const { jobs, settings } = fixture(t);
  const input = request();
  const mkdir = fs.mkdirSync;
  t.mock.method(fs, 'mkdirSync', (directory, ...args) => {
    if (path.dirname(directory) === jobs.workRoot) throw new Error('controlled workspace creation failure');
    return mkdir(directory, ...args);
  });
  t.mock.method(jobs, 'save', () => { throw new Error('controlled terminal persistence failure'); });
  assert.throws(() => jobs.start(input, owner), /controlled terminal persistence failure/);
  t.mock.restoreAll();
  await assert.rejects(jobs.cancel({ request: input }, owner), { code: 'storage_error' });
  await jobs.close();
  const restarted = new AnalysisJobs(settings);
  try {
    const recovered = await restarted.cancel({ request: input }, owner);
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.error.code, 'service_restarted');
    assert.equal(recovered.report, null);
    assert.equal(restarted.active.size, 0);
  } finally { await restarted.close(); }
});
