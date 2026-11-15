'use strict';
/**
 * Forwarding proxy for the Telebirr receipt server.
 *
 * It does one thing: pass an allowed request to ONE fixed upstream and stream the answer back.
 * The caller can never choose the host. Who may call it is up to the configuration: anyone (the
 * default), only callers with PROXY_KEY, only ALLOWED_IPS, or both.
 *
 * No dependencies. Runs under Plesk's Node.js manager (Passenger) or plain `node app.js`.
 * Configuration is environment variables only; see README.md.
 */
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

function list(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function loadConfig(env = process.env) {
  const upstream = new URL(env.UPSTREAM_URL || 'https://transactioninfo.ethiotelecom.et');
  const config = {
    upstream,
    // Optional shared secret. Empty = no key is asked for. When set, callers send it as the
    // `X-Proxy-Key` header or as the first part of the path: /k/<key>/receipt/ABC123 (for clients
    // that can only be given a URL).
    key: env.PROXY_KEY || '',
    // Optional: only these caller IPs (comma separated). Empty = any IP.
    allowedIps: list(env.ALLOWED_IPS),
    // Only paths starting with one of these are forwarded.
    allowedPaths: list(env.ALLOWED_PATHS || '/receipt/'),
    allowedMethods: list(env.ALLOWED_METHODS || 'GET,HEAD').map((m) => m.toUpperCase()),
    // Give up on the upstream after this long. Keep it a little above your backend's own timeout.
    timeoutMs: Number(env.UPSTREAM_TIMEOUT_MS || 20000),
    maxBodyBytes: Number(env.MAX_BODY_BYTES || 1024 * 1024),
    maxConcurrent: Number(env.MAX_CONCURRENT || 50),
    // "false" only if the upstream's certificate cannot be verified and you accept that risk.
    verifyTls: String(env.UPSTREAM_VERIFY_TLS || 'true').toLowerCase() !== 'false',
    // Plesk puts nginx in front of the app, so the caller's IP is the last X-Forwarded-For entry.
    // Set to "false" when the app is reached directly.
    trustForwardedFor: String(env.TRUST_FORWARDED_FOR || 'true').toLowerCase() !== 'false',
    log: String(env.LOG_REQUESTS || 'true').toLowerCase() !== 'false',
  };
  if (!['http:', 'https:'].includes(upstream.protocol)) throw new Error('UPSTREAM_URL must be http or https');
  if (config.key && config.key.length < 24) throw new Error('PROXY_KEY must be at least 24 characters');
  config.open = !config.key && config.allowedIps.length === 0;
  return config;
}

// Headers that describe one connection and must not be passed along (RFC 9110 §7.6.1).
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host',
]);
// Never sent upstream: our own key, and headers that would reveal the real caller.
const PRIVATE = new Set([
  'x-proxy-key', 'cookie', 'authorization', 'x-forwarded-for', 'x-forwarded-host',
  'x-forwarded-proto', 'x-real-ip', 'forwarded', 'via', 'cf-connecting-ip', 'true-client-ip',
]);

