const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, unlinkSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { spawn } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { startServer } = require('../dist/server.cjs');
const { contentDigest } = require('../src/schemas');

const toolName = 'formalize_requirements';
const input = (id = 'R1', symbol = 'enabled') => ({
  requirements: [{ id, fretish: `Controller shall always satisfy ${symbol}` }],
  representations: ['ft-inf', 'pt-smv']
});

async function readSnapshot(client, view) {
  assert.notEqual(view.status, 'running');
  assert.ok(view.snapshot);
  const pieces = [];
  let offset = 0;
  while (offset !== null) {
    const response = await client.callTool({ name: 'get_analysis', arguments: {
      job_id: view.job_id, snapshot_digest: view.snapshot.digest, offset
    }});
    assert.equal(response.isError, undefined, JSON.stringify(response));
    const page = response.structuredContent;
    assert.deepEqual(page.snapshot, view.snapshot);
    assert.equal(page.page.offset, offset);
    assert.ok(Buffer.byteLength(page.page.text) <= 65536);
    pieces.push(Buffer.from(page.page.text, 'utf8'));
    offset = page.page.next_offset;
  }
  const bytes = Buffer.concat(pieces);
  assert.equal(bytes.length, view.snapshot.bytes);
  assert.equal(contentDigest(bytes.toString('utf8')), view.snapshot.digest);
  return JSON.parse(bytes.toString('utf8'));
}

