// Smoke check for the tap feed and the web frontend: node web-smoke.js
// Starts its own broker + web.js on spare ports, so a live session is untouched.
// ponytail: no framework, plain asserts; this is the one check the tap/guard
// logic leaves behind, not a test suite.
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');

const BP = 8797, WP = 8798;
const env = { ...process.env, CLAUDE_MSG_PORT: String(BP), CLAUDE_WEB_PORT: String(WP) };
const kids = [];
function start(file) {
  const p = spawn(process.execPath, [path.join(__dirname, file)], { env, stdio: 'ignore' });
  kids.push(p);
  return p;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ask(obj) {
  return new Promise((resolve, reject) => {
    const s = net.connect(BP, '127.0.0.1');
    let buf = '';
    s.on('connect', () => s.write(JSON.stringify(obj) + '\n'));
    s.on('data', (c) => {
      buf += c;
      const i = buf.indexOf('\n');
      if (i >= 0) { resolve(JSON.parse(buf.slice(0, i))); s.end(); }
    });
    s.on('error', reject);
  });
}

function req(opts, body) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: WP, ...opts }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', (e) => resolve({ code: 0, body: e.message }));
    if (body) r.write(body);
    r.end();
  });
}

// A tap socket that records every event it is given.
function tap() {
  const events = [];
  const s = net.connect(BP, '127.0.0.1', () => s.write(JSON.stringify({ cmd: 'tap' }) + '\n'));
  let buf = '';
  s.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) events.push(JSON.parse(line));
    }
  });
  return { events, socket: s };
}

(async () => {
  start('broker.js');
  start('web.js');
  for (let i = 0; i < 40; i++) { try { await ask({ cmd: 'ping' }); break; } catch (_) { await sleep(100); } }

  // --- tap gets everything, including traffic that never touches user's queue
  const t = tap();
  await sleep(200);
  assert(t.events.some((e) => e.type === 'ready'), 'ready marker missing');
  const readyAt = t.events.findIndex((e) => e.type === 'ready');

  await ask({ cmd: 'join', name: 'alice' });
  await ask({ cmd: 'join', name: 'bob' });
  await ask({ cmd: 'send', from: 'alice', to: 'bob', text: 'hi bob' });
  await sleep(150);
  const live = t.events.slice(readyAt + 1);
  const msgs = live.filter((e) => e.type === 'msg');
  assert.strictEqual(msgs.length, 1, 'A->B should reach the tap exactly once');
  assert.strictEqual(msgs[0].text, 'hi bob');
  assert.strictEqual(msgs[0].queued, false, 'bob is online');
  assert.strictEqual(live.filter((e) => e.type === 'log' && /joined/.test(e.text)).length, 2);
  assert(!/\u001b/.test(live.find((e) => e.type === 'log').text), 'log events must be ANSI-free');

  // --- @all reaches the tap once, not once per recipient
  await ask({ cmd: 'send', from: 'alice', to: 'all', text: 'broadcast' });
  await sleep(150);
  assert.strictEqual(t.events.filter((e) => e.type === 'msg' && e.text === 'broadcast').length, 1,
    '@all must not duplicate on the tap');

  // --- offline recipient is flagged
  await ask({ cmd: 'send', from: 'alice', to: 'ghost', text: 'anyone?' });
  await sleep(120);
  assert.strictEqual(t.events.find((e) => e.text === 'anyone?').queued, true);

  // --- thinking works with chatMode off (the whole point of the setThinking fix)
  const before = t.events.filter((e) => e.type === 'thinking').length;
  ask({ cmd: 'recv', name: 'carol', wait: 5 }); // parks a waiter
  await sleep(150);
  await ask({ cmd: 'send', from: 'alice', to: 'carol', text: 'work' });
  await sleep(200);
  const think = t.events.filter((e) => e.type === 'thinking');
  assert(think.length > before, 'no thinking events in background mode');
  assert.strictEqual(think[think.length - 1].name, 'carol');
  assert.strictEqual(think[think.length - 1].on, true);

  // --- a second tap gets the history replayed, then its own ready
  const t2 = tap();
  await sleep(200);
  const r2 = t2.events.findIndex((e) => e.type === 'ready');
  assert(r2 > 0, 'second tap got no replay');
  assert(t2.events.slice(0, r2).some((e) => e.text === 'hi bob'), 'replay missing an earlier message');
  assert(t2.events[r2].thinking.includes('carol'), 'ready must carry current thinking state');

  // --- command: whitelist only
  const bad = await ask({ cmd: 'command', name: 'constructor', target: 'work' });
  assert.strictEqual(bad.ok, false, 'non-whitelisted command accepted');
  const noTarget = await ask({ cmd: 'command', name: 'stop' });
  assert.strictEqual(noTarget.ok, false, 'missing target accepted');

  // --- HTTP surface
  const page = await req({ method: 'GET', path: '/' });
  assert.strictEqual(page.code, 200);
  const csp = page.headers['content-security-policy'];
  for (const d of ['frame-ancestors', 'base-uri', 'form-action', 'nonce-']) {
    assert(csp.includes(d), 'CSP missing ' + d);
  }
  assert(!page.body.includes('__NONCE__'), 'nonce placeholder not replaced');
  assert(page.body.includes('nonce="' + csp.match(/nonce-([^']+)/)[1] + '"'), 'page nonce != header nonce');

  const ok = await req({ method: 'POST', path: '/send', headers: { 'content-type': 'application/json' } },
    JSON.stringify({ to: 'bob', text: 'from the web' }));
  assert.strictEqual(JSON.parse(ok.body).ok, true, 'POST /send rejected: ' + ok.body);
  await sleep(150);
  const web = t.events.find((e) => e.text === 'from the web');
  assert(web && web.from === 'user', 'web send did not arrive as user');

  const noCt = await req({ method: 'POST', path: '/send', headers: { 'content-type': 'text/plain' } }, '{}');
  assert.strictEqual(noCt.code, 403, 'simple content-type was not rejected');
  const badHost = await req({ method: 'POST', path: '/send',
    headers: { 'content-type': 'application/json', host: 'evil.com' } }, '{}');
  assert.strictEqual(badHost.code, 403, 'DNS-rebinding host was not rejected');
  const badOrigin = await req({ method: 'POST', path: '/send',
    headers: { 'content-type': 'application/json', origin: 'http://evil.com' } }, '{}');
  assert.strictEqual(badOrigin.code, 403, 'cross origin was not rejected');
  const crossSite = await req({ method: 'POST', path: '/send',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' } }, '{}');
  assert.strictEqual(crossSite.code, 403, 'sec-fetch-site was not honoured');
  const opts = await req({ method: 'OPTIONS', path: '/send' });
  assert.strictEqual(opts.code, 404, 'OPTIONS must not be answered');
  assert(!Object.keys(opts.headers).some((h) => h.startsWith('access-control')), 'CORS header leaked');

  // --- user stays in the roster via the recv loop web.js holds
  const who = await ask({ cmd: 'who' });
  assert(who.peers.some((p) => p.name === 'user'), 'user is not online');

  console.log('all checks passed');
  kids.forEach((k) => k.kill());
  process.exit(0);
})().catch((e) => {
  console.error('FAILED:', e.message);
  kids.forEach((k) => k.kill());
  process.exit(1);
});
