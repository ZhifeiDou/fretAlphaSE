const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const express = require('express');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { hostHeaderValidation } = require('@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js');
const { isInitializeRequest, isJSONRPCRequest } = require('@modelcontextprotocol/sdk/types.js');
const { formalizeInput, formalizeOutput, analysisInput, analysisReference, analysisRead, analysisView } = require('./schemas');
const { AnalysisJobs } = require('./analysis_jobs');
const { backendVersions } = require('./analysis');
const { createAuthentication } = require('./auth');
const { FormalizationExecutor, ExecutionError } = require('./executor');
const { version: serverVersion } = require('../package.json');

const toolName = 'formalize_requirements';
const catalogMethods = new Set([
  'initialize', 'notifications/initialized', 'notifications/cancelled', 'ping',
  'tools/list', 'resources/list', 'resources/templates/list'
]);
const duration = z.int().positive().max(2147483647);
const settingsSchema = z.strictObject({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.int().min(0).max(65535).default(8004),
  resourceServerUrl: z.url().optional(),
  forgejoBaseUrl: z.url(),
  rolesConfigPath: z.string().min(1),
  authTimeoutMs: duration.default(5000),
  timeoutMs: duration.default(30000),
  maxWorkers: z.int().positive().default(2),
  maxSessions: z.int().positive().default(128),
  sessionIdleMs: duration.default(900000),
  workerPath: z.string().min(1).default(path.join(__dirname, 'worker.cjs')),
  analysisWorkerPath: z.string().min(1).default(path.join(__dirname, 'analysis-worker.cjs')),
  analysisDirectory: z.string().min(1).optional(),
  maxAnalyses: z.int().positive().default(2),
  analysisTimeoutMs: duration.default(900000)
});

