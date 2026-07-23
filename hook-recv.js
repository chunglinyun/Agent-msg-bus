#!/usr/bin/env node
// hook-recv.js —— Claude Code 的 Stop hook：agent 想結束回合時，順手去 broker 收信。
//   有訊息 -> 回傳 {decision:"block", reason:...}，讓 agent 不要停、繼續處理並回覆。
//   沒訊息 -> 不輸出、exit 0，正常結束。
//
// 需要的環境變數（由 claude-split launcher 注入）：
//   CLAUDE_MSG_NAME   這個實例的身分（work / personal）
//   CLAUDE_MSG_PORT   broker 埠（預設 8787）
//   CLAUDE_MSG        msg.js 的完整路徑（用來組回覆指令，可省）
// 可選：
//   CLAUDE_HOOK_WAIT  收信阻塞秒數（預設 0 = 只檢查一次不等）
//                     設成例如 300，就會在每次收尾後多守一個等待窗口。

const net = require('net');

const HOST = '127.0.0.1';
const PORT = process.env.CLAUDE_MSG_PORT ? Number(process.env.CLAUDE_MSG_PORT) : 8787;
const NAME = process.env.CLAUDE_MSG_NAME || null;
const WAIT = process.env.CLAUDE_HOOK_WAIT ? Number(process.env.CLAUDE_HOOK_WAIT) : 0;

function allowStop() { process.exit(0); } // 不輸出 = 允許 agent 正常結束

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => resolve(buf));
    setTimeout(() => resolve(buf), 300); // 沒有 stdin 時的保險
  });
}

function recv(name, wait) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(PORT, HOST);
    let buf = '', done = false;
    socket.on('connect', () => socket.write(JSON.stringify({ cmd: 'recv', name, wait }) + '\n'));
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
    socket.on('close', () => { if (!done) { done = true; reject(new Error('broker 沒回應')); } });
  });
}

(async () => {
  // 讀 hook 輸入（含 stop_hook_active），目前不需要據此改變行為，但先解析以防未來需要。
  try { JSON.parse((await readStdin()) || '{}'); } catch (_) {}

  if (!NAME) allowStop();               // 沒身分 -> 別擋 agent

  let r;
  try { r = await recv(NAME, WAIT); }
  catch (_) { allowStop(); return; }    // broker 沒開等狀況 -> 別擋 agent

  if (!r || !r.ok || !r.messages || !r.messages.length) allowStop();

  // 有訊息 -> 擋下結束，把訊息交回給 agent 處理
  const peer = NAME === 'work' ? 'personal' : 'work';
  const lines = r.messages.map((m) => `- ${m.from}: ${m.text}`).join('\n');
  const msgPath = process.env.CLAUDE_MSG || 'C:\\Users\\你\\.claude-split\\bin\\msg.js';
  const reason =
    `你收到 ${r.messages.length} 則來自 ${peer} 的訊息：\n${lines}\n\n` +
    `請完成它要求的事。完成後用這個指令回覆（不要用裸 msg，會打到系統 msg.exe）：\n` +
    `node "${msgPath}" send ${peer} "你的回覆"`;

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
})();
