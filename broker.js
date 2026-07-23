#!/usr/bin/env node
// claude-msg broker: a minimal message bus (NDJSON over localhost TCP)
// Every session picks an arbitrary name to send/receive with (join guards against
// name clashes, who lists members, @all broadcasts).
// recv supports a blocking wait: when the queue is empty the connection is held
// until a message arrives or the wait times out.
//
// Usage: node broker.js
//   Foreground (Start-ClaudeBroker) = chat mode: the window doubles as the human's
//     chat window; type "<member> <message>" to send.
//   Background (msg up) = plain broker; the human uses msg send/recv instead.
// Env vars: CLAUDE_MSG_PORT (default 8787), CLAUDE_MSG_STALE_MS (member TTL, default 10 minutes)

const net = require('net');
const readline = require('readline');

const HOST = '127.0.0.1'; // loopback only, unreachable from outside
const PORT = process.env.CLAUDE_MSG_PORT ? Number(process.env.CLAUDE_MSG_PORT) : 8787;

// Chat mode: when running in the foreground (stdin is a TTY) the broker window
// doubles as the human's chat window. Messages addressed to the human are printed
// directly instead of being queued, and typing "<member> <message>" sends.
// Automatically off when started by `msg up` in the background (stdio ignore),
// which behaves exactly like the older broker-only version.
const HUMAN = 'user';
const chatMode = !!process.stdin.isTTY;
let rl = null;

// One fixed colour per name: hand out the next slot on first sight, so the first
// 8 names are guaranteed distinct (hashing would collide).
const PALETTE = [36, 33, 35, 32, 34, 91, 96, 95];
const colorOf = new Map(); // name -> ANSI colour code
function cname(name) {
  if (name === HUMAN) return '\x1b[1;97myou\x1b[0m';
  if (!colorOf.has(name)) colorOf.set(name, PALETTE[colorOf.size % PALETTE.length]);
  return `\x1b[${colorOf.get(name)}m${name}\x1b[0m`;
}

// Display width: strip ANSI codes, count CJK/fullwidth chars as 2 columns
// (needed to align the banner box).
// ponytail: only the CJK/fullwidth ranges, no narrow dingbats like ✻; good
// enough without pulling in wcwidth
const FULLWIDTH = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
function dispWidth(s) {
  const bare = s.replace(/\x1b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of bare) w += FULLWIDTH.test(ch) ? 2 : 1;
  return w;
}

// Claude Code style rounded box: prints the startup banner
function banner(lines) {
  const W = Math.max(...lines.map(dispWidth)) + 2;
  const dim = '\x1b[38;5;208m'; // orange border, echoing Claude Code
  const R = '\x1b[0m';
  console.log(`${dim}╭${'─'.repeat(W)}╮${R}`);
  for (const l of lines) console.log(`${dim}│${R} ${l}${' '.repeat(W - dispWidth(l) - 1)}${dim}│${R}`);
  console.log(`${dim}╰${'─'.repeat(W)}╯${R}`);
}

const queues = new Map();  // name -> [msg, ...]
const waiters = new Map(); // name -> [{ socket, timer }, ...]
const roster = new Map();  // name -> lastSeen (ms). ponytail: no leave/prune, filtering with alive() on read is enough
const STALE_MS = Number(process.env.CLAUDE_MSG_STALE_MS || 10 * 60 * 1000);

function touch(name) { if (name && name !== '?') roster.set(name, Date.now()); }
function alive(name) { return (Date.now() - (roster.get(name) || 0)) < STALE_MS; }

function getQueue(name) {
  if (!queues.has(name)) queues.set(name, []);
  return queues.get(name);
}

function respond(socket, obj) {
  try {
    socket.write(JSON.stringify(obj) + '\n');
    socket.end();
  } catch (_) { /* socket may already be closed */ }
}

// If someone is waiting on `name`, deliver straight to them and drop the waiter;
// otherwise return false so the caller queues the message.
function deliverToWaiter(name, msg) {
  const list = waiters.get(name);
  if (list && list.length) {
    const w = list.shift();
    clearTimeout(w.timer);
    respond(w.socket, { ok: true, messages: [msg] });
    return true;
  }
  return false;
}

