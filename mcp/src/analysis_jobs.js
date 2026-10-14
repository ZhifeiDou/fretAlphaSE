const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fork } = require('node:child_process');
const { analysisInput, analysisReport, analysisStatus, contentDigest } = require('./schemas');
const { ExecutionError } = require('./executor');

class AnalysisJobs {
  constructor({ analysisDirectory, analysisWorkerPath, maxAnalyses = 2, analysisTimeoutMs = 900000 }) {
    if (process.platform !== 'linux') throw new Error('Analysis jobs require Linux; use the FRET Docker image.');
    // The service owns one SQLite connection. Exclusive locking prevents a
    // second service from treating this instance's live jobs as interrupted.
    const { DatabaseSync } = require('node:sqlite');
    this.root = path.resolve(analysisDirectory);
    this.workRoot = path.join(this.root, 'work');
    fs.mkdirSync(this.workRoot, { recursive: true });
    this.db = new DatabaseSync(path.join(this.root, 'jobs.sqlite'));
    try {
      this.db.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (![0, 1].includes(version)) throw new Error(`Unsupported analysis store version: ${version}`);
      if (version === 0 && this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'").get()) {
        throw new Error('The analysis store has no supported schema version.');
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_id TEXT NOT NULL,
          input_digest TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(owner, request_id)
        ); PRAGMA user_version=1; COMMIT;`);
      for (const row of this.db.prepare('SELECT id, data FROM jobs').all()) {
        const job = analysisStatus.parse(JSON.parse(row.data));
        if (job.status === 'running') {
          job.status = 'interrupted'; job.phase = 'finished'; job.finished_at = new Date().toISOString();
          job.error = { code: 'service_restarted', message: 'The service restarted before this analysis completed.' };
          this.save(job);
        }
        this.clean(job);
      }
    } catch (error) { this.db.close(); throw error; }
    this.workerPath = analysisWorkerPath;
    this.maxAnalyses = maxAnalyses;
    this.timeoutMs = analysisTimeoutMs;
    this.active = new Map();
    this.closed = false;
  }

  owner(caller) { return JSON.stringify([caller.subject, caller.login]); }

  save(job) {
    this.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(analysisStatus.parse(job)), job.job_id);
  }

  clean(job) {
    // Only service-generated UUID directories immediately below work/ belong
    // to this operation. Neither an input ID nor an arbitrary path is accepted.
    const id = analysisStatus.shape.job_id.parse(job.job_id);
    const directory = path.resolve(this.workRoot, id);
    if (path.dirname(directory) !== this.workRoot) throw new Error('Invalid job workspace.');
    fs.rmSync(directory, { recursive: true, force: true });
  }

  get(id, caller) {
    if (this.failure) throw new ExecutionError('storage_error', this.failure.message);
    const row = this.db.prepare('SELECT owner, data FROM jobs WHERE id=?').get(id);
    if (!row || row.owner !== this.owner(caller)) throw new ExecutionError('analysis_not_found', 'No analysis owned by this caller has that identity.');
    return analysisStatus.parse(JSON.parse(row.data));
  }

  start(request, caller) {
    if (this.failure) throw new ExecutionError('storage_error', this.failure.message);
    if (this.closed) throw new ExecutionError('shutting_down', 'The service is shutting down.');
    const input = analysisInput.parse(request);
    const inputDigest = contentDigest(input);
    const owner = this.owner(caller);
    const previous = this.db.prepare('SELECT id, input_digest FROM jobs WHERE owner=? AND request_id=?').get(owner, input.request_id);
    if (previous) {
      if (previous.input_digest !== inputDigest) throw new ExecutionError('request_conflict', 'request_id is already bound to different input.');
      return this.get(previous.id, caller);
    }
    if (this.active.size >= this.maxAnalyses) throw new ExecutionError('busy', 'All analysis slots are in use.');
    if (input.options.timeout_ms > this.timeoutMs) throw new ExecutionError('timeout_limit', 'Requested timeout exceeds the server analysis budget.');
    const job = {
      job_id: randomUUID(), request_id: input.request_id, input_digest: inputDigest,
      status: 'running', phase: 'preparing', created_at: new Date().toISOString(), finished_at: null,
      report_digest: null, report: null, error: null, input
    };
    this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(job.job_id, owner, input.request_id, inputDigest, JSON.stringify(job));
    const workDirectory = path.join(this.workRoot, job.job_id);
    let child;
    try {
      fs.mkdirSync(workDirectory);
      child = fork(this.workerPath, [], {
        cwd: workDirectory, detached: true, execArgv: ['--max-old-space-size=256'],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc']
      });
    } catch (error) {
      job.status = 'error'; job.phase = 'finished'; job.finished_at = new Date().toISOString();
      job.error = { code: 'worker_start_failed', message: error.message };
      this.save(job); this.clean(job);
      return this.get(job.job_id, caller);
    }
    let response;
    let failure;
    const killGroup = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    const stop = (status, code, message) => {
      failure ??= { status, error: { code, message } };
      killGroup();
    };
    const timer = setTimeout(() => stop('timed_out', 'timeout', 'Analysis exceeded its total wall-clock budget.'), input.options.timeout_ms);
    const active = { stop, done: null };
    active.done = new Promise(resolve => {
      child.on('message', message => {
        if (failure) return;
        if (['checking', 'diagnosing'].includes(message.phase)) {
          job.phase = message.phase;
          try { this.save(job); }
          catch (error) {
            this.failure = error;
            stop('error', 'storage_error', error.message);
          }
        } else response = message;
      });
      child.on('error', error => stop('error', 'worker_error', error.message));
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        killGroup();
        try {
          if (failure) { job.status = failure.status; job.error = failure.error; }
          else if (response?.error) { job.status = 'error'; job.error = response.error; }
          else {
            if (code !== 0 || signal) throw new Error('Analysis worker exited abnormally.');
            const report = analysisReport.parse(response?.report);
            if (report.input_digest !== inputDigest || JSON.stringify(report.requested_ids) !== JSON.stringify(input.requirements.map(item => item.id)) ||
                report.analyzed_ids.some(id => !report.requested_ids.includes(id)) ||
                (['realizable', 'unrealizable'].includes(report.result) && JSON.stringify(report.analyzed_ids) !== JSON.stringify(report.requested_ids))) {
              throw new Error('The analysis result does not match its exact input.');
            }
            job.status = 'completed'; job.report = report; job.report_digest = contentDigest(report);
          }
        } catch (error) {
          job.status = 'error'; job.error = { code: 'invalid_worker_result', message: error.message };
        }
        job.phase = 'finished'; job.finished_at = new Date().toISOString();
        // Commit evidence before deleting temporary files. A storage error
        // must not be converted to a successful response or discard the files.
        try {
          this.save(job);
          try { this.clean(job); }
          catch (error) {
            job.error = { code: 'cleanup_failed', message: error.message };
            this.save(job);
          }
        } catch (error) { this.failure = error; }
        finally { this.active.delete(job.job_id); resolve(); }
      });
    });
    this.active.set(job.job_id, active);
    child.send({ input, workDirectory }, error => {
      if (error) stop('error', 'worker_error', error.message);
    });
    return this.get(job.job_id, caller);
  }

  async cancel(id, caller) {
    this.get(id, caller);
    const active = this.active.get(id);
    if (active) {
      active.stop('cancelled', 'cancelled', 'Cancelled by the analysis owner.');
      await active.done;
    }
    return this.get(id, caller);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const active = [...this.active.values()];
    for (const job of active) job.stop('interrupted', 'service_shutdown', 'The service stopped before analysis completed.');
    await Promise.all(active.map(job => job.done));
    this.db.close();
  }
}

module.exports = { AnalysisJobs };
