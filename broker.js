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
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

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

// Chat-mode "thinking" indicator: a member is thinking from the moment it picks up
// a message until it sends something or goes back to waiting in recv. No ack
// protocol needed — pickup and re-wait are visible to the broker anyway.
const thinking = new Map(); // name -> since (ms)
let syncSpinner = () => {}; // bound in chat mode; stays a no-op in background mode
function setThinking(name, on) {
  if (!chatMode || !name || name === HUMAN) return;
  if (on) thinking.set(name, Date.now()); else thinking.delete(name);
  syncSpinner();
}

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
    setThinking(name, true); // it just picked up work
    return true;
  }
  return false;
}

function log(s) {
  // Multi-line messages: CR+LF each line (a bare LF stair-steps inside the scroll
  // region) and indent continuation lines to line up after the timestamp column.
  const body = String(s).replace(/\r\n?/g, '\n').split('\n').join('\r\n' + ' '.repeat(10));
  const line = `\x1b[90m${new Date().toLocaleTimeString('en-GB')}\x1b[0m  ${body}`;
  if (rl) {
    // The scroll region pins the separator + input line to the two bottom rows:
    // save the cursor, write at the region's bottom margin (LF scrolls the
    // region), restore. The bottom rows are never touched, no prompt redraw needed.
    const rows = process.stdout.rows || 24;
    process.stdout.write(`\x1b7\x1b[${rows - 2};1H\n${line}\x1b8`);
  } else console.log(line);
}

// Delivery order: hand to a waiter → in chat mode show messages for the human via
// log (never queued) → otherwise queue.
function deliverOrQueue(name, msg) {
  if (deliverToWaiter(name, msg)) return;
  if (name === HUMAN && chatMode) return;
  getQueue(name).push(msg);
}

// Ambiguous-width glyphs (②③, ▲, ☆…) render wide but the terminal advances only
// one cell, so neighbours collide; a trailing space gives them room to breathe.
// ponytail: enclosed alphanumerics / geometric shapes / misc symbols only
const CRAMPED = /([①-⓿■-◿☀-➿])/g;
function airy(s) { return String(s).replace(CRAMPED, '$1 '); }

function logMsg(msg, extra = '') {
  const arrow = msg.to === 'all' ? `${cname(msg.from)} ⇒ @all` : `${cname(msg.from)} → ${cname(msg.to)}`;
  // Mark messages meant for the human with ★ and brighten the body so they stand out
  const body = airy(msg.text);
  const text = msg.to === HUMAN || msg.to === 'all' ? `\x1b[97m${body}\x1b[0m` : body;
  log(`${msg.to === HUMAN ? '\x1b[1;93m★\x1b[0m ' : ''}${arrow}: ${text}${extra}`);
}

// --- Chat-mode native commands for split sessions (zero token, Windows only) ---
// /stop injects Esc into the target session's terminal window (the only external
// interrupt Claude Code has); /usage aggregates token counts straight from the
// target's local transcripts. Neither goes through the bus or the agent's model.
// USERPROFILE may be a fake home when the broker is launched from inside a split
// session — strip the fake-home suffix to get the real home (same trick as the
// PS profile), then honor the config file's base when present.
const REAL_HOME = (process.env.USERPROFILE || process.env.HOME || '').replace(/[\\/]\.claude-split[\\/].*$/, '');
let SPLIT_BASE = path.join(REAL_HOME, '.claude-split');
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(REAL_HOME, '.claude-msgbus.json'), 'utf8').replace(/^﻿/, ''));
  if (cfg.base) SPLIT_BASE = cfg.base;
} catch (_) { /* no config yet — the derived default stands */ }

function readSessions() {
  try {
    // strip the BOM Set-Content -Encoding UTF8 writes on PS 5.1
    const parsed = JSON.parse(fs.readFileSync(path.join(SPLIT_BASE, 'sessions.json'), 'utf8').replace(/^﻿/, ''));
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean);
  } catch (_) { return []; /* missing/corrupt file = nobody registered */ }
}

// Resolve a /stop//usage target: bus name first, launcher profile (work/personal)
// as fallback. Names can collide too — un-joined sessions carry the profile as a
// placeholder name, and roster uniqueness (memory, TTL) doesn't outlive broker
// restarts the way sessions.json does — so both lookups treat >1 hit as ambiguous.
function findSession(target) {
  const sessions = readSessions();
  for (const field of ['name', 'profile']) {
    const hits = sessions.filter((x) => x[field] === target);
    if (hits.length === 1) return { s: hits[0] };
    if (hits.length > 1) return { ambiguous: hits };
  }
  return {};
}

