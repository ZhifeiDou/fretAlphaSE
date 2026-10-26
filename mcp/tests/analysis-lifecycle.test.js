const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { AnalysisJobs } = require('../src/analysis_jobs');
const { contentDigest } = require('../src/schemas');

const linux = { skip: process.platform !== 'linux' && 'Analysis process groups require Linux.' };
const owner = { subject: 10, login: 'approver_5' };
const other = { subject: 11, login: 'approver_6' };
const workerPath = path.resolve(__dirname, '../dist/analysis-worker.cjs');
const request = (id = 'R1', text = 'Controller shall always satisfy q') => ({
  request_id: randomUUID(), component: 'Controller',
  requirements: [{ id, fretish: text, kind: 'guarantee', source_refs: ['  exact source reference  '] }],
  variables: [{ name: 'q', type: 'bool', role: 'output', meaning: 'Approved output' }],
  time_model: { kind: 'discrete_steps', description: 'One evaluation per step.' },
  options: { timeout_ms: 10000, diagnose: false }
});

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 15000;
  while (!predicate()) { assert.ok(Date.now() < deadline, message); await delay(20); }
}
async function completed(jobs, id) {
  await waitUntil(() => jobs.get(id, owner).status !== 'running', 'analysis did not finish');
  return jobs.get(id, owner);
}
function fixture(t, busy = false, options = {}) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'fret-jobs-test-'));
  const analysisDirectory = path.join(directory, 'analyses');
  let analysisWorkerPath = workerPath;
  if (busy) {
    analysisWorkerPath = path.join(directory, 'controlled-worker.cjs');
    fs.writeFileSync(analysisWorkerPath, `
      const fs = require('node:fs');
      const { spawn } = require('node:child_process');
      let sequence = 0;
      const acknowledgements = new Map();
      process.on('message', message => {
        if (message.ack !== undefined) {
          acknowledgements.get(message.ack)?.();
          acknowledgements.delete(message.ack);
        }
      });
      const persist = update => new Promise(resolve => {
        const update_id = ++sequence;
        acknowledgements.set(update_id, resolve);
        process.send({ ...update, update_id });
      });
      process.once('message', async ({ input, workDirectory, deadline_ns }) => {
        if (input.requirements[0].id === 'busy') {
          const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
          fs.writeFileSync(${JSON.stringify(path.join(directory, 'pids.json'))}, JSON.stringify([process.pid, child.pid]));
          setInterval(() => {}, 1000);
        } else if (input.requirements[0].id === 'crash') process.exit(2);
        else {
          const { analyzeRequirements } = require(${JSON.stringify(path.resolve(__dirname, '../dist/analysis.cjs'))});
          const report = await analyzeRequirements(input, workDirectory, undefined, {
            deadline_ns,
            persist: async update => {
              await persist(update);
              if (input.requirements[0].id === 'checkpoint-busy' && update.phase === 'diagnosing') {
                fs.writeFileSync(${JSON.stringify(path.join(directory, 'diagnosing'))}, 'acknowledged');
                await new Promise(() => {});
              }
            }
          });
          if (input.requirements[0].id === 'wrong') report.input_digest = 'sha256:' + '0'.repeat(64);
          process.send({ report }, () => process.disconnect());
        }
      });
    `);
  }
  const settings = { analysisDirectory, analysisWorkerPath, ...options };
  const jobs = new AnalysisJobs(settings);
  t.after(async () => { await jobs.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { jobs, directory, settings };
}
async function assertGroupStopped(directory) {
  const pids = JSON.parse(fs.readFileSync(path.join(directory, 'pids.json'), 'utf8'));
  for (const pid of pids) {
    await waitUntil(() => {
      try { process.kill(pid, 0); return false; }
      catch (error) { assert.equal(error.code, 'ESRCH'); return true; }
    }, `process ${pid} survived cancellation`);
  }
}

test('concurrent analysis preserves snapshots, evidence digests and isolated cleanup', linux, async t => {
  const { jobs, settings } = fixture(t);
  const aInput = request('A');
  const a = jobs.start(aInput, owner);
  const b = jobs.start(request('B', 'Controller shall always satisfy (q & !q)'), owner);
  assert.notEqual(a.job_id, b.job_id);
  aInput.requirements[0].id = 'changed after start';
  aInput.requirements[0].fretish = 'changed after start';
  const [left, right] = await Promise.all([completed(jobs, a.job_id), completed(jobs, b.job_id)]);
  assert.equal(left.status, 'completed', JSON.stringify(left.error));
  assert.equal(left.report.result, 'realizable');
  assert.equal(right.report.result, 'unrealizable');
  assert.deepEqual(left.report.requested_ids, ['A']);
  assert.deepEqual(right.report.requested_ids, ['B']);
  assert.equal(left.input.requirements[0].source_refs[0], '  exact source reference  ');
  assert.equal(left.input_digest, contentDigest(left.input));
  assert.equal(left.report_digest, contentDigest(left.report));
  assert.deepEqual(fs.readdirSync(path.join(settings.analysisDirectory, 'work')), []);
  assert.ok(left.report.checks[0].lustre.length);
  await jobs.close();
  const restarted = new AnalysisJobs(settings);
  try { assert.deepEqual(restarted.get(a.job_id, owner), left); }
  finally { await restarted.close(); }
});

test('request identities are idempotent and access is bound to the authenticated owner', linux, async t => {
  const { jobs } = fixture(t);
  const input = request();
  const first = jobs.start(input, owner);
  assert.equal(jobs.start(structuredClone(input), owner).job_id, first.job_id);
  assert.throws(() => jobs.start({ ...input, component: 'Different' }, owner), { code: 'request_conflict' });
  assert.throws(() => jobs.get(first.job_id, other), { code: 'analysis_not_found' });
  await assert.rejects(jobs.cancel({ job_id: first.job_id }, other), { code: 'analysis_not_found' });
  assert.equal((await completed(jobs, first.job_id)).status, 'completed');
});

test('cancellation kills the worker and child process without cancelling another analysis', linux, async t => {
  const { jobs, directory } = fixture(t, true);
  const busy = jobs.start(request('busy'), owner);
  await waitUntil(() => fs.existsSync(path.join(directory, 'pids.json')), 'worker not ready');
  const otherJob = jobs.start(request('other'), owner);
  const cancelled = await jobs.cancel({ job_id: busy.job_id }, owner);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.report, null);
  await assertGroupStopped(directory);
  assert.equal((await completed(jobs, otherJob.job_id)).report.result, 'realizable');
  assert.deepEqual(await jobs.cancel({ job_id: busy.job_id }, owner), cancelled);
});

