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
const { PassThrough } = require('stream');

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
// Rows reserved at the bottom for the input line: fixed head-room so a typed line
// can wrap twice without touching the message area. Nothing may wrap past the last
// reserved row — the terminal clamps the cursor there and readline's row
// bookkeeping falls apart (the line gets redrawn over the separator, duplicated).
// feed() enforces this: wide pastes become a stash token, typed overflow is
// dropped with a bell.
const inputRows = 3;

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
const ANSI = /\x1b\[[0-9;]*m/g; // shared with the tap feed: the web UI renders text, not escapes
function dispWidth(s) {
  const bare = s.replace(ANSI, '');
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

// Event feed for the web frontend (cmd: tap). One socket per browser tab; the
// ring buffer is replayed when a tap connects so a fresh tab is not blank.
const taps = new Set();
const history = [];
const HISTORY_MAX = 200;

// Chat-mode "thinking" indicator: a member is thinking from the moment it picks up
// a message until it sends something or goes back to waiting in recv. No ack
// protocol needed — pickup and re-wait are visible to the broker anyway.
const thinking = new Map(); // name -> since (ms)
let syncSpinner = () => {}; // bound in chat mode; stays a no-op in background mode
function setThinking(name, on) {
  if (!name || name === HUMAN) return;
  if (on === thinking.has(name)) return; // no change: don't re-emit (recv calls this every round)
  if (on) thinking.set(name, Date.now()); else thinking.delete(name);
  emit({ type: 'thinking', name, on });
  syncSpinner(); // no-op outside chat mode
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

// Push one event to every tap. msg/log events are kept for replay; thinking is
// state, not history — buffering it would push real messages out of the ring.
function emit(ev) {
  if (!ev.ts) ev.ts = Date.now();
  if (ev.type !== 'thinking') {
    history.push(ev);
    if (history.length > HISTORY_MAX) history.shift();
  }
  for (const sock of taps) {
    try { sock.write(JSON.stringify(ev) + '\n'); } catch (_) { taps.delete(sock); }
  }
}

// tap = false for lines whose structured form is emitted separately (logMsg).
function log(s, tap = true) {
  // Multi-line messages: CR+LF each line (a bare LF stair-steps inside the scroll
  // region) and indent continuation lines to line up after the timestamp column.
  const body = String(s).replace(/\r\n?/g, '\n').split('\n').join('\r\n' + ' '.repeat(10));
  const line = `\x1b[90m${new Date().toLocaleTimeString('en-GB')}\x1b[0m  ${body}`;
  if (rl) {
    // The scroll region pins the separator + input line to the two bottom rows:
    // save the cursor, write at the region's bottom margin (LF scrolls the
    // region), restore. The bottom rows are never touched, no prompt redraw needed.
    const rows = process.stdout.rows || 24;
    process.stdout.write(`\x1b7\x1b[${rows - inputRows - 1};1H\n${line}\x1b8`);
  } else console.log(line);
  if (tap) emit({ type: 'log', text: String(s).replace(ANSI, '') });
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
  log(`${msg.to === HUMAN ? '\x1b[1;93m★\x1b[0m ' : ''}${arrow}: ${text}${extra}`, false);
  emit({ type: 'msg', ...msg, queued: msg.to !== 'all' && !alive(msg.to) });
}

// --- Chat-mode native commands for split sessions (zero token, Windows only) ---
// All of them are keyboard injection into the target session's terminal window:
// /stop presses Esc (the only external interrupt Claude Code has), the rest type
// the matching slash command + Enter and let that session's own UI answer. Nothing
// goes through the bus or the agent's model.
// This table drives dispatch, Tab completion, the banner and the help line.
const COMMANDS = {
  stop: '{ESC}',
  compact: '/compact',
  usage: '/usage',
  model: '/model',
  plugin: '/plugin',
  skills: '/skills',
};
const CMD_NAMES = Object.keys(COMMANDS).join('|');

// The registry belongs to the install that owns this broker, so derive it from where
// this file sits: the nearest ancestor directory whose name starts with a dot —
// ~\.claude for a skill install, ~\.codex / ~\.gemini for the other agents,
// ~\.claude-split for the split launcher (its broker.js lives in bin\). No config
// lookup, and a skill install stops inventing a .claude-split it never uses.
function registryDir(dir) {
  // Every copy under .claude-split belongs to the split install, fake homes included.
  // An agent inside a split session starts the broker from its own skill dir
  // (~\.claude-split\.claude-work\.claude\skills\claude-msg\), and that broker has to
  // land on the same sessions.json the launcher writes — not on the fake home's own
  // .claude. So cut anything below .claude-split before walking up.
  const from = dir.replace(/([\\/]\.claude-split)[\\/].*$/, '$1');
  for (let d = from; ;) {
    if (path.basename(d).startsWith('.')) return d;
    const up = path.dirname(d);
    if (up === d) return from; // nothing dotted above: keep it next to the broker
    d = up;
  }
}
const SESSIONS_FILE = path.join(registryDir(__dirname), 'sessions.json');

// --- Session registry writing ------------------------------------------------
// The registry's only Node writer is here (claude-split.ps1 writes it too, from
// PowerShell). msg.js used to rewrite its own entry, which meant a second copy of
// the path derivation above that had to stay in step with this one.
function writeSessions(list) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(list, null, 2));
}

// Best-effort: a failure here must never fail the call itself.
function registerSession(name, req) {
  // Started by a split launcher: the entry already exists, it just needs the bus name.
  if (req.sessionPid) {
    const list = readSessions();
    const s = list.find((x) => String(x.pid) === String(req.sessionPid));
    if (s) { s.name = name; writeSessions(list); }
    return;
  }
  // Otherwise this is `msg register`, typed by hand in the window to be targeted.
  // The identity of such an entry is the hwnd, never the pid: the process owning a
  // terminal window is WindowsTerminal.exe, shared by every window it hosts. So
  // registering the same window again is a rename, another window is a new entry.
  // No profile field either — for these it could only ever resolve to ambiguous.
  if (!req.hwnd || !req.pid) return;
  const list = readSessions().filter((x) => Number(x.hwnd) !== Number(req.hwnd));
  list.push({ name, pid: req.pid, hwnd: req.hwnd, startedAt: new Date().toISOString() });
  writeSessions(list);
}

// Drop the entry for a window that is gone. Re-read rather than reusing the list
// the caller held: injection is async, and PowerShell writes this file too.
function forgetSession(hwnd) {
  const list = readSessions();
  const kept = list.filter((x) => Number(x.hwnd) !== Number(hwnd));
  if (kept.length !== list.length) writeSessions(kept);
}

function readSessions() {
  try {
    // strip the BOM Set-Content -Encoding UTF8 writes on PS 5.1
    const parsed = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8').replace(/^﻿/, ''));
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
// sessions.json (written by the split launcher, or by `msg register`; the bus name
// lands on the launcher's entry when the agent joins), spawn sendkeys.ps1 to press
// keys in it, then call onOk(session) so each command can log/clean up its own way.
function injectKeys(cmd, target, keys, enter, onOk) {
  const { s, ambiguous } = findSession(target);
  if (ambiguous) return log(`/${cmd}: ${ambiguous.length} "${target}" sessions (${ambiguous.map((x) => `${x.name} pid:${x.pid}`).join(', ')}) — have each agent join the bus, then target its bus name`);
  if (!s) return log(`/${cmd}: no registered session "${target}" — its window is unknown. In a terminal, run "msg register ${target}" in that window (once, before starting claude); split launchers register themselves; sessions inside the Claude desktop app share one window and cannot be targeted.`);
  const helper = path.join(__dirname, 'sendkeys.ps1');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Hwnd', String(s.hwnd), '-Keys', keys];
  if (enter) args.push('-Enter');
  // windowsHide: without it Node lets powershell.exe create its own console, which
  // flashes on screen for every /stop. The focus flick to the target window stays —
  // that one is the mechanism, not a side effect.
  execFile('powershell', args, { windowsHide: true }, (err, _out, serr) => {
    if (err) {
      // Exit code 2 means sendkeys.ps1's IsWindow check failed: that window is gone.
      // Dropping the entry here is the only cleanup dead entries get, and it matters —
      // Windows recycles HWNDs, and a stale one eventually points at someone else.
      if (err.code === 2) { forgetSession(s.hwnd); return log(`/${cmd}: "${target}" window is gone — registry entry dropped`); }
      return log(`/${cmd} ${target} failed: ${String(serr || err.message).trim()}`);
    }
    onOk(s);
  });
}

// Run one of COMMANDS against a session. Everything but /stop is typed into the
// target's input box, so it lands in whatever that box holds — if someone is
// mid-typing in that window, the text mixes.
function runCommand(cmd, target) {
  const keys = COMMANDS[cmd];
  injectKeys(cmd, target, keys, cmd !== 'stop', (s) => {
    // Esc aborts the agent's turn: it will neither reply nor re-enter recv (the
    // two events that clear the indicator), so clear it here.
    if (cmd === 'stop') setThinking(s.name, false);
    log(cmd === 'stop' ? `⏹ Esc sent to ${target}` : `✂ ${keys} sent to ${target}`);
  });
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
    try { registerSession(name, req); } catch (_) { /* the registry is a nicety, the join is not */ }
    return respond(socket, { ok: true, name });
  }

  // `msg register <name>`, run by hand in the window that should be targetable.
  // Not a join: it records a window, nothing else. The agent still joins the bus
  // under that name afterwards, which is what makes /stop <name> resolve.
  if (cmd === 'register') {
    if (!req.name) return respond(socket, { ok: false, error: 'missing "name"' });
    if (!req.hwnd || !req.pid) return respond(socket, { ok: false, error: 'missing window' });
    try { registerSession(req.name, req); }
    catch (e) { return respond(socket, { ok: false, error: `registry write failed: ${e.message}` }); }
    log(`${cname(req.name)} registered window ${req.hwnd}`);
    return respond(socket, { ok: true });
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

  if (cmd === 'tap') {
    // Event feed for the web frontend: replay the ring buffer, then stream live.
    // Both writes happen in this tick, so no emit can interleave with the replay.
    // ready marks the end of the replay and carries the current thinking state.
    taps.add(socket);
    for (const ev of history) socket.write(JSON.stringify(ev) + '\n');
    socket.write(JSON.stringify({ type: 'ready', thinking: [...thinking.keys()], ts: Date.now() }) + '\n');
    socket.on('close', () => taps.delete(socket));
    return; // long-lived: never respond, that would end the socket
  }

  if (cmd === 'command') {
    // Chat mode's /<cmd> <target> key injection, reachable from the web UI.
    // Whitelist lookup: req.name is untrusted, never index COMMANDS with it directly.
    if (!Object.prototype.hasOwnProperty.call(COMMANDS, req.name))
      return respond(socket, { ok: false, error: `unknown command: ${req.name}` });
    if (!req.target) return respond(socket, { ok: false, error: 'missing "target"' });
    runCommand(req.name, req.target); // reports its own outcome through log() -> tap
    return respond(socket, { ok: true });
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
    `\x1b[90m<member> <msg>\x1b[0m send  \x1b[90m·\x1b[0m  \x1b[90mall <msg>\x1b[0m broadcast  \x1b[90m·\x1b[0m  \x1b[90m/who ${Object.keys(COMMANDS).map((c) => `/${c}`).join(' ')}\x1b[0m`,
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
    process.stdout.write(`\x1b7\x1b[${rows - inputRows};1H\x1b[2K${line}\x1b8`);
  };
  syncSpinner = () => {
    // ponytail: STALE_MS cap so a member that dies mid-work can't spin forever.
    // Emit on the way out: setThinking's no-change guard would otherwise swallow
    // the member's own later "done", leaving the web indicator lit forever.
    for (const [n, ts] of thinking) {
      if (Date.now() - ts > STALE_MS) { thinking.delete(n); emit({ type: 'thinking', name: n, on: false }); }
    }
    if (thinking.size && !spinTimer) spinTimer = setInterval(syncSpinner, 120);
    if (!thinking.size && spinTimer) { clearInterval(spinTimer); spinTimer = null; }
    drawStatus();
  };
  // The bottom inputRows rows hold the (possibly wrapped) input line; the row
  // above them is the separator.
  const anchorInput = () => {
    const rows = process.stdout.rows || 24;
    process.stdout.write(`\x1b[1;${rows - inputRows - 1}r`); // messages scroll above the separator
    drawStatus();
    process.stdout.write(`\x1b[${rows - inputRows + 1};1H`);
  };
  // Re-anchor + clear the input strip, then redraw the prompt. After a submitted
  // line the cursor has drifted below the anchor (readline echoed a newline), and
  // readline's own refresh walks up from where it *thinks* the line started —
  // resetting prevRows tells it the cursor is back on the line's first row.
  // ponytail: rl.prevRows is a readline private; worst case a node bump degrades
  // this to a cosmetic misdraw, not a crash
  const promptAnchored = (preserve) => {
    anchorInput();
    process.stdout.write('\x1b[0J'); // wipe stale input rows below the anchor
    rl.prevRows = 0;
    rl.prompt(preserve);
  };
  anchorInput();
  process.stdout.on('resize', () => promptAnchored(true));
  process.on('exit', () => { // release the region or the shell stays confined
    process.stdout.write('\x1b[r\x1b[?2004l');
    try { process.stdin.setRawMode(false); } catch (_) {}
  });
  process.stdout.write('\x1b]0;claude-msg chat\x07'); // window title
  // Tab completion: first field = recipient/command; the session commands also
  // complete their target from the session registry (bus names + profiles).
  const completer = (line) => {
    const tm = line.match(new RegExp(`^/(${CMD_NAMES})\\s+(\\S*)$`));
    if (tm) {
      const cands = [...new Set(readSessions().flatMap((x) => [x.name, x.profile]))].filter(Boolean);
      const hits = cands.filter((c) => c.startsWith(tm[2]));
      return [hits.length ? hits : cands, tm[2]];
    }
    if (line.includes(' ')) return [[], line]; // already typing the body, don't complete
    const cands = [...roster.keys()].filter((n) => alive(n) && n !== HUMAN)
      .concat('all', '/who', ...Object.keys(COMMANDS).map((c) => `/${c}`));
    const hits = cands.filter((c) => c.startsWith(line));
    return [hits.length ? hits : cands, line];
  };
  // Bracketed paste: the terminal wraps pasted text in \x1b[200~ … \x1b[201~. A
  // PassThrough between stdin and readline intercepts the paste: small single-line
  // pastes flow through (tabs to spaces, so they can't trigger completion), but a
  // multi-line or large paste never enters the input line — readline would fire
  // 'line' per newline and send only the first, and a huge line wraps off the
  // reserved rows. Instead the content is stashed and the line gets a compact
  // ⟦pasteN:…⟧ token, expanded back to the original text on send. Terminals
  // without bracketed paste just fall back to the old line-per-line behaviour.
  const rlInput = new PassThrough({ encoding: 'utf8' });
  const pasteBufs = []; // stashed pastes, index = token number; cleared on send
  let pasting = false, pasteAcc = '', pendingIn = '';
  const PROMPT = '    \x1b[1;97myou\x1b[0m \x1b[38;5;208m›\x1b[0m '; // indented so it never lines up under the timestamps
  // Columns still free in the input strip: strip capacity minus prompt, minus the
  // current line, minus one spare cell so the cursor itself never wraps off the
  // last reserved row. Everything entering the line is gated on this — the strip
  // is fixed at inputRows and overflow breaks readline's cursor math (see above).
  // Display width, not length: CJK chars take two columns.
  const inputRoom = () =>
    (process.stdout.columns || 80) * inputRows - dispWidth(PROMPT) - 1 - dispWidth(rl ? rl.line : '');
  const feed = (chunk) => {
    let s = pendingIn + chunk; pendingIn = '';
    // hold back a chunk-final partial paste marker for the next chunk
    const cut = s.match(/(?:\x1b|\x1b\[|\x1b\[2|\x1b\[20|\x1b\[20[01])$/);
    if (cut) { pendingIn = cut[0]; s = s.slice(0, s.length - cut[0].length); }
    let out = '';
    for (let i = 0; i < s.length; ) {
      if (s.startsWith('\x1b[200~', i)) { pasting = true; pasteAcc = ''; i += 6; continue; }
      if (s.startsWith('\x1b[201~', i)) {
        pasting = false; i += 6;
        const multi = /[\r\n]/.test(pasteAcc);
        if (!multi && dispWidth(pasteAcc) <= inputRoom() - dispWidth(out)) { out += pasteAcc.replace(/\t/g, '  '); continue; }
        const norm = pasteAcc.replace(/\r\n?/g, '\n');
        out += `⟦paste${pasteBufs.length}:${norm.split('\n').length}行⟧`; // ⟦pasteN:N行⟧
        pasteBufs.push(norm);
        continue;
      }
      if (pasting) pasteAcc += s[i++]; else out += s[i++];
    }
    // Typed text past the strip's remaining room is dropped with a bell instead of
    // letting readline wrap off-screen. Chunks holding control bytes (escape
    // sequences, backspace, enter) pass untouched — they edit, not extend.
    // ponytail: a paste token that lands on a nearly-full line can be truncated
    // mid-token (sent as literal text); rare enough to accept
    if (out && !/[\x00-\x1f\x7f]/.test(out)) {
      let room = inputRoom(), kept = '';
      for (const ch of out) { room -= FULLWIDTH.test(ch) ? 2 : 1; if (room < 0) break; kept += ch; }
      if (kept.length < out.length) { process.stdout.write('\x07'); out = kept; }
    }
    if (out) rlInput.write(out);
  };
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', feed);
  process.stdout.write('\x1b[?2004h'); // ask the terminal for bracketed paste

  rl = readline.createInterface({ input: rlInput, output: process.stdout, completer, terminal: true });
  // readline swallows Ctrl+C (SIGINT goes to rl, not process); without taking it over node never dies
  rl.on('SIGINT', () => process.exit(0));
  rl.on('close', () => process.exit(0)); // Ctrl+D quits the same way
  rl.setPrompt(PROMPT);
  touch(HUMAN);
  setInterval(() => touch(HUMAN), 60 * 1000).unref(); // window open = user is online

  rl.on('line', (raw) => {
    const line = raw.trim();
    if (!line) return promptAnchored();
    if (line === '/who') {
      const names = [...roster.keys()].filter((n) => alive(n) && n !== HUMAN);
      log(names.length ? names.map((n) => `${cname(n)}(queue:${getQueue(n).length})`).join('  ') : '(nobody online)');
      return promptAnchored();
    }
    // Native commands for split sessions (COMMANDS): /stop = Esc injection, the
    // rest type their slash command into the target's input box.
    // Targets are bus names (msg.js rewrites the registry on join); launcher
    // profiles (work/personal) still work as a fallback when unambiguous.
    const cm = line.match(new RegExp(`^/(${CMD_NAMES})\\s+(\\S+)$`));
    if (cm) {
      runCommand(cm[1], cm[2]);
      return promptAnchored();
    }
    if (line.startsWith('/')) {
      const list = Object.keys(COMMANDS).map((c) => `/${c} <session>`).join(' · ');
      log(`commands: /who · ${list}   (session = bus name, or launcher profile like work when unambiguous)`);
      return promptAnchored();
    }
    const sp = line.indexOf(' ');
    const to = (sp > 0 ? line.slice(0, sp) : '').replace(/^@/, '');
    // expand stashed-paste tokens back into the original (possibly multi-line) text
    const text = sp > 0
      ? line.slice(sp + 1).replace(/⟦paste(\d+):[^⟧]*⟧/g, (m, i) => pasteBufs[i] ?? m).trim()
      : '';
    pasteBufs.length = 0; // consumed (or abandoned) with this line
    if (!to || !text) { log('usage: <member|all> <message>; /who lists who is online'); return promptAnchored(); }
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
    promptAnchored();
  });

  rl.prompt();
});
