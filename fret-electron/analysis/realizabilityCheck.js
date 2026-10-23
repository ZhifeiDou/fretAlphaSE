// Copyright © 2025, United States Government, as represented by the Administrator of the National Aeronautics and Space Administration. All rights reserved.
// 
// The “FRET : Formal Requirements Elicitation Tool - Version 3.0” software is licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0. 
// 


// Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

//Andreas: Kind2 changed its exit code behavior with v1.9.0
//https://kind.cs.uiowa.edu/kind2_user_doc/3_output/3_exit_codes.html
//code 0 for realizable
//code 40 for unrealizable
//code 30 for unknown

//Andreas: Kind2 changed its realizability check feature with v2.2.0, to check all nodes in the Lustre file instead of just imported nodes. As a workaround, we add the option `--lus_main <file name without extension>` to prevent additional unecessary checks over auxillary nodes, such as temporal operators.

export function checkRealizabilityJKind(filePath, options, callback) {
  const jkind = spawn('jrealizability', [...options, filePath]);
  
  var stdout = '';
  jkind.stdout.on('data', (data) => {
      stdout = stdout + data.toString();
  });

  jkind.on('close', (code) => {
    switch (code) {
      case 0:
        jkind.kill();
        try {
          let result, time, realizableTraceInfo, jsonOutput;

          result = stdout.match(new RegExp('(?:\\+\\n)' + '(.*?)' + '(?:\\s\\|\\|\\s(K|R|S|T))'))[1];
          time = stdout.match(new RegExp('(Time = )(.*?)\\n'))[2];        
          
          if (options.includes('-json')) {
            var fileContent = fs.readFileSync(filePath+'.json', 'utf8');
            jsonOutput = JSON.parse(fileContent);
            if (result === "REALIZABLE") {
              realizableTraceInfo = {K: Object.keys(jsonOutput.Counterexample[0]).length - 2, Trace: jsonOutput.Counterexample};
            } else {
              realizableTraceInfo = null;
            }
          } else {
            jsonOutput = null;
          }
          callback(null, result, time, realizableTraceInfo, jsonOutput);
          break;
        } catch (err) {
          callback(new Error('JKind terminated unexpectedly.'));
          break;
        }        
      default:
        jkind.kill();
        callback(new Error('JKind terminated unexpectedly.'));
        break;
    }
  })
}