test('timeout includes subprocess shutdown and releases capacity', linux, async t => {
  const { jobs, directory } = fixture(t, true, { maxAnalyses: 1 });
  const input = request('busy'); input.options.timeout_ms = 1000;
  const busy = jobs.start(input, owner);
  await waitUntil(() => fs.existsSync(path.join(directory, 'pids.json')), 'worker not ready');
  assert.throws(() => jobs.start(request(), owner), { code: 'busy' });
  const result = await completed(jobs, busy.job_id);
  assert.equal(result.status, 'timed_out');
  assert.equal(result.report, null);
  await assertGroupStopped(directory);
  assert.equal((await completed(jobs, jobs.start(request(), owner).job_id)).status, 'completed');
});

test('crashes and mismatched evidence cannot produce successful reports', linux, async t => {
  const { jobs } = fixture(t, true);
  for (const id of ['crash', 'wrong']) {
    const result = await completed(jobs, jobs.start(request(id), owner).job_id);
    assert.equal(result.status, 'error');
    assert.equal(result.report, null);
    assert.equal(result.report_digest, null);
  }
});

test('one service owns a store and shutdown marks running analysis interrupted', linux, async t => {
  const { jobs, directory, settings } = fixture(t, true);
  assert.throws(() => new AnalysisJobs(settings), /locked/);
  const running = jobs.start(request('busy'), owner);
  await waitUntil(() => fs.existsSync(path.join(directory, 'pids.json')), 'worker not ready');
  await jobs.close();
  await assertGroupStopped(directory);
  const restarted = new AnalysisJobs(settings);
  try { assert.equal(restarted.get(running.job_id, owner).status, 'interrupted'); }
  finally { await restarted.close(); }
});

