'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer, loadConfig, splitKeyPath, allowedPath } = require('../app.js');

const KEY = 'k'.repeat(32);

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function setup(extra = {}, handler) {
  const seen = [];
  const upstream = http.createServer(handler || ((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'a=b', 'x-upstream': 'yes' });
      res.end(`<html>receipt ${req.url}</html>`);
    });
  }));
  const upstreamPort = await listen(upstream);
  const config = loadConfig({
    UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}`, PROXY_KEY: KEY, LOG_REQUESTS: 'false',
    TRUST_FORWARDED_FOR: 'false', ...extra,
  });
  const proxy = createServer(config);
  const port = await listen(proxy);
  return {
    seen,
    url: `http://127.0.0.1:${port}`,
    close: () => { proxy.close(); upstream.close(); proxy.closeAllConnections(); upstream.closeAllConnections(); },
  };
}

test('forwards an allowed request and returns the answer', async () => {
  const t = await setup();
  const res = await fetch(`${t.url}/receipt/DI42GAQRZS`, { headers: { 'x-proxy-key': KEY, cookie: 's=1', 'x-forwarded-for': '9.9.9.9' } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<html>receipt /receipt/DI42GAQRZS</html>');
  assert.equal(res.headers.get('x-upstream'), 'yes');
  assert.equal(res.headers.get('set-cookie'), null);
  const sent = t.seen[0].headers;
  for (const hidden of ['x-proxy-key', 'cookie', 'x-forwarded-for']) assert.equal(sent[hidden], undefined);
  t.close();
});

test('the key can be given in the path, and is stripped before forwarding', async () => {
  const t = await setup();
  const res = await fetch(`${t.url}/k/${KEY}/receipt/ABC123?x=1`);
  assert.equal(res.status, 200);
  assert.equal(t.seen[0].url, '/receipt/ABC123?x=1');
  t.close();
});

test('a wrong or missing key looks like nothing is there', async () => {
  const t = await setup();
  for (const init of [{}, { headers: { 'x-proxy-key': 'wrong' } }]) {
    assert.equal((await fetch(`${t.url}/receipt/ABC`, init)).status, 404);
  }
  assert.equal((await fetch(`${t.url}/k/wrong/receipt/ABC`)).status, 404);
  assert.equal(t.seen.length, 0);
  t.close();
});

test('only allowed paths and methods are forwarded', async () => {
  const t = await setup();
  const headers = { 'x-proxy-key': KEY };
  assert.equal((await fetch(`${t.url}/admin/users`, { headers })).status, 403);
  assert.equal((await fetch(`${t.url}/receipt/%2e%2e/admin`, { headers })).status, 403);
  assert.equal((await fetch(`${t.url}/receipt/ABC`, { method: 'POST', body: 'x', headers })).status, 405);
  assert.equal(t.seen.length, 0);
  t.close();
});

test('POST is forwarded with its body when allowed, and size is capped', async () => {
  const t = await setup({ ALLOWED_METHODS: 'GET,POST', ALLOWED_PATHS: '/api/', MAX_BODY_BYTES: '100' });
  const headers = { 'x-proxy-key': KEY, 'content-type': 'application/json' };
  const ok = await fetch(`${t.url}/api/pay`, { method: 'POST', body: '{"a":1}', headers });
  assert.equal(ok.status, 200);
  assert.deepEqual([t.seen[0].method, t.seen[0].body], ['POST', '{"a":1}']);
  const big = await fetch(`${t.url}/api/pay`, { method: 'POST', body: 'x'.repeat(500), headers });
  assert.equal(big.status, 413);
  t.close();
});

test('the IP allow-list uses the last forwarded address', async () => {
  const t = await setup({ ALLOWED_IPS: '10.0.0.5', TRUST_FORWARDED_FOR: 'true' });
  const call = (xff) => fetch(`${t.url}/receipt/A`, { headers: { 'x-proxy-key': KEY, 'x-forwarded-for': xff } });
  assert.equal((await call('10.0.0.5')).status, 200);
  assert.equal((await call('10.0.0.5, 8.8.8.8')).status, 404); // spoofed first entry does not help
  t.close();
});

test('an upstream that hangs gives 504, one that is down gives 502', async () => {
  const hang = await setup({ UPSTREAM_TIMEOUT_MS: '200' }, () => {});
  assert.equal((await fetch(`${hang.url}/receipt/A`, { headers: { 'x-proxy-key': KEY } })).status, 504);
  hang.close();

  // A port that was just open and is now closed: the connection is refused at once.
  const gone = http.createServer();
  const deadPort = await listen(gone);
  await new Promise((resolve) => gone.close(resolve));
  const config = loadConfig({
    UPSTREAM_URL: `http://127.0.0.1:${deadPort}`, PROXY_KEY: KEY, LOG_REQUESTS: 'false',
    TRUST_FORWARDED_FOR: 'false', UPSTREAM_TIMEOUT_MS: '3000',
  });
  const proxy = createServer(config);
  const port = await listen(proxy);
  assert.equal((await fetch(`http://127.0.0.1:${port}/receipt/A`, { headers: { 'x-proxy-key': KEY } })).status, 502);
  proxy.close();
  proxy.closeAllConnections();
});

test('health check needs no key; config refuses a weak key', async () => {
  const t = await setup();
  assert.equal((await fetch(`${t.url}/healthz`)).status, 200);
  t.close();
  assert.throws(() => loadConfig({ PROXY_KEY: 'short' }), /PROXY_KEY/);
  assert.deepEqual(splitKeyPath('/k/abc/receipt/1'), { key: 'abc', path: '/receipt/1' });
  assert.equal(allowedPath('/receipt/../x', loadConfig({ PROXY_KEY: KEY })), false);
});
