const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, writeFileSync, readdirSync, unlinkSync, rmdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { FormalizationExecutor } = require('../src/executor');

const workerPath = path.resolve(__dirname, '../dist/worker.cjs');
const input = (id, variable = 'enabled') => ({
  requirements: [{ id, fretish: `Controller shall always satisfy ${variable}` }],
  representations: ['ft-inf', 'pt-smv']
});

function assertExited(child) {
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
}

// Controlled failure fixture: the busy path deliberately blocks the event loop.
// Normal paths still run the real, built formalizer. Production has no such mode.
function busyFixture(t, options = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'fret-worker-test-'));
  const file = path.join(directory, 'worker.cjs');
  writeFileSync(file, `
    const fs = require('node:fs');
    const path = require('node:path');
    process.once('message', request => {
      const id = request.requirements[0].id;
      fs.writeFileSync(path.join(__dirname, id + '.ready'), String(process.pid));
      if (id === 'busy') { while (true) {} }
      if (id === 'crash') process.exit(2);
      const { formalizeRequirements } = require(${JSON.stringify(path.resolve(__dirname, '../dist/formalize.cjs'))});
      const result = formalizeRequirements(request);
      if (id === 'wrong') result.results[0].id = 'another-request';
      process.send({ result }, () => process.disconnect());
    });
  `);
  const executor = new FormalizationExecutor({ workerPath: file, ...options });
  t.after(async () => {
    await executor.close();
    for (const name of readdirSync(directory)) unlinkSync(path.join(directory, name));
    rmdirSync(directory);
  });
  return { executor, directory };
}

async function waitReady(directory) {
  const deadline = Date.now() + 5000;
  while (!readdirSync(directory).includes('busy.ready')) {
    assert.ok(Date.now() < deadline, 'worker did not reach the CPU-bound computation');
    await delay(20);
  }
}

test('real concurrent FRET workers preserve input snapshots and isolate semantic state', async t => {
  const executor = new FormalizationExecutor({ workerPath });
  t.after(() => executor.close());
  const first = input('A', 'alpha');
  const a = executor.run(first);
  first.requirements[0].id = 'mutated';
  first.requirements[0].fretish = 'Controller shall satisfy wrong';
  first.representations.push('ft-fin');
  const b = executor.run(input('B', 'beta'));
  const children = [...executor.workers].map(job => job.child);
  assert.equal(children.length, 2);
  assert.notEqual(children[0].pid, children[1].pid);
  const [left, right] = await Promise.all([a, b]);
  assert.equal(left.results[0].id, 'A');
  assert.equal(left.results[0].formulas[0].formula, '(G alpha)');
  assert.deepEqual(left.representations, ['ft-inf', 'pt-smv']);
  assert.equal(right.results[0].id, 'B');
  assert.equal(right.results[0].formulas[0].formula, '(G beta)');
  assert.equal(executor.workers.size, 0);
  children.forEach(assertExited);
});

test('timeout kills a CPU-bound process before rejecting and releases capacity', async t => {
  const { executor, directory } = busyFixture(t, { maxWorkers: 1, timeoutMs: 1500 });
  const pending = executor.run(input('busy'));
  const rejected = assert.rejects(pending, { code: 'timeout' });
  const child = [...executor.workers][0].child;
  await waitReady(directory);
  await assert.rejects(executor.run(input('overflow')), { code: 'busy' });
  await rejected;
  assertExited(child);
  assert.equal(executor.workers.size, 0);
  unlinkSync(path.join(directory, 'busy.ready'));
  const next = executor.run(input('busy'));
  const reclaimed = assert.rejects(next, { code: 'timeout' });
  const replacement = [...executor.workers][0].child;
  await waitReady(directory);
  assert.notEqual(replacement.pid, child.pid);
  await reclaimed;
  assertExited(replacement);
  assert.equal(executor.workers.size, 0);
});

test('cancelling a busy worker leaves a concurrent real formalization intact', async t => {
  const { executor, directory } = busyFixture(t);
  const controller = new AbortController();
  const stopped = assert.rejects(executor.run(input('busy'), { signal: controller.signal }), { code: 'cancelled' });
  const child = [...executor.workers][0].child;
  await waitReady(directory);
  const other = executor.run(input('other', 'omega'));
  controller.abort();
  await stopped;
  assertExited(child);
  assert.equal((await other).results[0].formulas[0].formula, '(G omega)');
});

test('shutdown waits for process exit, is repeatable, and rejects new work', async t => {
  const { executor, directory } = busyFixture(t);
  const pending = assert.rejects(executor.run(input('busy')), { code: 'shutting_down' });
  const child = [...executor.workers][0].child;
  await waitReady(directory);
  await Promise.all([executor.close(), executor.close()]);
  await pending;
  assertExited(child);
  assert.equal(executor.workers.size, 0);
  await assert.rejects(executor.run(input('late')), { code: 'shutting_down' });
});

test('crashes and mismatched result identities never become successful results', async t => {
  const { executor } = busyFixture(t);
  await assert.rejects(executor.run(input('crash')), { code: 'worker_error' });
  await assert.rejects(executor.run(input('wrong')), { code: 'worker_error' });
  assert.equal(executor.workers.size, 0);
});

test('an already cancelled request never starts a worker', async t => {
  const executor = new FormalizationExecutor({ workerPath });
  t.after(() => executor.close());
  await assert.rejects(executor.run(input('cancelled'), { signal: AbortSignal.abort() }), { code: 'cancelled' });
  assert.equal(executor.workers.size, 0);
});

test('the real FRET worker can be interrupted while parsing deeply nested input', async t => {
  const executor = new FormalizationExecutor({ workerPath, timeoutMs: 1000 });
  t.after(() => executor.close());
  const request = input('deep');
  request.requirements[0].fretish = `Controller shall satisfy ${'('.repeat(2000)}p${')'.repeat(2000)}`;
  const pending = assert.rejects(executor.run(request), { code: 'timeout' });
  const child = [...executor.workers][0].child;
  await pending;
  assertExited(child);
});