test('a primary checkpoint survives cancelled diagnosis, cleanup and service restart', linux, async t => {
  const { jobs, directory, settings } = fixture(t, true);
  const input = request('checkpoint-busy', 'Controller shall always satisfy (q & !q)');
  input.options.diagnose = true;
  const running = jobs.start(input, owner);
  await waitUntil(() => fs.existsSync(path.join(directory, 'diagnosing')), 'diagnosis did not await the saved primary check');
  const progress = jobs.get(running.job_id, owner);
  assert.equal(progress.phase, 'diagnosing');
  assert.equal(progress.report, null);
  assert.equal(progress.diagnostics.checkpoint.result, 'unrealizable');
  assert.equal(progress.diagnostics.checkpoint_digest, contentDigest(progress.diagnostics.checkpoint));
  assert.deepEqual(progress.diagnostics.checkpoint.checks[0].requirement_ids, ['checkpoint-busy']);
  const cancelled = await jobs.cancel({ job_id: running.job_id }, owner);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.report, null);
  assert.equal(cancelled.report_digest, null);
  assert.equal(cancelled.diagnostics.last_phase, 'diagnosing');
  assert.equal(cancelled.diagnostics.checkpoint_digest, progress.diagnostics.checkpoint_digest);
  assert.deepEqual(fs.readdirSync(path.join(settings.analysisDirectory, 'work')), []);
  await jobs.close();
  const restarted = new AnalysisJobs(settings);
  try { assert.deepEqual(restarted.get(running.job_id, owner), cancelled); }
  finally { await restarted.close(); }
});

test('failed terminal persistence retains recoverable files and the acknowledged primary checkpoint', linux, async t => {
  const { jobs, directory, settings } = fixture(t, true);
  const input = request('checkpoint-busy', 'Controller shall always satisfy (q & !q)');
  input.options.diagnose = true;
  const running = jobs.start(input, owner);
  await waitUntil(() => fs.existsSync(path.join(directory, 'diagnosing')), 'primary check was not acknowledged');
  const checkpoint = jobs.get(running.job_id, owner).diagnostics.checkpoint_digest;
  t.mock.method(jobs, 'save', () => { throw new Error('controlled durable-store failure'); });
  await assert.rejects(jobs.cancel({ job_id: running.job_id }, owner), { code: 'storage_error' });
  const work = path.join(settings.analysisDirectory, 'work', running.job_id);
  assert.ok(fs.existsSync(path.join(work, 'FretContract.lus')), 'failed persistence must not delete recoverable source');
  t.mock.restoreAll();
  await jobs.close();
  const restarted = new AnalysisJobs(settings);
  try {
    const recovered = restarted.get(running.job_id, owner);
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.report, null);
    assert.equal(recovered.diagnostics.last_phase, 'diagnosing');
    assert.equal(recovered.diagnostics.checkpoint_digest, checkpoint);
    assert.equal(recovered.diagnostics.checkpoint.result, 'unrealizable');
    assert.equal(fs.existsSync(work), false);
  } finally { await restarted.close(); }
});

