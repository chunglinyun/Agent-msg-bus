#!/usr/bin/env node
// claude-msg CLI helper: lets the human and any agent send/receive messages from a shell.
//
// Identity precedence: --as <name> > env CLAUDE_MSG_NAME > default "user" (the human).
// Usage:
//   msg send <@peer|@all> <message...>  send a message (@ optional; @all broadcasts to everyone online)
//   msg send <@peer|@all> --file <path>  send a file's contents as the message body (avoids shell quoting)
//   msg <peer> <message...>             shorthand for send (peer must be online; @peer works too, but PowerShell treats @ as splatting)
//   msg recv [--wait N]                 receive messages; --wait N blocks up to N seconds for new ones
//   msg join <name>                     come online under this name (the broker rejects clashes)
//   msg who                             list who is online
//   msg up                              start the broker in the background if it isn't running
//   msg ping                            check whether the broker is alive
//   msg whoami                          print your own identity
// Common flag: --as <name> sets the identity for this call (an agent's shell keeps no
// env vars, so pass it every time)

const net = require('net');

const HOST = '127.0.0.1';
const PORT = process.env.CLAUDE_MSG_PORT ? Number(process.env.CLAUDE_MSG_PORT) : 8787;

// Pull out --as first; whatever is left is the subcommand and its arguments
const argv = process.argv.slice(2);
const asIdx = argv.indexOf('--as');
const NAME = (asIdx >= 0 && argv[asIdx + 1]) || process.env.CLAUDE_MSG_NAME || 'user';
if (asIdx >= 0) argv.splice(asIdx, 2);

function request(obj) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(PORT, HOST);
    let buf = '';
    let done = false;
    socket.on('connect', () => socket.write(JSON.stringify(obj) + '\n'));
    socket.on('data', (c) => {
      buf += c.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx >= 0 && !done) {
        done = true;
        try { resolve(JSON.parse(buf.slice(0, idx))); }
        catch (e) { reject(e); }
        socket.end();
      }
    });
    socket.on('error', (e) => { if (!done) { done = true; reject(e); } });
    socket.on('close', () => { if (!done) { done = true; reject(new Error('no response (broker not running? try msg up)')); } });
  });
}