async function fixture(t, options = {}, busyWorker = false) {
  const { catalogOperator = 'operator', ...serverOptions } = options;
  options = serverOptions;
  const directory = mkdtempSync(path.join(tmpdir(), 'fret-mcp-test-'));
  const analysis = options.analysisDirectory === true;
  if (analysis) options.analysisDirectory = path.join(directory, 'analyses');
  const analysisTools = ['start_realizability_check', 'get_analysis', 'cancel_analysis'];
  const rolesConfigPath = path.join(directory, 'roles.toml');
  writeFileSync(rolesConfigPath, `
    [environment]
    FORGEJO_ADMIN_USERNAME = ${JSON.stringify(catalogOperator)}
    [agents.roles.requirement_specifier]
    enabled = true
    [agents.roles.requirement_specifier.mcp]
    allowed_tools = ["formalize_requirements"]
    allowed_resources = []
    [agents.roles.approver]
    enabled = true
    [agents.roles.approver.mcp]
    allowed_tools = ${JSON.stringify(analysis ? analysisTools : [])}
    [agents.roles.disabled]
    enabled = false
  `);
  // This is a controlled Forgejo HTTP fixture, not a real Forgejo deployment.
  const identities = new Map([
    ['author', { id: 1, login: 'requirement_specifier_8' }],
    ['other', { id: 2, login: 'requirement_specifier_9' }],
    ['viewer', { id: 3, login: 'approver_8' }],
    ['disabled', { id: 4, login: 'disabled_8' }],
    ['bad-login', { id: 5, login: 'requirement_specifier_08' }],
    ['operator', { id: 6, login: 'operator', is_admin: true }],
    ['non-admin', { id: 6, login: 'operator', is_admin: false }],
    ['missing-admin', { id: 6, login: 'operator' }],
    ['other-admin', { id: 7, login: 'other_admin', is_admin: true }],
    ['admin-agent', { id: 1, login: 'requirement_specifier_8', is_admin: true }]
  ]);
  let unavailable = false;
  const forgejo = http.createServer((req, res) => {
    assert.equal(req.url, '/api/v1/user');
    assert.equal(req.method, 'GET');
    assert.match(req.headers.authorization, /^token /);
    const user = identities.get(req.headers.authorization.slice(6));
    res.writeHead(unavailable ? 503 : user ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(unavailable ? { message: 'Unavailable' } : user ?? { message: 'Invalid token' }));
  });
  const clients = [];
  const children = [];
  let service;
  t.after(async () => {
    for (const { client, transport } of clients) {
      await transport.terminateSession().catch(() => {});
      await client.close();
    }
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = new Promise(resolve => child.once('close', resolve));
        child.kill();
        await stopped;
      }
    }
    if (service) await service.close();
    forgejo.closeAllConnections();
    await new Promise(resolve => forgejo.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => forgejo.listen(0, '127.0.0.1', resolve));
  if (busyWorker) {
    // Inject a worker that records its PID and blocks only the 'busy' input.
    // This tests lifecycle failures without adding debug modes to the service.
    options.workerPath = path.join(directory, 'worker.cjs');
    writeFileSync(options.workerPath, `
      const fs = require('node:fs');
      const path = require('node:path');
      process.once('message', request => {
        if (request.requirements[0].id === 'busy') {
          fs.writeFileSync(path.join(__dirname, 'busy.pid'), String(process.pid));
          while (true) {}
        }
        const { formalizeRequirements } = require(${JSON.stringify(path.resolve(__dirname, '../dist/formalize.cjs'))});
        process.send({ result: formalizeRequirements(request) }, () => process.disconnect());
      });
    `);
  }
  service = await startServer({
    port: 0,
    forgejoBaseUrl: `http://127.0.0.1:${forgejo.address().port}`,
    rolesConfigPath,
    ...options
  });
  const url = new URL(`http://127.0.0.1:${service.address.port}/mcp`);
  return {
    url, service, directory, identities, children, rolesConfigPath,
    forgejoBaseUrl: `http://127.0.0.1:${forgejo.address().port}`,
    setUnavailable(value) { unavailable = value; },
    async connect(token = 'author', serverUrl = url) {
      const client = new Client({ name: 'fret-integration-test', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(serverUrl, { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
      clients.push({ client, transport });
      await client.connect(transport);
      return { client, transport };
    },
    async post(body, token = 'author', sessionId, extraHeaders = {}, signal) {
      return fetch(url, {
        method: 'POST', signal,
        headers: {
          'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}), ...extraHeaders
        },
        body: JSON.stringify(body)
      });
    }
  };
}

async function waitForPid(directory) {
  const deadline = Date.now() + 5000;
  while (!readdirSync(directory).includes('busy.pid')) {
    assert.ok(Date.now() < deadline, 'worker did not start');
    await delay(20);
  }
  return Number(readFileSync(path.join(directory, 'busy.pid'), 'utf8'));
}

async function waitForExit(pid) {
  const deadline = Date.now() + 5000;
  while (true) {
    try { process.kill(pid, 0); } catch (error) { assert.equal(error.code, 'ESRCH'); return; }
    assert.ok(Date.now() < deadline, 'worker survived cancellation');
    await delay(20);
  }
}

test('official MCP client initializes, discovers schemas and gets real FRET results', async t => {
  const env = await fixture(t);
  const { client } = await env.connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), [toolName]);
  assert.equal(tools[0].inputSchema.additionalProperties, false);
  assert.equal(tools[0].inputSchema.required.includes('variables'), false);
  const declarations = tools[0].inputSchema.properties.variables;
  assert.equal(declarations.type, 'array');
  assert.equal(declarations.items.additionalProperties, false);
  assert.deepEqual(declarations.items.required, ['name', 'type']);
  assert.deepEqual(Object.keys(declarations.items.properties), ['name', 'type']);
  assert.equal(declarations.items.properties.name.pattern, '^[a-zA-Z][a-zA-Z0-9_]*$');
  assert.deepEqual(declarations.items.properties.type.enum, ['bool', 'int', 'real']);
  assert.ok(tools[0].outputSchema.properties.results);
  const request = input();
  request.requirements.push(
    { id: 'invalid', fretish: '\n  Controller shall satisfy @' },
    { id: 'free', fretish: '"This is free text."' },
    { id: 'probability', fretish: 'Controller shall with probability >= 0.9 eventually satisfy q' }
  );
  const result = await client.callTool({ name: toolName, arguments: request });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  const { results, time_basis } = result.structuredContent;
  assert.equal(time_basis, 'discrete_steps');
  assert.deepEqual(results.map(item => [item.id, item.status]), [
    ['R1', 'formalized'], ['invalid', 'invalid'], ['free', 'not_formalized'], ['probability', 'not_formalized']
  ]);
  assert.equal(results[0].formulas[0].formula, '(G enabled)');
  assert.deepEqual(results[1].diagnostics[0].location, { line: 2, column: 28 });
  assert.equal(results[3].formulas.length, 0);
});

test('MCP and the local function reject the same ambiguous or extra input', async t => {
  const env = await fixture(t);
  const { client } = await env.connect();
  for (const args of [
    { ...input(), role: 'requirement_specifier' },
    { ...input(), requirements: [input().requirements[0], input().requirements[0]] },
    { ...input(), representations: ['ft-inf', 'ft-inf'] },
    { ...input(), representations: ['unknown'] },
    { ...input(), requirements: [] },
    ...[
      null,
      {},
      [null],
      [{ name: 'enabled' }],
      [{ name: 'enabled', type: 'boolean' }],
      [{ name: 'enabled', type: 'bool', role: 'output' }],
      [{ name: 'bad-name', type: 'bool' }],
      [{ name: ' enabled', type: 'bool' }],
      [{ name: 'enabled', type: 'bool' }, { name: 'enabled', type: 'bool' }],
      [{ name: 'enabled', type: 'bool' }, { name: 'enabled', type: 'int' }]
    ].map(variables => ({ ...input(), variables }))
  ]) {
    const result = await client.callTool({ name: toolName, arguments: args });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
  }
});

test('MCP sends declared types to the real worker and preserves formulas and source diagnostics', async t => {
  const env = await fixture(t);
  const { client } = await env.connect();
  const result = await client.callTool({
    name: toolName,
    arguments: {
      requirements: [
        { id: 'real', fretish: 'Controller shall always satisfy reward >= 0.0' },
        { id: 'int', fretish: 'Controller shall always satisfy steps / 2 = 1' },
        { id: 'mismatch', fretish: '\r\n  Controller shall\n    satisfy reward = 0' },
        { id: 'bool', fretish: 'Controller shall always satisfy enabled' }
      ],
      representations: ['ft-inf', 'pt-lustre'],
      variables: [
        { name: 'reward', type: 'real' }, { name: 'steps', type: 'int' }, { name: 'enabled', type: 'bool' }
      ]
    }
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  const { results } = result.structuredContent;
  assert.deepEqual(results.map(item => [item.id, item.status]), [
    ['real', 'formalized'], ['int', 'formalized'], ['mismatch', 'invalid'], ['bool', 'formalized']
  ]);
  assert.deepEqual(results[0].formulas, [
    { representation: 'ft-inf', formula: '(G (reward >= 0.0))' },
    { representation: 'pt-lustre', formula: 'H((reward >= 0.0))' }
  ]);
  assert.equal(results[1].formulas[1].formula, 'H(((steps / 2) = 1))');
  assert.deepEqual(results[2].formulas, []);
  assert.equal(results[2].diagnostics[0].code, 'type_error');
  assert.deepEqual(results[2].diagnostics[0].location, { line: 3, column: 13 });
  assert.match(results[2].diagnostics[0].message, /real, int/);
  assert.equal(results[3].formulas[1].formula, 'H(enabled)');
});

test('MCP keeps successive real, int, untyped and empty declaration environments independent', async t => {
  const env = await fixture(t);
  const { client } = await env.connect();
  const request = {
    requirements: [
      { id: 'real-literal', fretish: 'Controller shall always satisfy value = 0.0' },
      { id: 'int-literal', fretish: 'Controller shall always satisfy value = 0' },
      { id: 'constant', fretish: 'Controller shall always satisfy true' }
    ],
    representations: ['ft-inf']
  };
  for (const [variables, expected] of [
    [[{ name: 'value', type: 'real' }], ['formalized', 'invalid', 'formalized']],
    [[{ name: 'value', type: 'int' }], ['invalid', 'formalized', 'formalized']],
    [undefined, ['formalized', 'formalized', 'formalized']],
    [[], ['invalid', 'invalid', 'formalized']],
    [undefined, ['formalized', 'formalized', 'formalized']]
  ]) {
    const response = await client.callTool({
      name: toolName, arguments: variables === undefined ? request : { ...request, variables }
    });
    assert.equal(response.isError, undefined);
    const { results } = response.structuredContent;
    assert.deepEqual(results.map(result => result.id), request.requirements.map(item => item.id));
    assert.deepEqual(results.map(result => result.status), expected);
    for (const result of results.filter(item => item.status === 'invalid')) {
      assert.deepEqual(result.formulas, []);
      assert.equal(result.diagnostics[0].code, variables.length === 0 ? 'undeclared_variable' : 'type_error');
      if (variables.length === 0) assert.match(result.diagnostics[0].message, /value has no declared type/);
    }
  }
});

test('MCP rejects a shared typed environment across components without changing untyped batches', async t => {
  const env = await fixture(t);
  const { client } = await env.connect();
  const request = {
    requirements: [
      { id: 'controller', fretish: 'Controller shall always satisfy enabled' },
      { id: 'monitor', fretish: 'Monitor shall always satisfy enabled' }
    ],
    representations: ['ft-inf']
  };
  const typed = await client.callTool({
    name: toolName, arguments: { ...request, variables: [{ name: 'enabled', type: 'bool' }] }
  });
  assert.equal(typed.isError, undefined);
  assert.deepEqual(typed.structuredContent.results.map(result => [result.id, result.status]), [
    ['controller', 'invalid'], ['monitor', 'invalid']
  ]);
  for (const result of typed.structuredContent.results) {
    assert.deepEqual(result.formulas, []);
    assert.equal(result.diagnostics[0].code, 'component_mismatch');
    assert.equal(result.diagnostics[0].location, null);
  }
  const untyped = await client.callTool({ name: toolName, arguments: request });
  assert.equal(untyped.isError, undefined);
  assert.deepEqual(untyped.structuredContent.results.map(result => result.status), ['formalized', 'formalized']);
});

test('requires Forgejo identity, checks roles, and hides forbidden tools', async t => {
  const env = await fixture(t);
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  for (const [token, expected] of [[null, 401], ['wrong', 401], ['disabled', 403], ['bad-login', 403]]) {
    const response = await env.post(body, token);
    assert.equal(response.status, expected);
    await response.json();
  }
  const { client } = await env.connect('viewer');
  assert.deepEqual((await client.listTools()).tools, []);
  assert.equal((await client.callTool({ name: toolName, arguments: input() })).isError, true);
  env.setUnavailable(true);
  const response = await env.post(body);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'authentication_unavailable');
});

test('configured admin discovers the complete catalog without tool or resource authority', async t => {
  const env = await fixture(t);
  for (const token of ['non-admin', 'missing-admin', 'other-admin']) {
    await assert.rejects(env.connect(token), /forbidden/);
  }
  const { client: agent } = await env.connect('admin-agent');
  assert.deepEqual((await agent.listTools()).tools.map(tool => tool.name), [toolName]);
  const { client, transport } = await env.connect('operator');
  assert.deepEqual(client.getServerVersion(), { name: 'fret-alphase', version: '0.3.0' });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), [
    toolName, 'start_realizability_check', 'get_analysis', 'cancel_analysis'
  ]);
  assert.ok(tools.every(tool => tool.title && tool.description && tool.inputSchema && tool.outputSchema));
  assert.ok(tools.every(tool => tool.annotations && tool.annotations.openWorldHint === false));
  for (const name of tools.map(tool => tool.name)) {
    await assert.rejects(client.callTool({ name, arguments: name === toolName ? input() : { job_id: randomUUID() } }), /Catalog discovery/);
  }
  await assert.rejects(client.readResource({ uri: 'fret://analyses/private' }), /Catalog discovery/);
  const denied = await env.post({ jsonrpc: '2.0', id: 91, method: 'tools/list' }, 'author', transport.sessionId);
  assert.equal(denied.status, 403);
  await denied.json();
  env.identities.set('operator', { id: 99, login: 'operator', is_admin: true });
  const changedSubject = await env.post({ jsonrpc: '2.0', id: 92, method: 'tools/list' }, 'operator', transport.sessionId);
  assert.equal(changedSubject.status, 403);
  await changedSubject.json();
  env.identities.set('operator', { id: 6, login: 'operator', is_admin: true });
  assert.equal((await client.listTools()).tools.length, 4);
  env.identities.set('operator', { id: 6, login: 'operator', is_admin: false });
  const revoked = await env.post({ jsonrpc: '2.0', id: 93, method: 'tools/list' }, 'operator', transport.sessionId);
  assert.equal(revoked.status, 403);
  await revoked.json();
  env.identities.set('operator', { id: 6, login: 'operator', is_admin: true });
});

test('sessions cannot switch between assignment and catalog authorization for the same user', async t => {
  const login = 'requirement_specifier_8';
  const env = await fixture(t, { catalogOperator: login });
  env.identities.set('operator', { id: 1, login, is_admin: false });
  const { client: agent, transport: agentTransport } = await env.connect('operator');
  assert.deepEqual((await agent.listTools()).tools.map(tool => tool.name), [toolName]);
  env.identities.set('operator', { id: 1, login, is_admin: true });
  const promoted = await env.post({ jsonrpc: '2.0', id: 94, method: 'tools/list' }, 'operator', agentTransport.sessionId);
  assert.equal(promoted.status, 403);
  await promoted.json();
  const { client, transport } = await env.connect('operator');
  assert.equal((await client.listTools()).tools.length, 4);
  env.identities.set('operator', { id: 1, login, is_admin: false });
  const demoted = await env.post({ jsonrpc: '2.0', id: 95, method: 'tools/list' }, 'operator', transport.sessionId);
  assert.equal(demoted.status, 403);
  await demoted.json();
  env.identities.set('operator', { id: 1, login, is_admin: true });
});

test('binds every session request to the verified user and rechecks revoked tokens', async t => {
  const env = await fixture(t);
  const { client, transport } = await env.connect();
  const body = { jsonrpc: '2.0', id: 90, method: 'tools/list' };
  const stolen = await env.post(body, 'other', transport.sessionId);
  assert.equal(stolen.status, 403);
  await stolen.json();
  assert.equal((await client.listTools()).tools.length, 1);
  env.identities.delete('author');
  const revoked = await env.post(body, 'author', transport.sessionId);
  assert.equal(revoked.status, 401);
  await revoked.json();
});

test('rejects browser origins and unexpected hostnames before computation', async t => {
  const env = await fixture(t);
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  const response = await env.post(body, 'author', undefined, { Origin: 'https://untrusted.example' });
  assert.equal(response.status, 403);
  await response.json();
  // Node fetch rewrites Host; use an actual HTTP request to test that header.
  await new Promise((resolve, reject) => {
    const request = http.request(env.url, { method: 'POST', headers: { Host: 'untrusted.example' } }, response => {
      try { assert.equal(response.statusCode, 403); } catch (error) { reject(error); }
      response.resume();
      response.once('end', resolve);
    });
    request.once('error', reject);
    request.end();
  });
});

test('two MCP sessions receive results for their own concurrent inputs', async t => {
  const env = await fixture(t);
  const a = await env.connect('author');
  const b = await env.connect('other');
  const results = await Promise.all([
    a.client.callTool({ name: toolName, arguments: input('A', 'alpha') }),
    b.client.callTool({ name: toolName, arguments: input('B', 'beta') })
  ]);
  assert.deepEqual(results.map(result => [result.structuredContent.results[0].id, result.structuredContent.results[0].formulas[0].formula]), [
    ['A', '(G alpha)'], ['B', '(G beta)']
  ]);
});

test('concurrent MCP sessions keep different declarations for the same variable isolated', async t => {
  const env = await fixture(t);
  const a = await env.connect('author');
  const b = await env.connect('other');
  const responses = await Promise.all([
    [a.client, 'real'], [b.client, 'int']
  ].map(([client, type]) => client.callTool({
    name: toolName,
    arguments: {
      requirements: [
        { id: `${type}-real-literal`, fretish: 'Controller shall always satisfy value = 0.0' },
        { id: `${type}-int-literal`, fretish: 'Controller shall always satisfy value = 0' }
      ],
      representations: ['ft-inf'],
      variables: [{ name: 'value', type }]
    }
  })));
  for (const response of responses) assert.equal(response.isError, undefined);
  assert.deepEqual(responses.map(response => response.structuredContent.results.map(result => [result.id, result.status])), [
    [['real-real-literal', 'formalized'], ['real-int-literal', 'invalid']],
    [['int-real-literal', 'invalid'], ['int-int-literal', 'formalized']]
  ]);
});

test('MCP timeout is a tool error and is returned only after the worker exits', async t => {
  const env = await fixture(t, { timeoutMs: 1500, maxWorkers: 1 }, true);
  const { client } = await env.connect();
  const pending = client.callTool({ name: toolName, arguments: input('busy') });
  const pid = await waitForPid(env.directory);
  const busy = await client.callTool({ name: toolName, arguments: input('overflow') });
  assert.equal(JSON.parse(busy.content[0].text).code, 'busy');
  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.equal(JSON.parse(result.content[0].text).code, 'timeout');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  unlinkSync(path.join(env.directory, 'busy.pid'));
  const next = client.callTool({ name: toolName, arguments: input('busy') });
  const replacement = await waitForPid(env.directory);
  assert.notEqual(replacement, pid);
  const retried = await next;
  assert.equal(JSON.parse(retried.content[0].text).code, 'timeout');
  assert.throws(() => process.kill(replacement, 0), { code: 'ESRCH' });
});

test('MCP cancellation stops a busy worker and keeps another session usable', async t => {
  const env = await fixture(t, {}, true);
  const { client } = await env.connect();
  const other = await env.connect('other');
  const controller = new AbortController();
  const pending = assert.rejects(client.callTool({ name: toolName, arguments: input('busy') }, undefined, { signal: controller.signal }));
  const pid = await waitForPid(env.directory);
  controller.abort();
  await pending;
  await waitForExit(pid);
  assert.equal((await other.client.callTool({ name: toolName, arguments: input('other') })).structuredContent.results[0].id, 'other');
});

test('a lost HTTP connection cancels its worker without a separate MCP notification', async t => {
  const env = await fixture(t, {}, true);
  const { transport } = await env.connect();
  const controller = new AbortController();
  const pending = assert.rejects(env.post({
    jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: toolName, arguments: input('busy') }
  }, 'author', transport.sessionId, {}, controller.signal).then(response => response.text()));
  const pid = await waitForPid(env.directory);
  controller.abort();
  await pending;
  await waitForExit(pid);
});