test('hard timeout retains byte-limited multibyte solver evidence without inventing an exit', linux, async t => {
  const { jobs, directory, settings } = fixture(t, false, { maxAnalyses: 1 });
  const binaries = path.join(directory, 'bin');
  fs.mkdirSync(binaries);
  const executable = path.join(binaries, 'kind2');
  const marker = path.join(directory, 'solver-pid');
  // A controlled OS process exercises real pipe/IPC cancellation and prefix
  // limits. Semantic realizability tests use the genuine pinned backend.
  fs.writeFileSync(executable, `#!${process.execPath}\n
    if (process.argv.includes('--version')) console.log('kind2 v2.2.0');
    else {
      require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));
      process.stdout.write('x' + 'é'.repeat(80000));
      process.stderr.write('x' + '😀'.repeat(40000));
      setInterval(() => {}, 1000);
    }
  `, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = binaries + path.delimiter + previousPath;
  t.after(() => { process.env.PATH = previousPath; });
  const input = request('flood');
  const running = jobs.start(input, owner);
  await waitUntil(() => jobs.get(running.job_id, owner).diagnostics.last_check?.stderr_truncated,
    'byte-limited evidence was not durably captured');
  const result = await completed(jobs, running.job_id);
  assert.equal(result.status, 'timed_out');
  assert.equal(result.report, null);
  assert.equal(result.diagnostics.last_phase, 'checking');
  const check = result.diagnostics.last_check;
  assert.equal(check.output_complete, false);
  assert.equal(check.finished_at, null);
  assert.equal(check.exit_code, null);
  assert.equal(check.signal, null);
  assert.equal(check.stdout_truncated, true);
  assert.equal(check.stderr_truncated, true);
  assert.ok(Buffer.byteLength(check.stdout) <= 65536);
  assert.ok(Buffer.byteLength(check.stderr) <= 65536);
  assert.equal(check.stdout.includes('\uFFFD'), false);
  assert.equal(check.stderr.includes('\uFFFD'), false);
  assert.equal(check.lustre_digest, contentDigest(check.lustre));
  assert.equal(check.lustre_bytes, Buffer.byteLength(check.lustre));
  assert.deepEqual(check.requirement_ids, ['flood']);
  assert.ok(check.command.includes('--timeout'));
  assert.equal(check.toolchain.adapter, '0.4.0');
  const pid = Number(fs.readFileSync(marker, 'utf8'));
  await waitUntil(() => {
    try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
  }, 'solver survived the hard deadline');
  assert.deepEqual(fs.readdirSync(path.join(settings.analysisDirectory, 'work')), []);
  process.env.PATH = previousPath;
  const next = jobs.start(request('after-timeout'), owner);
  assert.equal((await completed(jobs, next.job_id)).report.result, 'realizable');
  await jobs.close();
  const restarted = new AnalysisJobs(settings);
  try { assert.deepEqual(restarted.get(running.job_id, owner), result); }
  finally { await restarted.close(); }
});

test('the solver deadline returns UNKNOWN evidence before the parent hard deadline', linux, async t => {
  const { jobs, directory } = fixture(t);
  const binaries = path.join(directory, 'bin');
  fs.mkdirSync(binaries);
  fs.writeFileSync(path.join(binaries, 'kind2'), `#!${process.execPath}\n
    if (process.argv.includes('--version')) console.log('kind2 v2.2.0');
    else {
      const seconds = Number(process.argv[process.argv.indexOf('--timeout') + 1]);
      setTimeout(() => {
        console.log(JSON.stringify([
          { objectType: 'analysisStart', context: 'contract' },
          { level: 'fatal', value: 'Wallclock timeout.' }
        ]));
        process.exitCode = 30;
      }, seconds * 1000);
    }
  `, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = binaries + path.delimiter + previousPath;
  t.after(() => { process.env.PATH = previousPath; });
  const input = request('inner-timeout');
  input.options.timeout_ms = 8000;
  const result = await completed(jobs, jobs.start(input, owner).job_id);
  assert.equal(result.status, 'completed', JSON.stringify(result.error));
  assert.equal(result.report.result, 'unknown');
  assert.equal(result.report.contract_result, 'unknown');
  assert.match(result.report.checks[0].stdout, /Wallclock timeout/);
  assert.equal(result.diagnostics.last_check.output_complete, true);
  assert.equal(result.diagnostics.last_check.exit_code, 30);
  assert.equal(result.diagnostics.last_check.signal, null);
  assert.equal(result.diagnostics.checkpoint, null);
});

test('a failed solver spawn leaves prepared evidence without a fabricated execution or exit', linux, async t => {
  const { jobs, directory } = fixture(t);
  const binaries = path.join(directory, 'only-bin');
  fs.mkdirSync(binaries);
  const previousPath = process.env.PATH;
  const z3 = previousPath.split(path.delimiter).map(dir => path.join(dir, 'z3')).find(file => fs.existsSync(file));
  assert.ok(z3, 'the pinned Z3 executable is required');
  fs.symlinkSync(z3, path.join(binaries, 'z3'));
  fs.writeFileSync(path.join(binaries, 'kind2'), `#!${process.execPath}\n
    if (process.argv.includes('--version')) {
      require('node:fs').unlinkSync(process.argv[1]);
      console.log('kind2 v2.2.0');
    }
  `, { mode: 0o755 });
  process.env.PATH = binaries;
  t.after(() => { process.env.PATH = previousPath; });
  const result = await completed(jobs, jobs.start(request('spawn-failure'), owner).job_id);
  assert.equal(result.status, 'completed');
  assert.equal(result.report.result, 'error');
  assert.match(result.report.diagnostics[0].message, /ENOENT/);
  const check = result.diagnostics.last_check;
  assert.equal(check.started_at, null);
  assert.equal(check.finished_at, null);
  assert.deepEqual(check.command, []);
  assert.equal(check.exit_code, null);
  assert.equal(check.signal, null);
  assert.equal(check.output_complete, false);
  assert.equal(check.lustre_digest, contentDigest(check.lustre));
  assert.equal(result.diagnostics.checkpoint, null);
});

test('a nonempty legacy store is refused without rewriting or deleting its evidence', linux, async t => {
  const { jobs, settings } = fixture(t);
  const result = await completed(jobs, jobs.start(request(), owner).job_id);
  await jobs.close();
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(settings.analysisDirectory, 'jobs.sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA user_version=1');
  const before = db.prepare('SELECT data FROM jobs WHERE id=?').get(result.job_id).data;
  db.close();
  assert.throws(() => new AnalysisJobs(settings), /new analysis store/);
  const after = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(after.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(after.prepare('SELECT data FROM jobs WHERE id=?').get(result.job_id).data, before);
  } finally { after.close(); }
});

test('terminal snapshots page exact immutable UTF-8 bytes and enforce owner, digest and offset', linux, async t => {
  const { jobs } = fixture(t);
  const input = request('unicode-snapshot');
  input.time_model.description = '😀\uFEFFé\\"'.repeat(18000);
  const running = jobs.start(input, owner);
  const progress = jobs.read({ job_id: running.job_id }, owner);
  assert.equal(progress.snapshot, null);
  assert.equal(progress.page, null);
  assert.equal(progress.input, undefined);
  const finished = await completed(jobs, running.job_id);
  assert.equal(finished.report.result, 'realizable');
  const view = jobs.read({ job_id: running.job_id }, owner);
  assert.equal(view.snapshot.page_bytes, 65536);
  assert.ok(view.snapshot.bytes > 65536);
  assert.equal(view.page, null);
  const original = jobs.db.prepare('SELECT data FROM jobs WHERE id=?').get(running.job_id).data;
  t.mock.method(jobs, 'get', () => { throw new Error('paged reads must not load the full job'); });
  const parts = [];
  let offset = 0;
  while (offset !== null) {
    const page = jobs.read({ job_id: view.job_id, snapshot_digest: view.snapshot.digest, offset }, owner);
    assert.deepEqual(page.snapshot, view.snapshot);
    assert.equal(page.page.offset, offset);
    const bytes = Buffer.from(page.page.text, 'utf8');
    assert.ok(bytes.length <= 65536);
    parts.push(bytes);
    if (page.page.next_offset !== null) assert.equal(page.page.next_offset, offset + bytes.length);
    offset = page.page.next_offset;
  }
  const restored = Buffer.concat(parts);
  assert.equal(restored.length, view.snapshot.bytes);
  assert.equal(restored.toString('utf8'), original);
  assert.equal(contentDigest(restored.toString('utf8')), view.snapshot.digest);
  assert.throws(() => jobs.read({ job_id: view.job_id, offset: 0 }, owner), /supplied together/);
  assert.throws(() => jobs.read({ job_id: view.job_id, snapshot_digest: view.snapshot.digest, offset: 0 }, other), { code: 'analysis_not_found' });
  assert.throws(() => jobs.read({ job_id: view.job_id, snapshot_digest: 'sha256:' + '0'.repeat(64), offset: 0 }, owner), { code: 'snapshot_mismatch' });
  assert.throws(() => jobs.read({ job_id: view.job_id, snapshot_digest: view.snapshot.digest, offset: view.snapshot.bytes }, owner), { code: 'invalid_offset' });
  const emoji = restored.indexOf(Buffer.from('😀'));
  assert.throws(() => jobs.read({ job_id: view.job_id, snapshot_digest: view.snapshot.digest, offset: emoji + 1 }, owner), { code: 'invalid_offset' });
  const bom = restored.indexOf(Buffer.from('\uFEFF'));
  const bomPage = jobs.read({ job_id: view.job_id, snapshot_digest: view.snapshot.digest, offset: bom }, owner);
  assert.equal(bomPage.page.text[0], '\uFEFF');
  assert.deepEqual(jobs.read({ job_id: view.job_id }, owner), view);
});

test('unexpected parent death stops the real worker and restart invalidates unfinished evidence', linux, async t => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'fret-restart-test-'));
  const settings = { analysisDirectory: path.join(directory, 'analyses'), analysisWorkerPath: workerPath };
  const input = request('large', 'Controller shall always satisfy ' + '!('.repeat(20000) + 'q' + ')'.repeat(20000));
  const program = `
    const fs = require('fs');
    const { AnalysisJobs } = require(${JSON.stringify(path.resolve(__dirname, '../src/analysis_jobs'))});
    const jobs = new AnalysisJobs(${JSON.stringify(settings)});
    const started = jobs.start(${JSON.stringify(input)}, ${JSON.stringify(owner)});
    fs.writeFileSync(${JSON.stringify(path.join(directory, 'job.json'))}, JSON.stringify(started));
    setInterval(() => {}, 1000);
  `;
  const programPath = path.join(directory, 'service.cjs');
  fs.writeFileSync(programPath, program);
  const service = spawn(process.execPath, [programPath], { stdio: 'ignore' });
  const closed = new Promise(resolve => service.once('close', resolve));
  t.after(async () => { service.kill('SIGKILL'); await closed; fs.rmSync(directory, { recursive: true, force: true }); });
  await waitUntil(() => fs.existsSync(path.join(directory, 'job.json')), 'service not ready');
  const job = JSON.parse(fs.readFileSync(path.join(directory, 'job.json'), 'utf8'));
  const childPids = fs.readFileSync(`/proc/${service.pid}/task/${service.pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
  assert.equal(childPids.length, 1);
  const supervisor = childPids[0];
  await waitUntil(() => fs.readFileSync(`/proc/${supervisor}/task/${supervisor}/children`, 'utf8').trim().length > 0, 'computation child not ready');
  childPids.push(...fs.readFileSync(`/proc/${supervisor}/task/${supervisor}/children`, 'utf8').trim().split(/\s+/).map(Number));
  service.kill('SIGKILL'); await closed;
  for (const pid of childPids) await waitUntil(() => !fs.existsSync(`/proc/${pid}`), 'orphan worker survived');
  const restarted = new AnalysisJobs(settings);
  try {
    const result = restarted.get(job.job_id, owner);
    assert.equal(result.status, 'interrupted');
    assert.equal(result.error.code, 'service_restarted');
    assert.equal(result.report, null);
    assert.deepEqual(fs.readdirSync(path.join(settings.analysisDirectory, 'work')), []);
  } finally { await restarted.close(); }
});
