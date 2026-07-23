#!/usr/bin/env node
// claude-msg CLI helper：讓人類與各家 agent 用 shell 收發訊息。
//
// 身分優先序：--as <名字> > 環境變數 CLAUDE_MSG_NAME > 預設 "user"（人類）。
// 用法：
//   msg send <@對方|@all> <訊息...>   送訊息（@ 可省略；@all 廣播給所有在線成員）
//   msg @對方 <訊息...>               send 的縮寫
//   msg recv [--wait N]               收訊息；--wait N 會阻塞最多 N 秒等新訊息
//   msg join <名字>                   以此名字上線（broker 防撞名）
//   msg who                           看誰在線
//   msg up                            broker 沒開就在背景啟動它
//   msg ping                          檢查 broker 是否活著
//   msg whoami                        顯示自己的身分
// 共通參數：--as <名字> 指定本次身分（agent 的 shell 不保留環境變數，每次都要帶）

const net = require('net');

const HOST = '127.0.0.1';
const PORT = process.env.CLAUDE_MSG_PORT ? Number(process.env.CLAUDE_MSG_PORT) : 8787;

// 先抽出 --as，剩下的才是子指令與參數
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
    socket.on('close', () => { if (!done) { done = true; reject(new Error('沒有回應（broker 沒開？先跑 msg up）')); } });
  });
}

async function main() {
  let [cmd, ...rest] = argv;
  // @xxx 開頭視同 send：msg @foo "hi" ≡ msg send foo "hi"
  if (cmd && cmd.startsWith('@')) { rest.unshift(cmd); cmd = 'send'; }

  try {
    if (cmd === 'send') {
      const to = (rest[0] || '').replace(/^@/, '');
      const text = rest.slice(1).join(' ');
      if (!to || !text) { console.error('用法：msg send <@對方|@all> <訊息>'); process.exit(2); }
      const r = await request({ cmd: 'send', from: NAME, to, text });
      if (!r.ok) { console.error('錯誤：', r.error); process.exit(1); }
      if (to === 'all') console.log(`已廣播給 ${r.delivered} 個成員`);
      else console.log(`已送出 -> ${to}` + (r.hint ? `（${r.hint}）` : ''));

    } else if (cmd === 'recv') {
      let wait = 0;
      const wi = rest.indexOf('--wait');
      if (wi >= 0) wait = Number(rest[wi + 1] || 0);
      const r = await request({ cmd: 'recv', name: NAME, wait });
      if (!r.ok) { console.error('錯誤：', r.error); process.exit(1); }
      if (!r.messages.length) { console.log('(沒有新訊息)'); return; }
      for (const m of r.messages) {
        const t = new Date(m.ts).toLocaleTimeString();
        console.log(`[${t}] ${m.to === 'all' ? '@all ' : ''}${m.from}: ${m.text}`);
      }

    } else if (cmd === 'join') {
      const name = (rest[0] || '').replace(/^@/, '');
      if (!name) { console.error('用法：msg join <名字>'); process.exit(2); }
      const r = await request({ cmd: 'join', name });
      if (!r.ok) { console.error('錯誤：', r.error); process.exit(1); }
      console.log(`已加入：${r.name}`);

    } else if (cmd === 'who') {
      const r = await request({ cmd: 'who' });
      if (!r.ok) { console.error('錯誤：', r.error); process.exit(1); }
      if (!r.peers.length) { console.log('(沒有在線成員)'); return; }
      for (const p of r.peers) {
        const idle = Math.round((Date.now() - p.lastSeen) / 1000);
        console.log(`${p.name}  (${p.waiting ? '等待中' : `閒置 ${idle}s`})  queue:${p.queued}`);
      }

    } else if (cmd === 'up') {
      try { await request({ cmd: 'ping' }); console.log('broker 已在執行'); return; } catch (_) {}
      const { spawn } = require('child_process');
      // ponytail: stdio ignore，broker log 會消失；要看 log 就前景跑 node broker.js
      spawn(process.execPath, [require('path').join(__dirname, 'broker.js')],
        { detached: true, stdio: 'ignore' }).unref();
      console.log(`broker 已於背景啟動（port ${PORT}）`);

    } else if (cmd === 'ping') {
      const r = await request({ cmd: 'ping' });
      console.log(r.pong ? 'broker OK' : '沒有 pong');

    } else if (cmd === 'whoami') {
      console.log(NAME);

    } else {
      console.log('用法：msg send <@對方|@all> <訊息> | msg @對方 <訊息> | msg recv [--wait N] | msg join <名字> | msg who | msg up | msg ping | msg whoami（共通：--as <名字>）');
    }
  } catch (e) {
    console.error('失敗：', e.message);
    process.exit(1);
  }
}

main();