test('ending a session waits for its active worker to terminate', async t => {
  const env = await fixture(t, {}, true);
  const { client, transport } = await env.connect();
  const pending = client.callTool({ name: toolName, arguments: input('busy') }).catch(error => error);
  const pid = await waitForPid(env.directory);
  await transport.terminateSession();
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await client.close();
  const result = await pending;
  assert.ok(result instanceof Error || result.isError);
});

test('server shutdown terminates active computation and closes the listening socket', async t => {
  const env = await fixture(t, {}, true);
  const { client } = await env.connect();
  const pending = client.callTool({ name: toolName, arguments: input('busy') }).catch(error => error);
  const pid = await waitForPid(env.directory);
  await Promise.all([env.service.close(), env.service.close()]);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await client.close();
  const result = await pending;
  assert.ok(result instanceof Error || result.isError);
  await assert.rejects(fetch(env.url));
});

test('bounds sessions and reclaims expired sessions without interrupting active work', async t => {
  const env = await fixture(t, { maxSessions: 1, sessionIdleMs: 250 }, true);
  const { client, transport } = await env.connect();
  const call = client.callTool({ name: toolName, arguments: input('busy') }).catch(error => error);
  const pid = await waitForPid(env.directory);
  const initialize = {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
  };
  const full = await env.post(initialize);
  assert.equal(full.status, 503);
  await full.json();
  await delay(500);
  assert.doesNotThrow(() => process.kill(pid, 0));
  await transport.terminateSession();
  await client.close();
  await call;
  const next = await env.connect();
  await delay(500);
  const expired = await env.post({ jsonrpc: '2.0', id: 88, method: 'tools/list' }, 'author', next.transport.sessionId);
  assert.equal(expired.status, 404);
  await expired.json();
});