async function startServer(options) {
  const settings = settingsSchema.parse(options);
  const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (!['0.0.0.0', '::'].includes(settings.host)) {
    allowedHosts.add(settings.host.includes(':') ? `[${settings.host}]` : settings.host);
  } else if (!settings.resourceServerUrl) {
    throw new TypeError('resourceServerUrl is required when binding to all interfaces.');
  }
  if (settings.resourceServerUrl) {
    const url = new URL(settings.resourceServerUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/mcp' || url.search || url.hash) {
      throw new TypeError('resourceServerUrl must be an HTTP(S) /mcp URL without credentials, query, or fragment.');
    }
    allowedHosts.add(url.hostname);
  }
  const shutdown = new AbortController();
  const authenticate = createAuthentication({
    forgejoBaseUrl: settings.forgejoBaseUrl,
    rolesConfigPath: settings.rolesConfigPath,
    timeoutMs: settings.authTimeoutMs,
    signal: shutdown.signal
  });
  const executor = new FormalizationExecutor(settings);
  if (settings.analysisDirectory) backendVersions();
  const analyses = settings.analysisDirectory ? new AnalysisJobs(settings) : null;
  const sessions = new Map();
  let closing;
  const app = express();
  app.disable('x-powered-by');
  app.use(hostHeaderValidation([...allowedHosts]));
  app.use((req, res, next) => {
    // AlphaSE uses a server-side client with a pre-provisioned Forgejo token.
    // Browser-origin requests are not an interface this service exposes.
    if (req.headers.origin !== undefined) return res.status(403).json({ error: 'origin_not_allowed' });
    if (shutdown.signal.aborted) return res.status(503).json({ error: 'shutting_down' });
    next();
  });

  async function closeSession(session) {
    session.controller.abort();
    await Promise.allSettled([...session.jobs]);
    await session.server.close();
  }

  function touch(session) {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      if (session.jobs.size) touch(session);
      else void closeSession(session);
    }, settings.sessionIdleMs);
    session.timer.unref();
  }

  async function createSession(caller) {
    const id = randomUUID();
    const server = new McpServer({ name: 'fret-alphase', version: serverVersion });
    const session = { server, caller, controller: new AbortController(), jobs: new Set(), requests: new Map(), timer: null };
    const tool = server.registerTool(toolName, {
      title: 'Formalize requirements',
      description: 'Compile FRETish into requested temporal formulas and per-requirement diagnostics. Optional variables (name/type: bool, int, real) enable strict declaration/type checking for one component; [] declares no variables. Omission leaves declared types unchecked. formalized means all requested representations were generated; retain the input with the output. Durations are discrete steps. Compilation does not establish analysis readiness, realizability, source fidelity, temporal refinement or implementation correctness.',
      inputSchema: formalizeInput,
      outputSchema: formalizeOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async (request, extra) => {
      const call = session.requests.get(extra.requestId);
      const signal = AbortSignal.any([extra.signal, session.controller.signal, call.controller.signal]);
      const work = executor.run(request, { signal });
      session.jobs.add(work);
      try {
        const result = await work;
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        if (!(error instanceof ExecutionError)) throw error;
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: error.code, message: error.message }) }] };
      } finally {
        session.jobs.delete(work);
        // MCP suppresses the response to a cancelled request. End its HTTP
        // connection too, after termination, rather than leaving it hanging.
        if (extra.signal.aborted) session.transport.closeSSEStream(extra.requestId);
      }
    });
    if (!caller.catalogOnly && !caller.allowedTools.has(toolName)) tool.disable();
    for (const [name, title, description, inputSchema, action] of [
      ['start_realizability_check', 'Start realizability check', 'Start a durable component-level FRET/Kind 2 analysis. Explicit input/output variables, assumptions and discrete time model are required. Repeating the same request_id and input returns the same job. Disconnecting does not cancel analysis.', analysisInput,
        request => analyses.read({ job_id: analyses.start(request, caller).job_id }, caller)],
      ['get_analysis', 'Read analysis', 'Read caller-owned analysis status or one digest-bound UTF-8 page of terminal evidence. Completed evidence survives restart.', analysisRead,
        request => analyses.read(request, caller)],
      ['cancel_analysis', 'Cancel analysis', 'Cancel a caller-owned analysis and wait for its worker and solver process group to terminate.', analysisReference,
        async request => { await analyses.cancel(request.job_id, caller); return analyses.read(request, caller); }]
    ]) {
      const analysisTool = server.registerTool(name, {
        title, description, inputSchema, outputSchema: analysisView,
        annotations: { readOnlyHint: name === 'get_analysis', destructiveHint: false, idempotentHint: true, openWorldHint: false }
      }, async request => {
        try {
          if (!analyses) throw new ExecutionError('analysis_unavailable', 'Configure MCP_FRET_ANALYSIS_DIR and use the Linux analysis image.');
          const result = await action(request);
          return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
        } catch (error) {
          if (!(error instanceof ExecutionError)) throw error;
          return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: error.code, message: error.message }) }] };
        }
      });
      if (!caller.catalogOnly && !caller.allowedTools.has(name)) analysisTool.disable();
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      onsessionclosed: async () => {
        session.controller.abort();
        await Promise.allSettled([...session.jobs]);
      }
    });
    session.transport = transport;
    transport.onclose = () => {
      session.controller.abort();
      clearTimeout(session.timer);
      sessions.delete(id);
    };
    sessions.set(id, session);
    try {
      await server.connect(transport);
      touch(session);
      return session;
    } catch (error) {
      await closeSession(session);
      throw error;
    }
  }

  app.all('/mcp', authenticate, express.json({ limit: '1mb', inflate: false }), async (req, res) => {
    if (res.destroyed) return;
    if (shutdown.signal.aborted) return res.status(503).json({ error: 'shutting_down' });
    if (!['POST', 'DELETE'].includes(req.method)) return res.status(405).set('Allow', 'POST, DELETE').end();
    if (Array.isArray(req.body)) return res.status(400).json({ error: 'batch_requests_not_supported' });
    const id = req.headers['mcp-session-id'];
    let session;
    if (id) {
      session = sessions.get(id);
      if (!session) return res.status(404).json({ error: 'unknown_session' });
      if (session.caller.subject !== req.caller.subject || session.caller.login !== req.caller.login ||
          session.caller.catalogOnly !== req.caller.catalogOnly) {
        return res.status(403).json({ error: 'session_owner_mismatch' });
      }
    } else if (req.method === 'POST' && isInitializeRequest(req.body)) {
      if (sessions.size >= settings.maxSessions) return res.status(503).json({ error: 'session_limit' });
      session = await createSession(req.caller);
    } else {
      return res.status(400).json({ error: 'session_required' });
    }
    if (session.caller.catalogOnly && req.method === 'POST' && !catalogMethods.has(req.body?.method)) {
      return res.status(403).json({
        error: 'forbidden', error_description: 'Catalog discovery does not grant tool or resource access.'
      });
    }
    touch(session);
    if (req.method === 'POST' && isJSONRPCRequest(req.body)) {
      const requestId = req.body.id;
      if (session.requests.has(requestId)) return res.status(409).json({ error: 'request_id_in_use' });
      const call = { controller: new AbortController() };
      session.requests.set(requestId, call);
      res.once('close', () => {
        if (!res.writableEnded) call.controller.abort();
        session.requests.delete(requestId);
      });
    }
    try {
      await session.transport.handleRequest(req, res, req.body);
    } finally {
      if (!session.transport.sessionId) await closeSession(session);
    }
  });
  app.use((error, req, res, next) => {
    if (res.headersSent || res.destroyed) return next(error);
    const status = [400, 413, 415].includes(error.status) ? error.status : 500;
    res.status(status).json({ error: status === 500 ? 'internal_error' : 'invalid_request' });
  });

  const listener = await new Promise((resolve, reject) => {
    const httpServer = app.listen(settings.port, settings.host, () => resolve(httpServer));
    httpServer.once('error', reject);
  }).catch(async error => { await analyses?.close(); throw error; });
  return {
    address: listener.address(),
    close() {
      closing ??= (async () => {
        shutdown.abort();
        const stopped = new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
        await executor.close();
        await analyses?.close();
        await Promise.all([...sessions.values()].map(closeSession));
        listener.closeAllConnections();
        await stopped;
      })();
      return closing;
    }
  };
}