function log(s) {
  const line = `\x1b[90m${new Date().toLocaleTimeString('en-GB')}\x1b[0m  ${s}`;
  if (rl) {
    // Clear the input line while typing, then restore it (prompt(true) keeps what was typed)
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    console.log(line);
    rl.prompt(true);
  } else console.log(line);
}

// Delivery order: hand to a waiter → in chat mode show messages for the human via
// log (never queued) → otherwise queue.
function deliverOrQueue(name, msg) {
  if (deliverToWaiter(name, msg)) return;
  if (name === HUMAN && chatMode) return;
  getQueue(name).push(msg);
}

function logMsg(msg, extra = '') {
  const arrow = msg.to === 'all' ? `${cname(msg.from)} ⇒ @all` : `${cname(msg.from)} → ${cname(msg.to)}`;
  // Mark messages meant for the human with ★ and brighten the body so they stand out
  const text = msg.to === HUMAN || msg.to === 'all' ? `\x1b[97m${msg.text}\x1b[0m` : msg.text;
  log(`${msg.to === HUMAN ? '\x1b[1;93m★\x1b[0m ' : ''}${arrow}: ${text}${extra}`);
}

function handle(req, socket) {
  const cmd = req.cmd;

  if (cmd === 'send') {
    if (!req.to) return respond(socket, { ok: false, error: 'missing "to"' });
    touch(req.from);
    if (req.to === 'all') {
      // Broadcast: every roster member still alive (excluding the sender). Stale
      // members are skipped so we don't stuff a dead session's queue.
      const targets = [...roster.keys()].filter((n) => alive(n) && n !== req.from);
      const msg = { from: req.from || '?', to: 'all', text: req.text ?? '', ts: Date.now() };
      for (const n of targets) deliverOrQueue(n, msg);
      logMsg(msg, ` (${targets.length} recipients)`);
      return respond(socket, { ok: true, delivered: targets.length });
    }
    const msg = { from: req.from || '?', to: req.to, text: req.text ?? '', ts: Date.now() };
    deliverOrQueue(req.to, msg);
    logMsg(msg, alive(req.to) ? '' : ' (offline, queued)');
    // Warn when the recipient is offline (likely a typo) — the message is queued anyway
    if (!alive(req.to)) return respond(socket, { ok: true, hint: `"${req.to}" is offline, message queued` });
    return respond(socket, { ok: true });
  }

  if (cmd === 'join') {
    const name = req.name;
    if (!name || name === 'all' || name.startsWith('@'))
      return respond(socket, { ok: false, error: 'name must not be empty, "all", or start with @' });
    if (alive(name)) return respond(socket, { ok: false, error: `"${name}" is already taken` });
    touch(name);
    log(`${cname(name)} joined`);
    return respond(socket, { ok: true, name });
  }

  if (cmd === 'who') {
    const peers = [...roster.entries()].filter(([n]) => alive(n))
      .map(([name, ts]) => ({
        name, lastSeen: ts,
        waiting: !!(waiters.get(name) || []).length, // blocked in recv = online right now
        queued: getQueue(name).length,
      }));
    return respond(socket, { ok: true, peers });
  }

  if (cmd === 'recv') {
    const name = req.name;
    if (!name) return respond(socket, { ok: false, error: 'missing "name"' });
    touch(name);
    const q = getQueue(name);
    if (q.length) {
      const messages = q.splice(0, q.length);
      return respond(socket, { ok: true, messages });
    }
    const wait = Number(req.wait || 0);
    if (wait > 0) {
      // Blocking: hold the connection until a send arrives or the wait expires
      const timer = setTimeout(() => {
        const list = waiters.get(name) || [];
        const i = list.findIndex((w) => w.socket === socket);
        if (i >= 0) list.splice(i, 1);
        respond(socket, { ok: true, messages: [] });
      }, wait * 1000);
      if (!waiters.has(name)) waiters.set(name, []);
      waiters.get(name).push({ socket, timer });
      socket.on('close', () => {
        const list = waiters.get(name) || [];
        const i = list.findIndex((w) => w.socket === socket);
        if (i >= 0) { clearTimeout(list[i].timer); list.splice(i, 1); }
      });
      return; // no response yet, wait for an event
    }
    return respond(socket, { ok: true, messages: [] });
  }

  if (cmd === 'ping') return respond(socket, { ok: true, pong: true });

  return respond(socket, { ok: false, error: 'unknown cmd: ' + cmd });
}

