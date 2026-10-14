const { fork } = require('node:child_process');

if (process.argv.includes('--compute')) {
  const { analyzeRequirements } = require('./analysis');
  process.once('message', async ({ input, workDirectory }) => {
    let response;
    try {
      response = { report: await analyzeRequirements(input, workDirectory,
        phase => process.send({ phase })) };
    } catch (error) {
      response = { error: { code: 'analysis_error', message: error.message } };
    }
    process.send(response, error => {
      process.exitCode = error ? 1 : 0;
      if (process.connected) process.disconnect();
    });
  });
} else {
  // The group leader only supervises; synchronous parser/model generation
  // runs in a child. Thus parent loss can stop even a CPU-bound computation.
  const lostParent = () => process.kill(-process.pid, 'SIGKILL');
  const send = (message, sent = () => {}) => {
    if (!process.connected) return lostParent();
    process.send(message, error => error ? lostParent() : sent());
  };
  process.once('disconnect', lostParent);
  process.once('message', request => {
    const child = fork(__filename, ['--compute'], { cwd: request.workDirectory,
      execArgv: ['--max-old-space-size=256'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let response;
    child.on('message', message => {
      if (message.phase) send(message);
      else response = message;
    });
    child.on('error', error => {
      response = { error: { code: 'worker_error', message: error.message } };
    });
    child.once('close', (code, signal) => {
      if (code !== 0 || signal || !response) {
        response = { error: { code: 'worker_error', message: 'Analysis computation exited abnormally.' } };
      }
      // Exit only after the terminal message is sent. The service waits for
      // this group leader to close before persisting and cleaning the job.
      send(response, () => {
        process.removeListener('disconnect', lostParent);
        if (process.connected) process.disconnect();
      });
    });
    child.send(request);
  });
}