test('rejects RPC batches and duplicate active request IDs without replacing a computation', async t => {
  const env = await fixture(t, {}, true);
  const { transport } = await env.connect();
  const call = { jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: toolName, arguments: input('busy') } };
  const batch = await env.post([call], 'author', transport.sessionId);
  assert.equal(batch.status, 400);
  await batch.json();
  const original = env.post(call, 'author', transport.sessionId).then(response => response.text());
  const pid = await waitForPid(env.directory);
  const duplicate = await env.post(call, 'author', transport.sessionId);
  assert.equal(duplicate.status, 409);
  await duplicate.json();
  const cancel = await env.post({
    jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 77 }
  }, 'author', transport.sessionId);
  assert.equal(cancel.status, 202);
  await cancel.text();
  await waitForExit(pid);
  assert.equal(await original, '');
});

test('the built command-line entry starts from another working directory and runs its worker', async t => {
  const env = await fixture(t);
  const child = spawn(process.execPath, [path.resolve(__dirname, '../dist/server.cjs')], {
    cwd: env.directory,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'MCP_FRET_ANALYSIS_DIR')),
      MCP_FRET_FORGEJO_BASE_URL: env.forgejoBaseUrl,
      MCP_FRET_ROLES_CONFIG_PATH: env.rolesConfigPath,
      MCP_FRET_HOST: '127.0.0.1',
      MCP_FRET_PORT: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  env.children.push(child);
  let output = '';
  let errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const deadline = Date.now() + 5000;
  while (!/FRET MCP listening on 127\.0\.0\.1:\d+\/mcp/.test(output)) {
    assert.equal(child.exitCode, null, errors);
    assert.ok(Date.now() < deadline, `command-line startup did not finish: ${errors}`);
    await delay(20);
  }
  const port = /127\.0\.0\.1:(\d+)\/mcp/.exec(output)[1];
  const { client } = await env.connect('author', new URL(`http://127.0.0.1:${port}/mcp`));
  const result = await client.callTool({ name: toolName, arguments: input('cli') });
  assert.equal(result.structuredContent.results[0].id, 'cli');
  assert.equal(result.structuredContent.results[0].formulas[0].formula, '(G enabled)');
  assert.equal(errors, '');
  assert.deepEqual(readdirSync(env.directory), ['roles.toml']);
});

