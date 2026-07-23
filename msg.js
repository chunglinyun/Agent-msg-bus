#!/usr/bin/env node
// claude-msg CLI helper：讓 Claude Code 的 agent 用 Bash 收發訊息。
//
// 身分來自環境變數 CLAUDE_MSG_NAME（由 launcher 設定，例如 work / personal）。
// 用法：
//   msg send <對方> <訊息...>     送訊息給對方
//   msg recv [--wait N]           收訊息；--wait N 會阻塞最多 N 秒等新訊息
//   msg ping                      檢查 broker 是否活著
//   msg whoami                    顯示自己的身分

const net = require('net');

const HOST = '127.0.0.1';
const PORT = process.env.CLAUDE_MSG_PORT ? Number(process.env.CLAUDE_MSG_PORT) : 8787;
const NAME = process.env.CLAUDE_MSG_NAME || null;

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
    socket.on('close', () => { if (!done) { done = true; reject(new Error('沒有回應（broker 沒開？）')); } });
  });
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  try {
    if (cmd === 'send') {
      const to = rest[0];
      const text = rest.slice(1).join(' ');
      if (!to || !text) { console.error('用法：msg send <對方> <訊息>'); process.exit(2); }
      const r = await request({ cmd: 'send', from: NAME || '?', to, text });
      if (r.ok) console.log(`已送出 -> ${to}`);
      else { console.error('錯誤：', r.error); process.exit(1); }

    } else if (cmd === 'recv') {
      if (!NAME) { console.error('未設定 CLAUDE_MSG_NAME'); process.exit(2); }
      let wait = 0;
      const wi = rest.indexOf('--wait');
      if (wi >= 0) wait = Number(rest[wi + 1] || 0);
      const r = await request({ cmd: 'recv', name: NAME, wait });
      if (!r.ok) { console.error('錯誤：', r.error); process.exit(1); }
      if (!r.messages.length) { console.log('(沒有新訊息)'); return; }
      for (const m of r.messages) {
        const t = new Date(m.ts).toLocaleTimeString();
        console.log(`[${t}] ${m.from}: ${m.text}`);
      }

    } else if (cmd === 'ping') {
      const r = await request({ cmd: 'ping' });
      console.log(r.pong ? 'broker OK' : '沒有 pong');

    } else if (cmd === 'whoami') {
      console.log(NAME || '(未設定 CLAUDE_MSG_NAME)');

    } else {
      console.log('用法：msg send <對方> <訊息> | msg recv [--wait N] | msg ping | msg whoami');
    }
  } catch (e) {
    console.error('失敗：', e.message);
    process.exit(1);
  }
}

main();
