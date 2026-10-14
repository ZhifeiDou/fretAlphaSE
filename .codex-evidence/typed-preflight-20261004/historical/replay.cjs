const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { analyzeRequirements } = require(path.join(process.cwd(), 'dist/analysis.cjs'));
const historical = require(path.join(process.cwd(), 'tests/fixtures/historical-failed-models.json'));
const corrected = require(path.join(process.cwd(), 'tests/fixtures/historical-corrected-models.json'));

(async () => {
  const summary = [];
  for (const candidate of corrected.cases) {
    const archived = historical.cases.find(item => item.original.job_id === candidate.original_job_id);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fret-historical-replay-'));
    try {
      const original = await analyzeRequirements(archived.original.input, directory);
      const report = await analyzeRequirements(candidate.input, directory);
      const result = { component: candidate.component, original_job_id: candidate.original_job_id,
        original_input: archived.original.input, original_replay: original,
        corrected_input: candidate.input, corrected_report: report };
      fs.writeFileSync(path.join(__dirname, `${candidate.component}.json`), JSON.stringify(result, null, 2) + '\n');
      const entry = { component: candidate.component, original_result: original.result, original_checks: original.checks.length,
        corrected_result: report.result, corrected_input_digest: report.input_digest,
        corrected_diagnostics: report.diagnostics, toolchain: report.toolchain,
        checks: report.checks.map(check => ({ result: check.result, exit_code: check.exit_code })) };
      summary.push(entry);
      console.log(JSON.stringify(entry));
      fs.writeFileSync(path.join(__dirname, 'linux-replay-summary.json'), JSON.stringify(summary, null, 2) + '\n');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