test('an approver can run real analysis through MCP and retrieve evidence after reconnecting', {
  skip: process.platform !== 'linux' && 'Real analysis requires the Linux image.'
}, async t => {
  const env = await fixture(t, { analysisDirectory: true });
  const initial = await env.connect('viewer');
  assert.deepEqual((await initial.client.listTools()).tools.map(tool => tool.name), [
    'start_realizability_check', 'get_analysis', 'cancel_analysis'
  ]);
  const args = {
    request_id: randomUUID(), component: 'Controller',
    requirements: [
      { id: 'R-positive', fretish: 'Controller shall always satisfy q', kind: 'guarantee', source_refs: ['source:1'] },
      { id: 'R-negative', fretish: 'Controller shall always satisfy !q', kind: 'guarantee', source_refs: ['source:2'] }
    ],
    variables: [{ name: 'q', type: 'bool', role: 'output', meaning: 'Controlled output' }],
    time_model: { kind: 'discrete_steps', description: 'One controller evaluation per step.' },
    options: { timeout_ms: 15000, diagnose: true }
  };
  const response = await initial.client.callTool({ name: 'start_realizability_check', arguments: args });
  assert.equal(response.isError, undefined, JSON.stringify(response));
  const job = response.structuredContent;
  assert.equal(job.status, 'running');
  assert.equal(job.last_phase, 'preparing');
  assert.equal(job.snapshot, null);
  assert.equal(job.page, null);
  await initial.transport.terminateSession();
  await initial.client.close();
  const reconnect = await env.connect('viewer');
  const retried = await reconnect.client.callTool({ name: 'start_realizability_check', arguments: args });
  assert.equal(retried.structuredContent.job_id, job.job_id);
  const deadline = Date.now() + 15000;
  let finished;
  do {
    const response = await reconnect.client.callTool({ name: 'get_analysis', arguments: { job_id: job.job_id } });
    assert.equal(response.isError, undefined, JSON.stringify(response));
    finished = response.structuredContent;
    assert.ok(Date.now() < deadline, 'MCP analysis did not complete');
    if (finished.status === 'running') await delay(30);
  } while (finished.status === 'running');
  finished = await readSnapshot(reconnect.client, finished);
  assert.equal(finished.status, 'completed', JSON.stringify(finished.error));
  assert.equal(finished.report.result, 'unrealizable');
  assert.deepEqual(finished.report.diagnosis.conflicts, [['R-positive', 'R-negative']]);
  assert.ok(finished.report.checks[0].counterexample.contract.length);
  assert.match(finished.report_digest, /^sha256:/);
  assert.deepEqual(finished.input, args);
  assert.equal(finished.report.toolchain.adapter, '0.3.0');
  assert.equal(finished.diagnostics.last_phase, 'diagnosing');
  assert.equal(finished.diagnostics.checkpoint, null);
  assert.equal(finished.diagnostics.checkpoint_digest, null);
  assert.equal(finished.diagnostics.last_check.output_complete, true);
  assert.match(finished.diagnostics.last_check.lustre_digest, /^sha256:/);
  // This second approver has tool permission, but does not own the job.
  env.identities.set('second-reviewer', { id: 12, login: 'approver_9' });
  const other = await env.connect('second-reviewer');
  for (const name of ['get_analysis', 'cancel_analysis']) {
    const forbidden = await other.client.callTool({ name, arguments: { job_id: job.job_id } });
    assert.equal(forbidden.isError, true);
    assert.equal(JSON.parse(forbidden.content[0].text).code, 'analysis_not_found');
  }
  const author = await env.connect('author');
  assert.equal((await author.client.callTool({ name: 'start_realizability_check', arguments: args })).isError, true);
});