async function main() {
  const env = process.env;
  const options = {
    forgejoBaseUrl: env.MCP_FRET_FORGEJO_BASE_URL,
    rolesConfigPath: env.MCP_FRET_ROLES_CONFIG_PATH,
    host: env.MCP_FRET_HOST,
    resourceServerUrl: env.MCP_FRET_RESOURCE_SERVER_URL,
    analysisDirectory: env.MCP_FRET_ANALYSIS_DIR
  };
  for (const [key, name] of [
    ['port', 'PORT'], ['authTimeoutMs', 'AUTH_TIMEOUT_MS'], ['timeoutMs', 'TIMEOUT_MS'],
    ['maxWorkers', 'MAX_WORKERS'], ['maxSessions', 'MAX_SESSIONS'], ['sessionIdleMs', 'SESSION_IDLE_MS'],
    ['maxAnalyses', 'MAX_ANALYSES'], ['analysisTimeoutMs', 'ANALYSIS_TIMEOUT_MS']
  ]) {
    if (env[`MCP_FRET_${name}`] !== undefined) options[key] = Number(env[`MCP_FRET_${name}`]);
  }
  const service = await startServer(options);
  console.log(`FRET MCP listening on ${service.address.address}:${service.address.port}/mcp`);
  const stop = () => service.close().catch(error => { console.error(error.message); process.exitCode = 1; });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

// Use Node's entry module identity; webpack has its own module wrapper.
if (createRequire(__filename).main?.filename === __filename) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { startServer };