export async function runKind2(filePath, options, execution = {}) {
  const deadline = execution.deadline_ns ? BigInt(execution.deadline_ns) : null;
  let command;
  const evidence = {
    command: [], started_at: null, finished_at: null,
    stdout: '', stderr: '', stdout_truncated: false, stderr_truncated: false,
    exit_code: null, signal: null, output_complete: false
  };
  // Persist the generated input before computing a solver timeout. The empty
  // command/start fields explicitly identify preparation, not an observed run.
  await execution.observe?.({ ...evidence });
  // Kind2 accepts whole seconds. Reserve one second for parsing, durable
  // acknowledgement and final delivery before the parent's hard deadline.
  const seconds = deadline === null ? null : Math.floor(
    (Number(deadline - process.hrtime.bigint()) / 1000000 - 1000) / 1000);
  if (seconds !== null && seconds < 1) {
    const error = new Error('No complete solver second remains before the analysis return reserve.');
    error.code = 'analysis_budget_exhausted';
    throw error;
  }
  command = ['--lus_main', path.basename(filePath, path.extname(filePath)), ...options,
    ...(seconds === null ? [] : ['--timeout', String(seconds)]), filePath];
  return new Promise(resolve => {
    const child = spawn('kind2', command, { cwd: execution.cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let failure;
    const prefixes = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    let pendingEvidence;
    let observing = false;
    let observed = Promise.resolve();
    const flush = () => {
      if (observing || !pendingEvidence) return;
      observing = true;
      // Coalesce stream updates while a durable snapshot is being acknowledged.
      // The queue contains at most the in-flight snapshot and one replacement.
      observed = (async () => {
        while (pendingEvidence) {
          const snapshot = pendingEvidence;
          pendingEvidence = null;
          await execution.observe(snapshot);
        }
      })().catch(error => { failure ??= error; pendingEvidence = null; child.kill('SIGKILL'); })
        .finally(() => { observing = false; flush(); });
    };
    const publish = () => {
      if (!execution.observe) return;
      pendingEvidence = { ...evidence };
      flush();
    };
    child.once('spawn', () => {
      evidence.command = ['kind2', ...command];
      evidence.started_at = new Date().toISOString();
      publish();
    });
    const collect = (chunk, stream) => {
      if (failure) return;
      if (stream === 'stdout') stdout += chunk;
      else stderr += chunk;
      const previous = prefixes[stream];
      const remaining = 65536 - previous.length;
      if (remaining > 0) prefixes[stream] = Buffer.concat([previous, chunk.subarray(0, remaining)]);
      const truncated = evidence[`${stream}_truncated`] || chunk.length > remaining;
      if (remaining > 0 || truncated !== evidence[`${stream}_truncated`]) {
        // Streaming decode drops an incomplete final UTF-8 sequence instead of
        // inserting a replacement character beyond the byte-limited prefix.
        evidence[stream] = new TextDecoder('utf-8', { ignoreBOM: true }).decode(prefixes[stream], { stream: true });
        evidence[`${stream}_truncated`] = truncated;
        publish();
      }
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 16 * 1024 * 1024) {
        failure = new Error('Kind 2 output exceeded the 16 MiB evidence limit.');
        child.kill('SIGKILL');
      }
    };
    child.stdout.on('data', chunk => collect(chunk, 'stdout'));
    child.stderr.on('data', chunk => collect(chunk, 'stderr'));
    child.on('error', error => { failure = error; });
    child.once('close', async (code, signal) => {
      if (evidence.started_at !== null) {
        Object.assign(evidence, {
          finished_at: new Date().toISOString(), exit_code: code, signal,
          output_complete: !signal && !failure && code !== null
        });
        publish();
      }
      while (observing || pendingEvidence) await observed;
      const output = { result: 'ERROR', environmentResult: null, analysisStarted: false, time: null,
        traceInfo: null, environmentTrace: null, jsonOutput: null, error: null,
        stdout, stderr, exitCode: code, command: ['kind2', ...command] };
      try {
        if (failure) throw failure;
        if (signal) throw new Error(`Kind 2 terminated by ${signal}.`);
        const events = JSON.parse(stdout);
        output.jsonOutput = events;
        const timeout = events.some(item => item.value === 'Wallclock timeout.' ||
          (item.level === 'fatal' && item.value?.endsWith('Lib.TimeoutWall')));
        if (![0, 30, 40].includes(code) && !timeout) {
          const errors = events.filter(item => ['error', 'fatal'].includes(item.level)).map(item => item.value);
          throw new Error(`Kind 2 exited with ${code}: ${errors.join('; ') || stderr}`);
        }
        let context;
        const checks = {};
        for (const item of events) {
          if (item.objectType === 'analysisStart') {
            context = item.context || 'contract';
            if (context === 'contract') output.analysisStarted = true;
          }
          else if (item.objectType === 'analysisStop') context = null;
          else if (context && item.objectType === 'realizabilityCheck') checks[context] = item;
        }
        const result = check => check?.runtime?.timeout ? 'UNKNOWN' : check?.result?.toUpperCase() ?? (timeout ? 'UNKNOWN' : null);
        output.result = result(checks.contract);
        output.environmentResult = result(checks.environment);
        if (![output.result, output.environmentResult].every(value => ['REALIZABLE', 'UNREALIZABLE', 'UNKNOWN'].includes(value))) {
          throw new Error('Kind 2 returned no recognized contract/environment realizability result.');
        }
        output.time = checks.contract?.runtime ?? null;
        output.traceInfo = checks.contract?.deadlockingTrace ?? null;
        output.environmentTrace = checks.environment?.deadlockingTrace ?? null;
      } catch (error) { output.result = 'ERROR'; output.error = error.message; }
      resolve(output);
    });
  });
}

export function checkRealizabilityKind2(filePath, options, callback) {
  runKind2(filePath, options).then(output => {
    if (output.result === 'ERROR') callback(new Error(output.error));
    else callback(null, output.result, output.time ? `${output.time.value}${output.time.unit}` : '', output.traceInfo, output.jsonOutput);
  }, error => callback(error));
}

export function checkRealizability(filePath, engine, options, callback) {
  if (engine === 'jkind'){
    checkRealizabilityJKind(filePath, options, function (err, result, time, realizableTraceInfo, jsonOutput) {
      if (err) {
        callback(err);
      } else {
        callback(null, result, time, realizableTraceInfo, jsonOutput);
      }
    })
  } else if (engine === 'kind2'){        
    checkRealizabilityKind2(filePath, options, function (err, result, time, realizableTraceInfo, jsonOutput) {
      if (err) {
        callback(err);
      } else {
        callback(null, result, time, realizableTraceInfo, jsonOutput);
      }
    })
  }
}


// checkRealizability('/home/akatis/Documents/fret-analysis/FSMSpec.lus','kind2','-json --enable CONTRACTCK --timeout 900', function(err, result, time, traceInfo) {
//   console.log(result)
// })