const server = net.createServer((socket) => {
  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let req;
      try { req = JSON.parse(line); }
      catch (_) { return respond(socket, { ok: false, error: 'bad json' }); }
      handle(req, socket);
    }
  });
  socket.on('error', () => { /* ignore disconnect errors */ });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`port ${PORT} is already in use — the broker may already be running.`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  if (!chatMode) {
    log(`claude-msg broker started, listening on ${HOST}:${PORT}, press Ctrl+C to stop`);
    return;
  }
  banner([
    `\x1b[1m✻ claude-msg broker\x1b[0m`,
    ``,
    `\x1b[90mlistening on\x1b[0m ${HOST}:${PORT}`,
    `\x1b[90m<member> <msg>\x1b[0m send  \x1b[90m·\x1b[0m  \x1b[90mall <msg>\x1b[0m broadcast  \x1b[90m·\x1b[0m  \x1b[90m/who\x1b[0m list online`,
    `\x1b[90mCtrl+C to quit\x1b[0m`,
  ]);

  // --- chat mode: this window is the human's chat window ---
  process.stdout.write('\x1b]0;claude-msg chat\x07'); // window title
  // Tab completion: first field only (the recipient); candidates = online members + all + /who
  const completer = (line) => {
    if (line.includes(' ')) return [[], line]; // already typing the body, don't complete
    const cands = [...roster.keys()].filter((n) => alive(n) && n !== HUMAN).concat('all', '/who');
    const hits = cands.filter((c) => c.startsWith(line));
    return [hits.length ? hits : cands, line];
  };
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, completer });
  // readline swallows Ctrl+C (SIGINT goes to rl, not process); without taking it over node never dies
  rl.on('SIGINT', () => process.exit(0));
  rl.on('close', () => process.exit(0)); // Ctrl+D quits the same way
  rl.setPrompt('\x1b[1;97myou\x1b[0m \x1b[38;5;208m›\x1b[0m ');
  touch(HUMAN);
  setInterval(() => touch(HUMAN), 60 * 1000).unref(); // window open = user is online

  rl.on('line', (raw) => {
    const line = raw.trim();
    if (!line) return rl.prompt();
    if (line === '/who') {
      const names = [...roster.keys()].filter((n) => alive(n) && n !== HUMAN);
      log(names.length ? names.map((n) => `${cname(n)}(queue:${getQueue(n).length})`).join('  ') : '(nobody online)');
      return rl.prompt();
    }
    const sp = line.indexOf(' ');
    const to = (sp > 0 ? line.slice(0, sp) : '').replace(/^@/, '');
    const text = sp > 0 ? line.slice(sp + 1).trim() : '';
    if (!to || !text) { log('usage: <member|all> <message>; /who lists who is online'); return rl.prompt(); }
    touch(HUMAN);
    if (to === 'all') {
      const targets = [...roster.keys()].filter((n) => alive(n) && n !== HUMAN);
      const msg = { from: HUMAN, to: 'all', text, ts: Date.now() };
      for (const n of targets) deliverOrQueue(n, msg);
      logMsg(msg, ` (${targets.length} recipients)`);
    } else {
      const msg = { from: HUMAN, to, text, ts: Date.now() };
      deliverOrQueue(to, msg);
      logMsg(msg, alive(to) ? '' : ' (offline, queued)');
    }
    rl.prompt();
  });

  rl.prompt();
});
