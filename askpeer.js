#!/usr/bin/env node
// askpeer.js —— 同步委派一件「簡單、不連貫（無狀態）」的任務給另一個實例。
// 用它的假 home 開一個一次性 claude（headless），做完把結果印出來（同步返回）。
//
// 用法： node askpeer.js <peer> "<任務內容>"
//   peer = work | personal
//
// 適用：一問一答、查一個東西、跑一段整理 —— 不需要跨呼叫記憶的任務。
// 不適用：需要連貫脈絡的多輪來回 —— 那請用訊息 channel（msg send/recv）。

const { spawnSync } = require('child_process');
const path = require('path');

const peer = process.argv[2];
const prompt = process.argv.slice(3).join(' ');

if (!peer || !prompt) {
  console.error('用法：node askpeer.js <work|personal> "<任務內容>"');
  process.exit(2);
}
if (peer !== 'work' && peer !== 'personal') {
  console.error('peer 只能是 work 或 personal');
  process.exit(2);
}

// bin 在 ...\.claude-split\bin，往上一層得到 .claude-split，再組出對方假 home
const splitBase = path.dirname(__dirname);
const peerHome = path.join(splitBase, '.claude-' + peer);

// 用對方的 home 開一次性 claude；清掉自己的 channel 身分（這是無狀態子工作）
const env = { ...process.env, USERPROFILE: peerHome };
delete env.CLAUDE_MSG_NAME;
delete env.CLAUDE_MSG;

console.error(`--- 委派給 [${peer}]（home: ${peerHome}）---`);

const r = spawnSync('claude', ['-p', prompt, '--output-format', 'text'], {
  env,
  stdio: ['ignore', 'inherit', 'inherit'], // 子 agent 的輸出直接串到本行程 stdout，呼叫端同步看到
  shell: true,                             // Windows 上讓 claude(.cmd/.exe) 能被解析
});

process.exit(r.status == null ? 1 : r.status);