// The window to send keys into, for `register`. GetForegroundWindow() is the only
// call that returns it: a console program's MainWindowHandle is 0, and under ConPTY
// GetConsoleWindow() returns a pseudo-console window that exists but cannot be
// focused. Which is why register is something a human runs, in that window, at a
// shell prompt — pressing Enter is what makes the right window the foreground one.
// Anything automatic would silently record whatever the user happened to be looking
// at, and later fire Esc into it.
function foregroundWindow() {
  if (process.platform !== 'win32') return null;
  const ps = `Add-Type -Namespace P -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);'; $h = [P.W]::GetForegroundWindow(); if ($h -eq [IntPtr]::Zero) { exit }; $owner = 0; [void][P.W]::GetWindowThreadProcessId($h, [ref]$owner); "$h $owner"`;
  try {
    // windowsHide: no console flash, and no chance of that console being the window
    // GetForegroundWindow() reports back to us.
    const out = require('child_process').execFileSync('powershell', ['-NoProfile', '-Command', ps],
      { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const [hwnd, pid] = out.trim().split(/\s+/).map(Number);
    return hwnd && pid ? { hwnd, pid } : null;
  } catch (_) { return null; } // no PowerShell, or no window: the caller says so out loud
}

const KNOWN = new Set(['send', 'recv', 'join', 'register', 'who', 'up', 'ping', 'whoami']);

async function main() {
  let [cmd, ...rest] = argv;
  // A leading @xxx means send: msg @foo "hi" === msg send foo "hi"
  if (cmd && cmd.startsWith('@')) { rest.unshift(cmd); cmd = 'send'; }
  // msg <member> <message>: not a subcommand but an online member (or all) means send
  // (PowerShell eats @ as splatting, and only a bare name can be tab-completed)
  else if (cmd && !KNOWN.has(cmd) && rest.length) {
    try {
      const w = await request({ cmd: 'who' });
      if (cmd === 'all' || (w.ok && w.peers.some((p) => p.name === cmd))) { rest.unshift(cmd); cmd = 'send'; }
    } catch (_) { /* broker down → falls through to usage */ }
  }

  try {
    if (cmd === 'send') {
      // --file reads the body from a file instead of the command line. PowerShell
      // wraps a native argument in double quotes without escaping the ones inside
      // it, so pasting code with " through the shell silently loses them.
      // Only in flag position (before or right after the recipient): an unquoted
      // message body may legitimately contain the word --file.
      const fi = rest.indexOf('--file') <= 1 ? rest.indexOf('--file') : -1;
      let fileText = null;
      if (fi >= 0) {
        if (!rest[fi + 1]) { console.error('usage: msg send <@peer|@all> --file <path>'); process.exit(2); }
        fileText = require('fs').readFileSync(rest[fi + 1], 'utf8');
        rest.splice(fi, 2);
      }
      const to = (rest[0] || '').replace(/^@/, '');
      const text = fileText !== null ? fileText : rest.slice(1).join(' ');
      if (!to || !text) { console.error('usage: msg send <@peer|@all> <message> | msg send <@peer|@all> --file <path>'); process.exit(2); }
      const r = await request({ cmd: 'send', from: NAME, to, text });
      if (!r.ok) { console.error('error:', r.error); process.exit(1); }
      if (to === 'all') console.log(`broadcast to ${r.delivered} member(s)`);
      else console.log(`sent -> ${to}` + (r.hint ? ` (${r.hint})` : ''));

    } else if (cmd === 'recv') {
      let wait = 0;
      const wi = rest.indexOf('--wait');
      if (wi >= 0) wait = Number(rest[wi + 1] || 0);
      const r = await request({ cmd: 'recv', name: NAME, wait });
      if (!r.ok) { console.error('error:', r.error); process.exit(1); }
      if (!r.messages.length) { console.log('(no new messages)'); return; }
      for (const m of r.messages) {
        const t = new Date(m.ts).toLocaleTimeString('en-GB');
        console.log(`[${t}] ${m.to === 'all' ? '@all ' : ''}${m.from}: ${m.text}`);
      }

    } else if (cmd === 'join') {
      const name = (rest[0] || '').replace(/^@/, '');
      if (!name) { console.error('usage: msg join <name>'); process.exit(2); }
      // The broker owns the registry (see registerSession there); all we add is the
      // one thing it cannot see from its own process — the launcher's entry, when a
      // split launcher started us — so it can rename that entry to the bus name.
      // Joining never registers a window: see foregroundWindow() above.
      const r = await request({ cmd: 'join', name, sessionPid: process.env.CLAUDE_SPLIT_SESSION_PID });
      if (!r.ok) { console.error('error:', r.error); process.exit(1); }
      console.log(`joined as: ${r.name}`);

    } else if (cmd === 'register') {
      // Run by hand, in the terminal window that should become targetable by /stop
      // and friends, before starting claude in it. Pure registry bookkeeping: it
      // claims no name on the bus, the agent still joins as <name> afterwards.
      const name = (rest[0] || '').replace(/^@/, '');
      if (!name) { console.error('usage: msg register <name>   (run it in the terminal window you want to target)'); process.exit(2); }
      const win = foregroundWindow();
      if (!win) {
        console.error(process.platform !== 'win32'
          ? 'cannot register: key injection is Windows-only'
          : 'cannot register: no foreground window (needs powershell, and a real terminal window — the Claude desktop app has none of its own)');
        process.exit(1);
      }
      const r = await request({ cmd: 'register', name, hwnd: win.hwnd, pid: win.pid });
      if (!r.ok) { console.error('error:', r.error); process.exit(1); }
      console.log(`registered "${name}" -> window ${win.hwnd} (start claude here, then have it join as ${name})`);

    } else if (cmd === 'who') {
      const r = await request({ cmd: 'who' });
      if (!r.ok) { console.error('error:', r.error); process.exit(1); }
      if (!r.peers.length) { console.log('(nobody online)'); return; }
      for (const p of r.peers) {
        const idle = Math.round((Date.now() - p.lastSeen) / 1000);
        console.log(`${p.name}  (${p.waiting ? 'waiting' : `idle ${idle}s`})  queue:${p.queued}`);
      }

    } else if (cmd === 'up') {
      try { await request({ cmd: 'ping' }); console.log('broker already running'); return; } catch (_) {}
      const { spawn } = require('child_process');
      // ponytail: stdio ignore, so broker logs are lost; run node broker.js in the foreground to see them
      spawn(process.execPath, [require('path').join(__dirname, 'broker.js')],
        { detached: true, stdio: 'ignore' }).unref();
      console.log(`broker started in the background (port ${PORT})`);

    } else if (cmd === 'ping') {
      const r = await request({ cmd: 'ping' });
      console.log(r.pong ? 'broker OK' : 'no pong');

    } else if (cmd === 'whoami') {
      console.log(NAME);

    } else {
      console.log('usage: msg send <@peer|@all> <message|--file path> | msg <online member> <message> | msg recv [--wait N] | msg join <name> | msg register <name> | msg who | msg up | msg ping | msg whoami (common: --as <name>)');
    }
  } catch (e) {
    console.error('failed:', e.message);
    process.exit(1);
  }
}

main();