// Shared plumbing for the key-injection commands: look up the window in
// sessions.json (written by the split launcher; msg.js rewrites the entry's name
// to the bus name on join), spawn sendkeys.ps1 to press keys in it, then call
// onOk(session) so each command can do its own logging/cleanup.
function injectKeys(cmd, target, keys, enter, onOk) {
  const { s, ambiguous } = findSession(target);
  if (ambiguous) return log(`/${cmd}: ${ambiguous.length} "${target}" sessions (${ambiguous.map((x) => `${x.name} pid:${x.pid}`).join(', ')}) — have each agent join the bus, then target its bus name`);
  if (!s) return log(`/${cmd}: no registered session "${target}" — launch it via its split launcher (e.g. claude-work) first`);
  const helper = path.join(__dirname, 'sendkeys.ps1');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Hwnd', String(s.hwnd), '-Keys', keys];
  if (enter) args.push('-Enter');
  execFile('powershell', args, (err, _out, serr) => {
    if (err) return log(`/${cmd} ${target} failed: ${String(serr || err.message).trim()}`);
    onOk(s);
  });
}

// /stop <session>: press Esc — the only external interrupt Claude Code offers.
function stopSession(target) {
  injectKeys('stop', target, '{ESC}', false, (s) => {
    // Esc aborts the agent's turn: it will neither reply nor re-enter recv (the
    // two events that clear the indicator), so clear it here.
    setThinking(s.name, false);
    log(`⏹ Esc sent to ${target}`);
  });
}

// /compact <session>: type "/compact" + Enter in the target's input box. Lands in
// whatever the box holds — if someone is mid-typing there, the text mixes.
function compactSession(target) {
  injectKeys('compact', target, '/compact', true, () => log(`✂ /compact sent to ${target}`));
}

// /usage <session>: sum token usage from the fake home's transcripts
// (~\.claude-split\.claude-<profile>\.claude\projects\**\*.jsonl), ccusage-style.
// Accepts a bus name or a profile; sessions of one profile share a fake home, so
// profile ambiguity doesn't matter here.
// ponytail: re-reads every transcript per call; cache mtimes if it ever feels slow
function* jsonlFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* jsonlFiles(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

function usageReport(target) {
  const { s } = findSession(target);
  // no registry hit = treat the target as a profile directly (pre-registry habit)
  const profile = (s && (s.profile || s.name)) || target;
  const root = path.join(SPLIT_BASE, `.claude-${profile}`, '.claude', 'projects');
  if (!fs.existsSync(root)) return `/usage: no transcripts for "${target}" (${root})`;
  const seen = new Map(); // message.id -> latest {usage, ts}; dedupes streamed rewrites
  for (const f of jsonlFiles(root)) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.includes('"usage"')) continue;
      let o; try { o = JSON.parse(line); } catch (_) { continue; }
      const u = o.message && o.message.usage;
      if (!u || !o.message.id) continue;
      seen.set(o.message.id, { u, ts: Date.parse(o.timestamp) || 0 });
    }
  }
  const midnight = new Date().setHours(0, 0, 0, 0);
  const all = { in: 0, out: 0, cr: 0, cw: 0 }, today = { in: 0, out: 0, cr: 0, cw: 0 };
  for (const { u, ts } of seen.values()) {
    for (const t of ts >= midnight ? [all, today] : [all]) {
      t.in += u.input_tokens || 0; t.out += u.output_tokens || 0;
      t.cr += u.cache_read_input_tokens || 0; t.cw += u.cache_creation_input_tokens || 0;
    }
  }
  const k = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
  const fmt = (t) => `in ${k(t.in)} · out ${k(t.out)} · cache r/w ${k(t.cr)}/${k(t.cw)}`;
  return `${cname(target)} usage — today: ${fmt(today)}\n${' '.repeat(dispWidth(target) + 8)}all time: ${fmt(all)} (${seen.size} turns)`;
}

