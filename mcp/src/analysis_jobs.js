const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fork } = require('node:child_process');
const { analysisInput, analysisCancellation, analysisRead, analysisReport, analysisStatus, analysisCheckEvidence, analysisView, contentDigest } = require('./schemas');
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
      if (![0, 2].includes(version)) {
        throw new Error(`Unsupported analysis store version: ${version}; FRET 0.3 requires a new analysis store.`);
      }
      if (version === 0 && this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'").get()) {
        throw new Error('The analysis store has no supported schema version.');
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_id TEXT NOT NULL,
          input_digest TEXT NOT NULL, data TEXT NOT NULL, view TEXT NOT NULL, UNIQUE(owner, request_id)
        ); PRAGMA user_version=2; COMMIT;`);
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

  serialize(job) {
    const value = analysisStatus.parse(job);
    const data = JSON.stringify(value);
    const view = analysisView.parse({
      job_id: value.job_id, request_id: value.request_id, input_digest: value.input_digest,
      status: value.status, phase: value.phase, created_at: value.created_at, finished_at: value.finished_at,
      last_phase: value.diagnostics.last_phase, phase_started_at: value.diagnostics.phase_started_at,
      snapshot: value.status === 'running' ? null :
        { digest: contentDigest(data), bytes: Buffer.byteLength(data, 'utf8'), page_bytes: 65536 },
      page: null
    });
    return { data, view: JSON.stringify(view) };
  }

  save(job) {
    const { data, view } = this.serialize(job);
    this.db.prepare('UPDATE jobs SET data=?, view=? WHERE id=?').run(data, view, job.job_id);
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

  read(request, caller) {
    if (this.failure) throw new ExecutionError('storage_error', this.failure.message);
    const input = analysisRead.parse(request);
    const row = this.db.prepare('SELECT owner, view FROM jobs WHERE id=?').get(input.job_id);
    if (!row || row.owner !== this.owner(caller)) {
      throw new ExecutionError('analysis_not_found', 'No analysis owned by this caller has that identity.');
    }
    const view = analysisView.parse(JSON.parse(row.view));
    if (input.offset === undefined) return view;
    if (!view.snapshot || input.snapshot_digest !== view.snapshot.digest) {
      throw new ExecutionError('snapshot_mismatch', 'No terminal snapshot has the requested digest.');
    }
    if (input.offset >= view.snapshot.bytes) throw new ExecutionError('invalid_offset', 'Snapshot byte offset is outside the stored evidence.');
    const { bytes } = this.db.prepare('SELECT substr(CAST(data AS BLOB), ?, 65536) AS bytes FROM jobs WHERE id=?')
      .get(input.offset + 1, input.job_id);
    let text;
    try {
      // Streaming decode drops only an incomplete final codepoint. BOMs are
      // ordinary snapshot bytes, including when a page starts inside a string.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, { stream: true });
    } catch {
      throw new ExecutionError('invalid_offset', 'Snapshot byte offset is not a UTF-8 character boundary.');
    }
    const next = input.offset + Buffer.byteLength(text, 'utf8');
    view.page = { offset: input.offset, next_offset: next < view.snapshot.bytes ? next : null, text };
    return analysisView.parse(view);
  }

  validateReport(value, input) {
    const report = analysisReport.parse(value);
    const ids = input.requirements.map(item => item.id);
    if (report.input_digest !== contentDigest(input) ||
        JSON.stringify(report.requested_ids) !== JSON.stringify(ids) ||
        report.analyzed_ids.some(id => !ids.includes(id)) ||
        (['realizable', 'unrealizable'].includes(report.result) &&
          JSON.stringify(report.analyzed_ids) !== JSON.stringify(ids))) {
      throw new Error('The analysis result does not match its exact input.');
    }
    return report;
  }

  findRequest(input, caller) {
    const previous = this.db.prepare('SELECT id, input_digest FROM jobs WHERE owner=? AND request_id=?')
      .get(this.owner(caller), input.request_id);
    if (!previous) return null;
    if (previous.input_digest !== contentDigest(input)) {
      throw new ExecutionError('request_conflict', 'request_id is already bound to different input.');
    }
    return this.get(previous.id, caller);
  }

  createJob(input, caller, status) {
    const createdAt = new Date().toISOString();
    const cancelled = status === 'cancelled';
    const job = {
      job_id: randomUUID(), request_id: input.request_id, input_digest: contentDigest(input),
      status, phase: cancelled ? 'finished' : 'preparing', created_at: createdAt,
      finished_at: cancelled ? createdAt : null, report_digest: null, report: null,
      error: cancelled ? { code: 'cancelled_before_start', message: 'Cancelled by the analysis owner before execution started.' } : null,
      input, diagnostics: { last_phase: 'preparing', phase_started_at: createdAt,
        last_check: null, checkpoint: null, checkpoint_digest: null }
    };
    const serialized = this.serialize(job);
    this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?)')
      .run(job.job_id, this.owner(caller), input.request_id, job.input_digest, serialized.data, serialized.view);
    return job;
  }

  start(request, caller) {
    if (this.failure) throw new ExecutionError('storage_error', this.failure.message);
    if (this.closed) throw new ExecutionError('shutting_down', 'The service is shutting down.');
    const input = analysisInput.parse(request);
    const previous = this.findRequest(input, caller);
    if (previous) return previous;
    if (this.active.size >= this.maxAnalyses) throw new ExecutionError('busy', 'All analysis slots are in use.');
    if (input.options.timeout_ms > this.timeoutMs) throw new ExecutionError('timeout_limit', 'Requested timeout exceeds the server analysis budget.');
    const started = process.hrtime.bigint();
    const deadline = started + BigInt(input.options.timeout_ms) * 1000000n;
    const job = this.createJob(input, caller, 'running');
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
      try { this.save(job); }
      catch (failure) {
        this.failure = failure;
        throw new ExecutionError('storage_error', failure.message);
      }
      this.clean(job);
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
    const timer = setTimeout(() => stop('timed_out', 'timeout', 'Analysis exceeded its total wall-clock budget.'),
      Math.max(0, Number(deadline - process.hrtime.bigint()) / 1000000));
    const active = { stop, done: null };
    active.done = new Promise(resolve => {
      child.on('message', message => {
        if (failure) return;
        if (message.phase || message.check || message.checkpoint) {
          try {
            if (message.phase) {
              if (!['checking', 'diagnosing'].includes(message.phase) ||
                  (message.phase === 'diagnosing' && job.diagnostics.checkpoint?.result !== 'unrealizable')) {
                throw new Error('Worker supplied an invalid analysis phase transition.');
              }
              job.phase = message.phase;
              job.diagnostics.last_phase = message.phase;
              job.diagnostics.phase_started_at = new Date().toISOString();
            } else if (message.check) {
              const check = analysisCheckEvidence.parse(message.check);
              const ids = input.requirements.map(item => item.id);
              if (check.requirement_ids.some(id => !ids.includes(id))) {
                throw new Error('Worker check evidence changes the requested scope.');
              }
              job.diagnostics.last_check = check;
            } else {
              const report = this.validateReport(message.checkpoint, input);
              if (report.checks.length !== 1 ||
                  JSON.stringify(report.checks[0].requirement_ids) !==
                    JSON.stringify(input.requirements.map(item => item.id))) {
                throw new Error('Worker checkpoint is not the complete primary contract check.');
              }
              job.diagnostics.checkpoint = report;
              job.diagnostics.checkpoint_digest = contentDigest(report);
            }
          } catch (error) { stop('error', 'invalid_worker_evidence', error.message); return; }
          try { this.save(job); }
          catch (error) { this.failure = error; stop('error', 'storage_error', error.message); return; }
          if (message.update_id !== undefined) {
            child.send({ ack: message.update_id }, error => {
              if (error) stop('error', 'worker_error', error.message);
            });
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
            const report = this.validateReport(response?.report, input);
            job.status = 'completed'; job.report = report; job.report_digest = contentDigest(report);
            job.diagnostics.checkpoint = null; job.diagnostics.checkpoint_digest = null;
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
    child.send({ input, workDirectory, deadline_ns: deadline.toString() }, error => {
      if (error) stop('error', 'worker_error', error.message);
    });
    return this.get(job.job_id, caller);
  }

  async cancel(request, caller) {
    if (this.failure) throw new ExecutionError('storage_error', this.failure.message);
    if (this.closed) throw new ExecutionError('shutting_down', 'The service is shutting down.');
    const selector = analysisCancellation.parse(request);
    // Lookup and a not-yet-started cancellation are synchronous durable writes.
    // A competing start must observe this same owner/request/input binding.
    const job = selector.request
      ? this.findRequest(selector.request, caller) ?? this.createJob(selector.request, caller, 'cancelled')
      : this.get(selector.job_id, caller);
    const active = this.active.get(job.job_id);
    if (active) {
      active.stop('cancelled', 'cancelled', 'Cancelled by the analysis owner.');
      await active.done;
    }
    return this.get(job.job_id, caller);
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
