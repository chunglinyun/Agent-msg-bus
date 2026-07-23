#!/usr/bin/env node
// claude-msg broker: 極簡訊息匯流排 (NDJSON over localhost TCP)
// 每個 session 用任意名字收發訊息（join 防撞名、who 看成員、@all 廣播）。
// recv 支援 blocking wait：queue 空時 hold 住連線，直到有訊息或逾時。
//
// 用法： node broker.js
//   前景跑（Start-ClaudeBroker）＝ chat 模式：視窗即人類聊天視窗，輸入「成員 訊息」送訊。
//   背景跑（msg up）＝ 純 broker，人類用 msg send/recv。
// 環境變數： CLAUDE_MSG_PORT (預設 8787)、CLAUDE_MSG_STALE_MS (成員存活 TTL，預設 10 分鐘)

const net = require('net');
const readline = require('readline');

const HOST = '127.0.0.1'; // 只綁 loopback，外部連不進來
const PORT = process.env.CLAUDE_MSG_PORT ? Number(process.env.CLAUDE_MSG_PORT) : 8787;

// chat 模式：前景跑（stdin 是 TTY）時，broker 視窗兼作人類的聊天視窗。
// 給 user 的訊息直接顯示、不入列；直接輸入「成員 訊息」即可送出。
// msg up 背景跑（stdio ignore）時自動關閉，行為與舊版相同。
const HUMAN = 'user';
const chatMode = !!process.stdin.isTTY;
let rl = null;

// 每個名字固定一個顏色：第一次看到就發下一格，前 8 個名字保證不同色（hash 會撞）
const PALETTE = [36, 33, 35, 32, 34, 91, 96, 95];
const colorOf = new Map(); // name -> ANSI 色碼
function cname(name) {
  if (name === HUMAN) return '\x1b[1;97m你\x1b[0m';
  if (!colorOf.has(name)) colorOf.set(name, PALETTE[colorOf.size % PALETTE.length]);
  return `\x1b[${colorOf.get(name)}m${name}\x1b[0m`;
}

const queues = new Map();  // name -> [msg, ...]
const waiters = new Map(); // name -> [{ socket, timer }, ...]
const roster = new Map();  // name -> lastSeen (ms)。ponytail: 不做 leave/prune，讀取時用 alive() 過濾即可
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
  const line = `[${new Date().toLocaleTimeString('en-GB')}] ${s}`;
  if (rl) {
    // 正在打字時先清掉輸入列，印完再還原（prompt(true) 保留已輸入的字）
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    console.log(line);
    rl.prompt(true);
  } else console.log(line);
}

// 送達順序：有 waiter 直接給 → 給 user 且 chat 模式就靠 log 顯示（不入列）→ 其餘入列
function deliverOrQueue(name, msg) {
  if (deliverToWaiter(name, msg)) return;
  if (name === HUMAN && chatMode) return;
  getQueue(name).push(msg);
}

function logMsg(msg, extra = '') {
  const arrow = msg.to === 'all' ? `${cname(msg.from)} ⇒ @all` : `${cname(msg.from)} → ${cname(msg.to)}`;
  // 給人類看的訊息加 ★ 並把內文亮白，掃一眼就找得到
  const text = msg.to === HUMAN || msg.to === 'all' ? `\x1b[97m${msg.text}\x1b[0m` : msg.text;
  log(`${msg.to === HUMAN ? '\x1b[1;93m★\x1b[0m ' : ''}${arrow}: ${text}${extra}`);
}

