const { formalizeRequirements } = require('./formalize');

// One process handles exactly one immutable request. This computation neither
// opens FRET's desktop databases nor creates files or solver subprocesses.
process.once('message', request => {
  let response;
  try {
    response = { result: formalizeRequirements(request) };
  } catch (error) {
    response = { error: { code: 'worker_error', message: error.message } };
  }
  process.send(response, error => {
    process.exitCode = error ? 1 : 0;
    if (process.connected) process.disconnect();
  });
});

process.once('disconnect', () => {
  // Handles an idle worker whose parent disappears before sending input.
  process.exit();
});
