#!/usr/bin/env node
// claude-msg broker: 極簡訊息匯流排 (NDJSON over localhost TCP)
// 每個 session 用名字 (work / personal) 收發訊息。
// recv 支援 blocking wait：queue 空時 hold 住連線，直到有訊息或逾時。
//
// 用法： node broker.js
// 環境變數： CLAUDE_MSG_PORT (預設 8787)

const net = require('net');

const HOST = '127.0.0.1'; // 只綁 loopback，外部連不進來
const PORT = process.env.CLAUDE_MSG_PORT ? Number(process.env.CLAUDE_MSG_PORT) : 8787;

const queues = new Map();  // name -> [msg, ...]
const waiters = new Map(); // name -> [{ socket, timer }, ...]

function getQueue(name) {
  if (!queues.has(name)) queues.set(name, []);
  return queues.get(name);
}

function respond(socket, obj) {
  try {
    socket.write(JSON.stringify(obj) + '\n');
    socket.end();
  } catch (_) { /* socket 可能已關 */ }
}

// 有人在等 name 的訊息就直接送、清掉 waiter；否則回傳 false 讓呼叫端進 queue
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
  console.log(`[${new Date().toISOString()}] ${s}`);
}

function handle(req, socket) {
  const cmd = req.cmd;

  if (cmd === 'send') {
    if (!req.to) return respond(socket, { ok: false, error: 'missing "to"' });
    const msg = { from: req.from || '?', to: req.to, text: req.text ?? '', ts: Date.now() };
    if (!deliverToWaiter(req.to, msg)) getQueue(req.to).push(msg);
    log(`send  ${msg.from} -> ${msg.to}: ${msg.text}`);
    return respond(socket, { ok: true });
  }

  if (cmd === 'recv') {
    const name = req.name;
    if (!name) return respond(socket, { ok: false, error: 'missing "name"' });
    const q = getQueue(name);
    if (q.length) {
      const messages = q.splice(0, q.length);
      return respond(socket, { ok: true, messages });
    }
    const wait = Number(req.wait || 0);
    if (wait > 0) {
      // 阻塞：hold 住連線，等 send 進來或逾時
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
      return; // 不回應，等事件
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
  socket.on('error', () => { /* 忽略斷線錯誤 */ });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`port ${PORT} 已被占用 — broker 可能已在執行。`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  log(`claude-msg broker 已啟動，監聽 ${HOST}:${PORT}`);
  log(`關閉請按 Ctrl+C`);
});
