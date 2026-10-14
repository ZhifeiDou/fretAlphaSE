const { readFileSync } = require('node:fs');
const { parse } = require('smol-toml');
const { z } = require('zod');

function createAuthentication({ forgejoBaseUrl, rolesConfigPath, timeoutMs = 5000, signal }) {
  const base = new URL(forgejoBaseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new TypeError('forgejoBaseUrl must be an HTTP(S) base URL without credentials, query, or fragment.');
  }
  const userUrl = `${base.href.replace(/\/$/, '')}/api/v1/user`;
  const config = parse(readFileSync(rolesConfigPath, 'utf8'));
  const configuredRoles = z.record(z.string().min(1), z.object({
    enabled: z.boolean(),
    mcp: z.object({ allowed_tools: z.array(z.string().min(1)) }).optional()
  })).parse(config.agents?.roles);
  const roles = new Map();
  for (const [name, role] of Object.entries(configuredRoles)) {
    if (!role.enabled) continue;
    if (!role.mcp) throw new TypeError(`Enabled role ${name} is missing mcp.allowed_tools.`);
    roles.set(name, new Set(role.mcp.allowed_tools));
  }

  return async (req, res, next) => {
    const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '');
    const unauthorized = () => res.status(401)
      .set('WWW-Authenticate', 'Bearer realm="fret-mcp"')
      .json({ error: 'invalid_token', error_description: 'A valid Forgejo bearer token is required.' });
    if (!match) return unauthorized();
    let user;
    try {
      const response = await fetch(userUrl, {
        headers: { Authorization: `token ${match[1]}`, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])])
      });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        return unauthorized();
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Forgejo identity lookup failed.');
      }
      user = z.object({ id: z.int().positive(), login: z.string().trim().min(1) }).parse(await response.json());
    } catch {
      // Never downgrade to unauthenticated access or expose tokens/upstream bodies.
      return res.status(503).json({ error: 'authentication_unavailable' });
    }

    const assignments = [...roles.keys()].filter(role =>
      user.login.startsWith(`${role}_`) && /^[1-9][0-9]*$/.test(user.login.slice(role.length + 1))
    );
    if (assignments.length !== 1) {
      return res.status(403).json({ error: 'forbidden', error_description: 'An enabled issue-scoped agent login is required.' });
    }
    const role = assignments[0];
    req.caller = { subject: user.id, login: user.login, role, allowedTools: roles.get(role) };
    next();
  };
}

module.exports = { createAuthentication };
