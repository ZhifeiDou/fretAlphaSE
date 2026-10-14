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
      const { analyzeRequirements } = require(${JSON.stringify(path.resolve(__dirname, '../dist/analysis.cjs'))});
      process.once('message', async ({ input, workDirectory }) => {
        if (input.requirements[0].id === 'busy') {
          const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
          fs.writeFileSync(${JSON.stringify(path.join(directory, 'pids.json'))}, JSON.stringify([process.pid, child.pid]));
          setInterval(() => {}, 1000);
        } else if (input.requirements[0].id === 'crash') process.exit(2);
        else {
          const report = await analyzeRequirements(input, workDirectory);
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
  await assert.rejects(jobs.cancel(first.job_id, other), { code: 'analysis_not_found' });
  assert.equal((await completed(jobs, first.job_id)).status, 'completed');
});

test('cancellation kills the worker and child process without cancelling another analysis', linux, async t => {
  const { jobs, directory } = fixture(t, true);
  const busy = jobs.start(request('busy'), owner);
  await waitUntil(() => fs.existsSync(path.join(directory, 'pids.json')), 'worker not ready');
  const otherJob = jobs.start(request('other'), owner);
  const cancelled = await jobs.cancel(busy.job_id, owner);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.report, null);
  await assertGroupStopped(directory);
  assert.equal((await completed(jobs, otherJob.job_id)).report.result, 'realizable');
  assert.deepEqual(await jobs.cancel(busy.job_id, owner), cancelled);
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