test('MCP preserves preparation-timeout diagnostics across authenticated retrieval', {
  skip: process.platform !== 'linux' && 'Analysis jobs require Linux.'
}, async t => {
  const env = await fixture(t, { analysisDirectory: true });
  const { client } = await env.connect('viewer');
  const args = {
    request_id: randomUUID(), component: 'Controller',
    requirements: [{ id: 'short', fretish: 'Controller shall always satisfy q', kind: 'guarantee', source_refs: ['source:short'] }],
    variables: [{ name: 'q', type: 'bool', role: 'output', meaning: 'Controlled output' }],
    time_model: { kind: 'discrete_steps', description: 'One controller evaluation per step.' },
    options: { timeout_ms: 1, diagnose: false }
  };
  const started = await client.callTool({ name: 'start_realizability_check', arguments: args });
  assert.equal(started.isError, undefined, JSON.stringify(started));
  const deadline = Date.now() + 5000;
  let job = started.structuredContent;
  while (job.status === 'running') {
    assert.ok(Date.now() < deadline, 'preparation timeout was not persisted');
    await delay(20);
    const response = await client.callTool({ name: 'get_analysis', arguments: { job_id: job.job_id } });
    assert.equal(response.isError, undefined, JSON.stringify(response));
    job = response.structuredContent;
  }
  job = await readSnapshot(client, job);
  assert.equal(job.status, 'timed_out');
  assert.equal(job.report, null);
  assert.equal(job.report_digest, null);
  assert.equal(job.diagnostics.last_phase, 'preparing');
  assert.equal(job.diagnostics.last_check, null);
  assert.equal(job.diagnostics.checkpoint, null);
  assert.equal(job.input_digest, contentDigest(job.input));
});