function handle(req, socket) {
  const cmd = req.cmd;

  if (cmd === 'send') {
    if (!req.to) return respond(socket, { ok: false, error: 'missing "to"' });
    touch(req.from);
    if (req.to === 'all') {
      // 廣播：送給 roster 中還活著的所有成員（不含自己）。stale 成員不收，不塞死人 queue。
      const targets = [...roster.keys()].filter((n) => alive(n) && n !== req.from);
      const msg = { from: req.from || '?', to: 'all', text: req.text ?? '', ts: Date.now() };
      for (const n of targets) deliverOrQueue(n, msg);
      logMsg(msg, `（${targets.length} 人）`);
      return respond(socket, { ok: true, delivered: targets.length });
    }
    const msg = { from: req.from || '?', to: req.to, text: req.text ?? '', ts: Date.now() };
    deliverOrQueue(req.to, msg);
    logMsg(msg, alive(req.to) ? '' : '（未上線，已入列）');
    // 對方不在線就提示（可能是打錯名字），訊息仍入列
    if (!alive(req.to)) return respond(socket, { ok: true, hint: `"${req.to}" 未上線，訊息已入列` });
    return respond(socket, { ok: true });
  }

  if (cmd === 'join') {
    const name = req.name;
    if (!name || name === 'all' || name.startsWith('@'))
      return respond(socket, { ok: false, error: '名字不可為空、"all" 或以 @ 開頭' });
    if (alive(name)) return respond(socket, { ok: false, error: `"${name}" 已被使用` });
    touch(name);
    log(`${cname(name)} 上線`);
    return respond(socket, { ok: true, name });
  }

  if (cmd === 'who') {
    const peers = [...roster.entries()].filter(([n]) => alive(n))
      .map(([name, ts]) => ({
        name, lastSeen: ts,
        waiting: !!(waiters.get(name) || []).length, // 正在阻塞 recv = 現在就在線
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
  log(`claude-msg broker 已啟動，監聽 ${HOST}:${PORT}，關閉請按 Ctrl+C`);
  if (!chatMode) return;

  // --- chat 模式：這個視窗就是人類的聊天視窗 ---
  process.stdout.write('\x1b]0;claude-msg chat\x07'); // 視窗標題
  // tab 補全：只補第一格（收件人），候選＝在線成員 + all + /who
  const completer = (line) => {
    if (line.includes(' ')) return [[], line]; // 已在打訊息內文，不補
    const cands = [...roster.keys()].filter((n) => alive(n) && n !== HUMAN).concat('all', '/who');
    const hits = cands.filter((c) => c.startsWith(line));
    return [hits.length ? hits : cands, line];
  };
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, completer });
  // readline 會攔掉 Ctrl+C（SIGINT 發到 rl 不到 process），不接手 node 就死不掉
  rl.on('SIGINT', () => process.exit(0));
  rl.on('close', () => process.exit(0)); // Ctrl+D 同樣退出
  rl.setPrompt('你> ');
  touch(HUMAN);
  setInterval(() => touch(HUMAN), 60 * 1000).unref(); // 視窗開著 = user 在線

  rl.on('line', (raw) => {
    const line = raw.trim();
    if (!line) return rl.prompt();
    if (line === '/who') {
      const names = [...roster.keys()].filter((n) => alive(n) && n !== HUMAN);
      log(names.length ? names.map((n) => `${cname(n)}(queue:${getQueue(n).length})`).join('  ') : '(沒有在線成員)');
      return rl.prompt();
    }
    const sp = line.indexOf(' ');
    const to = (sp > 0 ? line.slice(0, sp) : '').replace(/^@/, '');
    const text = sp > 0 ? line.slice(sp + 1).trim() : '';
    if (!to || !text) { log('用法：<成員|all> <訊息>；/who 看在線'); return rl.prompt(); }
    touch(HUMAN);
    if (to === 'all') {
      const targets = [...roster.keys()].filter((n) => alive(n) && n !== HUMAN);
      const msg = { from: HUMAN, to: 'all', text, ts: Date.now() };
      for (const n of targets) deliverOrQueue(n, msg);
      logMsg(msg, `（${targets.length} 人）`);
    } else {
      const msg = { from: HUMAN, to, text, ts: Date.now() };
      deliverOrQueue(to, msg);
      logMsg(msg, alive(to) ? '' : '（未上線，已入列）');
    }
    rl.prompt();
  });

  log('chat 模式：輸入「成員 訊息」送訊、「all 訊息」廣播、/who 看在線');
  rl.prompt();
});
