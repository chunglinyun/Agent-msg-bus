#!/usr/bin/env node
// askpeer.js — synchronously delegate one simple, self-contained (stateless) task
// to another instance. Opens a one-shot headless claude under that peer's fake home,
// prints the result, and returns synchronously.
//
// Usage: node askpeer.js <peer> "<task>"
//   peer = work | personal
//
// Good for: a single question, looking something up, running a one-off pass —
// anything that needs no memory across calls.
// Not for: multi-turn work that needs continuous context — use the message
// channel (msg send/recv) for that.

const { spawnSync } = require('child_process');
const path = require('path');

const peer = process.argv[2];
const prompt = process.argv.slice(3).join(' ');

if (!peer || !prompt) {
  console.error('usage: node askpeer.js <work|personal> "<task>"');
  process.exit(2);
}
if (peer !== 'work' && peer !== 'personal') {
  console.error('peer must be either work or personal');
  process.exit(2);
}

// bin lives at ...\.claude-split\bin; go up one level for .claude-split, then build the peer's fake home
const splitBase = path.dirname(__dirname);
const peerHome = path.join(splitBase, '.claude-' + peer);

// Run a one-shot claude under the peer's home; drop our own channel identity (this is a stateless subtask)
const env = { ...process.env, USERPROFILE: peerHome };
delete env.CLAUDE_MSG_NAME;
delete env.CLAUDE_MSG;

console.error(`--- delegating to [${peer}] (home: ${peerHome}) ---`);

const r = spawnSync('claude', ['-p', prompt, '--output-format', 'text'], {
  env,
  stdio: ['ignore', 'inherit', 'inherit'], // stream the sub-agent's output straight to our stdout so the caller sees it live
  shell: true,                             // lets Windows resolve claude(.cmd/.exe)
});

process.exit(r.status == null ? 1 : r.status);
