const { fork } = require('node:child_process');
const { formalizeInput, formalizeOutput } = require('./schemas');

class ExecutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExecutionError';
    this.code = code;
  }
}

class FormalizationExecutor {
  constructor({ workerPath, maxWorkers = 2, timeoutMs = 30000 }) {
    if (typeof workerPath !== 'string' || !workerPath ||
        !Number.isSafeInteger(maxWorkers) || maxWorkers < 1 ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
      throw new TypeError('Expected workerPath, positive maxWorkers, and a valid timeoutMs.');
    }
    this.workerPath = workerPath;
    this.maxWorkers = maxWorkers;
    this.timeoutMs = timeoutMs;
    this.workers = new Set();
    this.closed = false;
  }

  async run(request, { signal } = {}) {
    if (this.closed) throw new ExecutionError('shutting_down', 'The service is shutting down.');
    if (signal?.aborted) throw new ExecutionError('cancelled', 'The request was cancelled.');
    if (this.workers.size >= this.maxWorkers) throw new ExecutionError('busy', 'All computation slots are in use. Retry later.');
    // Parsing also copies the input before IPC or any asynchronous work.
    const snapshot = formalizeInput.parse(request);
    const child = fork(this.workerPath, [], {
      execArgv: ['--max-old-space-size=256'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true
    });
    let response;
    let failure;
    let stopping = false;
    const stop = error => {
      failure ??= error;
      if (stopping) return;
      stopping = true;
      // The worker does only synchronous, side-effect-free computation. Killing
      // it is necessary: an IPC cancel cannot interrupt a busy parser.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    const abort = () => stop(new ExecutionError('cancelled', 'The request was cancelled.'));
    const timer = setTimeout(() => stop(new ExecutionError('timeout', `Formalization exceeded ${this.timeoutMs} ms.`)), this.timeoutMs);
    const job = { child, stop, done: null };
    job.done = new Promise((resolve, reject) => {
      child.on('message', message => { response = message; });
      child.on('error', () => stop(new ExecutionError('worker_error', 'The computation process could not run.')));
      child.once('close', (code, exitSignal) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.workers.delete(job);
        // Resolve/reject only after the OS process and its IPC channel close.
        if (failure) return reject(failure);
        if (code !== 0 || exitSignal || !response) {
          return reject(new ExecutionError('worker_error', 'The computation process exited without a successful result.'));
        }
        if (response.error) return reject(new ExecutionError('worker_error', response.error.message));
        const parsed = formalizeOutput.safeParse(response.result);
        if (!parsed.success ||
            JSON.stringify(parsed.data.representations) !== JSON.stringify(snapshot.representations) ||
            parsed.data.results.length !== snapshot.requirements.length ||
            parsed.data.results.some((result, index) => result.id !== snapshot.requirements[index].id)) {
          return reject(new ExecutionError('worker_error', 'The computation result did not match the input contract.'));
        }
        resolve(parsed.data);
      });
    });
    this.workers.add(job);
    signal?.addEventListener('abort', abort, { once: true });
    child.send(snapshot, error => {
      if (error) stop(new ExecutionError('worker_error', 'The computation process could not receive input.'));
    });
    return job.done;
  }

  async close() {
    this.closed = true;
    const jobs = [...this.workers];
    for (const job of jobs) job.stop(new ExecutionError('shutting_down', 'The service is shutting down.'));
    await Promise.allSettled(jobs.map(job => job.done));
  }
}

module.exports = { FormalizationExecutor, ExecutionError };