test('maximum generated-input evidence uses bounded digest-bound SSE pages', {
  skip: process.platform !== 'linux' && 'Analysis jobs require Linux.'
}, async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'fret-large-evidence-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const worker = path.join(directory, 'prepared.cjs');
  const acknowledged = path.join(directory, 'prepared-acknowledged');
  writeFileSync(worker, `
    const fs = require('node:fs');
    const path = require('node:path');
    const { createHash } = require('node:crypto');
    process.once('message', ({ input, workDirectory }) => {
      // Controlled preparation evidence only: no solver runs or final report.
      const lustre = 'x'.repeat(1024 * 1024);
      fs.writeFileSync(path.join(workDirectory, 'FretContract.lus'), lustre);
      process.send({ phase: 'checking' });
      process.on('message', message => {
        if (message.ack === 1) fs.writeFileSync(${JSON.stringify(acknowledged)}, 'ready');
      });
      process.send({ update_id: 1, check: {
        name: 'FretContract.lus', requirement_ids: input.requirements.map(item => item.id), command: [],
        started_at: null, finished_at: null,
        toolchain: { fret: 'sha256:' + 'a'.repeat(64), adapter: '0.3.0', kind2: 'kind2 v2.2.0', z3: 'Z3 version 4.14.1 - 64 bit' },
        lustre, lustre_digest: 'sha256:' + createHash('sha256').update(lustre).digest('hex'),
        lustre_bytes: Buffer.byteLength(lustre), lustre_truncated: false,
        stdout: '', stderr: '', stdout_truncated: false, stderr_truncated: false,
        exit_code: null, signal: null, output_complete: false
      }});
      setInterval(() => {}, 1000);
    });
  `);
  const env = await fixture(t, { analysisDirectory: true, analysisWorkerPath: worker });
  const { client, transport } = await env.connect('viewer');
  const started = await client.callTool({ name: 'start_realizability_check', arguments: {
    request_id: randomUUID(), component: 'Controller',
    requirements: [{ id: 'large', fretish: 'Controller shall always satisfy q', kind: 'guarantee', source_refs: ['source:large'] }],
    variables: [{ name: 'q', type: 'bool', role: 'output', meaning: 'Controlled output' }],
    time_model: { kind: 'discrete_steps', description: 'One controller evaluation per step.' },
    options: { timeout_ms: 15000, diagnose: false }
  }});
  const job_id = started.structuredContent.job_id;
  const deadline = Date.now() + 5000;
  while (!existsSync(acknowledged)) {
    assert.ok(Date.now() < deadline, 'large prepared evidence was not persisted');
    await delay(20);
  }
  const cancelled = await client.callTool({ name: 'cancel_analysis', arguments: { job_id } });
  assert.equal(cancelled.isError, undefined, JSON.stringify(cancelled));
  const view = cancelled.structuredContent;
  assert.equal(view.status, 'cancelled');
  assert.equal(view.page, null);
  assert.ok(view.snapshot.bytes > 1024 * 1024);
  const response = await env.post({ jsonrpc: '2.0', id: 901, method: 'tools/call',
    params: { name: 'get_analysis', arguments: { job_id, snapshot_digest: view.snapshot.digest, offset: 0 } } }, 'viewer', transport.sessionId);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const bytes = await response.text();
  assert.ok(Buffer.byteLength(bytes) < 1024 * 1024);
  const result = await readSnapshot(client, view);
  assert.equal(result.job_id, job_id);
  assert.equal(result.report, null);
  assert.equal(result.diagnostics.last_check.lustre.length, 1024 * 1024);
  assert.equal(result.diagnostics.last_check.lustre_digest, contentDigest(result.diagnostics.last_check.lustre));
  assert.equal((await client.callTool({ name: 'cancel_analysis', arguments: { job_id } })).structuredContent.snapshot.digest,
    view.snapshot.digest);
});
