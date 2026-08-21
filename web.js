#!/usr/bin/env node
// claude-msg web frontend: a local page that takes part in the bus as `user`.
//
// Usage: node web.js   (or Start-ClaudeWeb)   then open http://127.0.0.1:8788
// Env vars: CLAUDE_MSG_PORT (broker, default 8787), CLAUDE_WEB_PORT (default 8788)
//
// Two long-lived broker connections belong to THIS process, not to a browser tab:
//   - one recv loop, to drain user's queue and keep `user` in the roster
//     (recv's touch is the only keepalive outside chat mode)
//   - one tap per open page, for display; tap carries every message on the bus,
//     including A -> B traffic that never enters user's queue
// The page is the only network surface this adds, so every POST goes through the
// same four checks (see guard) — a random web page must not be able to put words
// on the bus, and /command injects keystrokes into a terminal window.

const http = require('http');
const net = require('net');
const crypto = require('crypto');

const HOST = '127.0.0.1'; // loopback only
const BROKER_PORT = process.env.CLAUDE_MSG_PORT ? Number(process.env.CLAUDE_MSG_PORT) : 8787;
const PORT = process.env.CLAUDE_WEB_PORT ? Number(process.env.CLAUDE_WEB_PORT) : 8788;
const NAME = 'user';
const NONCE = crypto.randomBytes(16).toString('base64');

// One-shot broker request (same shape as msg.js): connect, send, read one line.
function ask(obj) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(BROKER_PORT, HOST);
    let buf = '';
    let done = false;
    socket.on('connect', () => socket.write(JSON.stringify(obj) + '\n'));
    socket.on('data', (c) => {
      buf += c.toString('utf8');
      const i = buf.indexOf('\n');
      if (i >= 0 && !done) {
        done = true;
        try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e); }
        socket.end();
      }
    });
    socket.on('error', (e) => { if (!done) { done = true; reject(e); } });
    socket.on('close', () => { if (!done) { done = true; reject(new Error('broker not running')); } });
  });
}

// wait 300 (not the agents' 540): the roster TTL is 600s and this touch is the
// only thing keeping `user` online, so leave real headroom.
async function recvLoop() {
  for (;;) {
    try {
      await ask({ cmd: 'recv', name: NAME, wait: 300 }); // messages discarded: the tap already showed them
    } catch (_) {
      await new Promise((r) => setTimeout(r, 2000)); // broker down, try again
    }
  }
}

// One tap per page. When the broker goes away we just end the response and let
// EventSource reconnect on its own.
function tapToSSE(res) {
  const sock = net.connect(BROKER_PORT, HOST, () => sock.write(JSON.stringify({ cmd: 'tap' }) + '\n'));
  let buf = '';
  sock.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) res.write('data: ' + line + '\n\n');
    }
  });
  const bye = () => { try { res.end(); } catch (_) { /* already gone */ } };
  sock.on('error', bye);
  sock.on('close', bye);
  res.on('close', () => sock.destroy());
}

// The four checks. Order is cost order; any failure is a flat 403.
// 1. JSON content type — a cross-site simple request cannot set it, so the
//    browser is forced into a preflight, which we never answer (no OPTIONS
//    handler, no Access-Control-Allow-* anywhere: that is the whole defence).
// 2+3. Origin / Sec-Fetch-Site must be this page.
// 4. Host must be the loopback name we listen on — this is the one that stops
//    DNS rebinding, where an attacker's domain resolves to 127.0.0.1.
// (The fourth leg, binding to 127.0.0.1 only, is in listen() below.)
function guard(req) {
  const host = req.headers.host;
  if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}`) return 'bad host';
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return 'cross-site';
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) return 'bad origin';
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return 'bad content-type';
  return null;
}

function readJson(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// The page lives in web.html next to this file: keeping it out of a template
// literal keeps its regexes and backticks readable. Read once, nonce patched in.
const fs = require('fs');
const path = require('path');
let PAGE_SRC = null;
function page() {
  if (PAGE_SRC === null) PAGE_SRC = fs.readFileSync(path.join(__dirname, 'web.html'), 'utf8');
  return PAGE_SRC.split('__NONCE__').join(NONCE);
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      // frame-ancestors / base-uri / form-action do NOT fall back to default-src,
      // so they are spelled out. The nonce is what makes an injected <script> or
      // an onerror= handler inert if the renderer is ever wrong.
      'content-security-policy': `default-src 'none'; script-src 'nonce-${NONCE}'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    });
    return res.end(page());
  }

  if (req.method === 'GET' && url === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    return tapToSSE(res);
  }

  if (req.method === 'GET' && url === '/who') {
    try { return json(res, 200, await ask({ cmd: 'who' })); }
    catch (e) { return json(res, 200, { ok: false, error: e.message }); }
  }

  if (req.method === 'POST' && (url === '/send' || url === '/command')) {
    const bad = guard(req);
    if (bad) return json(res, 403, { ok: false, error: bad });
    const body = await readJson(req);
    if (!body) return json(res, 400, { ok: false, error: 'bad json' });
    const cmd = url === '/send'
      ? { cmd: 'send', from: NAME, to: body.to, text: body.text }
      : { cmd: 'command', name: body.name, target: body.target };
    try { return json(res, 200, await ask(cmd)); }
    catch (e) { return json(res, 200, { ok: false, error: e.message }); }
  }

  res.writeHead(404).end();
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`port ${PORT} is already in use — the web frontend may already be running.`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  console.log(`claude-msg web frontend on http://${HOST}:${PORT}  (broker ${HOST}:${BROKER_PORT})`);
  recvLoop();
});