function sameKey(given, expected) {
  // Compare digests so the comparison takes the same time whatever the input length.
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function callerIp(req, config) {
  let ip = req.socket.remoteAddress || '';
  if (config.trustForwardedFor && req.headers['x-forwarded-for']) {
    ip = String(req.headers['x-forwarded-for']).split(',').pop().trim() || ip;
  }
  return ip.replace(/^::ffff:/, '');
}

/** Split the key off a `/k/<key>/...` path. Returns `{ key, path }`; `key` is '' when not present. */
function splitKeyPath(url) {
  const match = /^\/k\/([^/?#]+)(\/[^#]*)?$/.exec(url);
  if (!match) return { key: '', path: url };
  let key = '';
  try { key = decodeURIComponent(match[1]); } catch { key = ''; }
  return { key, path: match[2] || '/' };
}

function allowedPath(path, config) {
  const pathname = path.split('?')[0];
  // No dot segments or encoded slashes: the prefix check must mean what it says upstream too.
  if (/(^|\/)\.\.?(\/|$)/.test(pathname) || /%2e|%2f|%5c|\\/i.test(pathname)) return false;
  return config.allowedPaths.some((prefix) => pathname.startsWith(prefix));
}

function send(res, status, message) {
  if (res.headersSent) return res.destroy();
  const body = JSON.stringify({ error: message });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function createServer(config = loadConfig()) {
  const client = config.upstream.protocol === 'https:' ? https : http;
  const agent = new client.Agent({ keepAlive: true, maxSockets: config.maxConcurrent });
  let active = 0;

  return http.createServer((req, res) => {
    const started = Date.now();
    const { key: pathKey, path } = splitKeyPath(req.url || '/');
    const ip = callerIp(req, config);
    const finish = (status, note) => {
      // The path can carry the key, and the body carries payment details: log neither.
      if (config.log) {
        const shown = path.split('?')[0].replace(/[^/]+$/, '*');
        console.log(`${new Date().toISOString()} ${ip} ${req.method} ${shown} ${status} ${Date.now() - started}ms${note ? ' ' + note : ''}`);
      }
    };

    if (req.url === '/healthz') {
      finish(200);
      return send(res, 200, 'ok');
    }
    // Wrong or missing key, or a caller not on the list: answer 404, as if nothing were here.
    const given = req.headers['x-proxy-key'] || pathKey;
    const keyOk = !config.key || (given && sameKey(given, config.key));
    const ipOk = !config.allowedIps.length || config.allowedIps.includes(ip);
    if (!keyOk || !ipOk) {
      finish(404, 'refused');
      return send(res, 404, 'not found');
    }
    if (!config.allowedMethods.includes(req.method)) {
      finish(405);
      return send(res, 405, 'method not allowed');
    }
    if (!allowedPath(path, config)) {
      finish(403, 'path');
      return send(res, 403, 'path not allowed');
    }
    if (Number(req.headers['content-length'] || 0) > config.maxBodyBytes) {
      finish(413);
      return send(res, 413, 'body too large');
    }
    if (active >= config.maxConcurrent) {
      finish(503, 'busy');
      return send(res, 503, 'busy');
    }

    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(name) && !PRIVATE.has(name)) headers[name] = value;
    }
    headers.host = config.upstream.host;

    const base = config.upstream.pathname.replace(/\/$/, '');
    active += 1;
    let done = false;
    const release = () => { if (!done) { done = true; active -= 1; } };

    const upstream = client.request({
      protocol: config.upstream.protocol,
      hostname: config.upstream.hostname,
      port: config.upstream.port || undefined,
      method: req.method,
      path: base + path,
      headers,
      agent,
      timeout: config.timeoutMs,
      rejectUnauthorized: config.verifyTls,
    }, (answer) => {
      const out = {};
      for (const [name, value] of Object.entries(answer.headers)) {
        // Redirects and cookies from the upstream are not ours to hand on.
        if (!HOP_BY_HOP.has(name) && name !== 'set-cookie') out[name] = value;
      }
      res.writeHead(answer.statusCode || 502, out);
      answer.pipe(res);
      answer.on('end', () => { release(); finish(answer.statusCode); });
      answer.on('error', () => { release(); res.destroy(); finish(502, 'upstream reset'); });
    });

    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('error', (error) => {
      release();
      const timedOut = error.message === 'timeout';
      finish(timedOut ? 504 : 502, error.code || error.message);
      send(res, timedOut ? 504 : 502, timedOut ? 'upstream timed out' : 'upstream unreachable');
    });
    // The caller went away: stop bothering the upstream.
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); release(); });

    let received = 0;
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > config.maxBodyBytes) {
        upstream.destroy();
        send(res, 413, 'body too large');
        req.destroy();
      }
    });
    req.pipe(upstream);
  });
}

module.exports = { createServer, loadConfig, splitKeyPath, allowedPath };

if (require.main === module) {
  const config = loadConfig();
  const server = createServer(config);
  // Plesk (Passenger) supplies PORT. Timeouts guard against slow or stuck callers.
  server.requestTimeout = config.timeoutMs + 5000;
  server.headersTimeout = 15000;
  server.listen(process.env.PORT || 3000, () => {
    console.log(`telebirr-proxy: forwarding ${config.allowedMethods.join(',')} ${config.allowedPaths.join(',')} to ${config.upstream.origin}`);
    if (config.open) console.warn('telebirr-proxy: OPEN, anyone can call it. Set PROXY_KEY or ALLOWED_IPS to restrict it.');
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