function handle(req, socket) {
  const cmd = req.cmd;

  if (cmd === 'send') {
    if (!req.to) return respond(socket, { ok: false, error: 'missing "to"' });
    touch(req.from);
    setThinking(req.from, false); // replying = done thinking
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
      setThinking(name, true); // it just picked up work
      return respond(socket, { ok: true, messages });
    }
    setThinking(name, false); // nothing to do = back to standby
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
        if (i >= 0) {
          clearTimeout(list[i].timer); list.splice(i, 1);
          // Socket dropped while the waiter was still registered = the client was
          // killed mid-wait (normal timeout/delivery responds first, removing the
          // waiter before close fires). Mark the member offline right away instead
          // of letting it linger in the roster for the whole TTL; any later command
          // from a live session re-touches it back online.
          roster.delete(name);
          setThinking(name, false);
          log(`${cname(name)} disconnected, marked offline`);
        }
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
    `\x1b[90m<member> <msg>\x1b[0m send  \x1b[90m·\x1b[0m  \x1b[90mall <msg>\x1b[0m broadcast  \x1b[90m·\x1b[0m  \x1b[90m/who /stop /compact /usage\x1b[0m`,
    `\x1b[90mCtrl+C to quit\x1b[0m`,
  ]);

  // --- chat mode: this window is the human's chat window ---
  // DECSTBM scroll region: rows 1..N-1 scroll with messages, the last row is the
  // pinned input line (DECSTBM homes the cursor, so re-place it explicitly).
  // The separator row doubles as the status line: while members are thinking it
  // shows an animated "✻ name thinking…", otherwise a plain rule.
  const SPIN = ['·', '✢', '✳', '✶', '✻', '✽'];
  let spinT = 0, spinTimer = null;
  const drawStatus = () => {
    const rows = process.stdout.rows || 24;
    const cols = process.stdout.columns || 80;
    let line;
    if (!thinking.size) {
      line = `\x1b[38;5;208m${'─'.repeat(cols)}\x1b[0m`;
    } else {
      const g = SPIN[spinT++ % SPIN.length];
      const label = ` \x1b[38;5;208m${g}\x1b[0m ${[...thinking.keys()].map(cname).join(', ')} \x1b[38;5;208mthinking…\x1b[0m `;
      const fill = Math.max(0, cols - 2 - dispWidth(label));
      line = `\x1b[38;5;208m──\x1b[0m${label}\x1b[38;5;208m${'─'.repeat(fill)}\x1b[0m`;
    }
    process.stdout.write(`\x1b7\x1b[${rows - 1};1H\x1b[2K${line}\x1b8`);
  };
  syncSpinner = () => {
    // ponytail: STALE_MS cap so a member that dies mid-work can't spin forever
    for (const [n, ts] of thinking) if (Date.now() - ts > STALE_MS) thinking.delete(n);
    if (thinking.size && !spinTimer) spinTimer = setInterval(syncSpinner, 120);
    if (!thinking.size && spinTimer) { clearInterval(spinTimer); spinTimer = null; }
    drawStatus();
  };
  const anchorInput = () => {
    const rows = process.stdout.rows || 24;
    process.stdout.write(`\x1b[1;${rows - 2}r`); // messages scroll above the separator
    drawStatus();
    process.stdout.write(`\x1b[${rows};1H`);
  };
  anchorInput();
  process.stdout.on('resize', () => { anchorInput(); rl.prompt(true); });
  process.on('exit', () => process.stdout.write('\x1b[r')); // release the region or the shell stays confined
  process.stdout.write('\x1b]0;claude-msg chat\x07'); // window title
  // Tab completion: first field = recipient/command; /stop and /usage also
  // complete their target from the session registry (bus names + profiles).
  const completer = (line) => {
    const tm = line.match(/^\/(stop|usage|compact)\s+(\S*)$/);
    if (tm) {
      const cands = [...new Set(readSessions().flatMap((x) => [x.name, x.profile]))].filter(Boolean);
      const hits = cands.filter((c) => c.startsWith(tm[2]));
      return [hits.length ? hits : cands, tm[2]];
    }
    if (line.includes(' ')) return [[], line]; // already typing the body, don't complete
    const cands = [...roster.keys()].filter((n) => alive(n) && n !== HUMAN).concat('all', '/who', '/stop', '/compact', '/usage');
    const hits = cands.filter((c) => c.startsWith(line));
    return [hits.length ? hits : cands, line];
  };
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, completer });
  // readline swallows Ctrl+C (SIGINT goes to rl, not process); without taking it over node never dies
  rl.on('SIGINT', () => process.exit(0));
  rl.on('close', () => process.exit(0)); // Ctrl+D quits the same way
  rl.setPrompt('    \x1b[1;97myou\x1b[0m \x1b[38;5;208m›\x1b[0m '); // indented so it never lines up under the timestamps
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
    // Native commands for split sessions: /stop = Esc injection, /compact = typed
    // slash-command injection, /usage = transcript stats.
    // Targets are bus names (msg.js rewrites the registry on join); launcher
    // profiles (work/personal) still work as a fallback when unambiguous.
    const cm = line.match(/^\/(stop|usage|compact)\s+(\S+)$/);
    if (cm) {
      if (cm[1] === 'stop') stopSession(cm[2]);
      else if (cm[1] === 'compact') compactSession(cm[2]);
      else log(usageReport(cm[2]));
      return rl.prompt();
    }
    if (line.startsWith('/')) {
      log('commands: /who · /stop <session> · /compact <session> · /usage <session>   (session = bus name, or launcher profile like work when unambiguous)');
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
