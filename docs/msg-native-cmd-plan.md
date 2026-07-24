# 從 chat 視窗觸發 agent 原生指令（零 token）規劃

狀態：**規劃中，待使用者決定後才實作**。
相關計畫：合作式中斷獨立成 `docs/msg-interrupt-plan.md`；本計畫的 Esc 注入若實測可行，對 split session 是更即時的中斷手段。

## Context

需求（2026-07-24）：在 broker chat 視窗觸發 agent session 的原生 Claude Code 指令（如 `/usage`、Esc），且盡可能零 token。

訊息平台做不到這件事：走訊息一定經過 agent 的模型（燒 token），而且 agent 的 tool 也執行不了 TUI 指令。唯一零 token 的路是把按鍵直接打進 agent 的終端機視窗——原生指令（/usage、/clear、Esc 中斷）都是本地 UI 動作，本身不耗 token。

## 方案：鍵盤注入（Windows、零依賴）

1. **session registry**：launcher（`Invoke-ClaudeWithProfile`）啟動 claude 前把 `{name: work|personal, pid, 啟動時間}` 寫進 `~\.claude-split\sessions.json`（退出時清掉）。目標定址用 launcher 身分（work/personal），不用 bus 名字——bus 名是 agent 自取的，跟視窗對不上。
2. **chat 指令**：`/key <work|personal> <按鍵串>`，糖：`/esc <target>`（送 Esc）、`/usage <target>`（送 `/usage{Enter}`）。
3. **注入 helper**（PowerShell，broker spawn）：記住目前前景視窗 HWND → 依 PID 找到目標視窗 `AppActivate` → `SendKeys` → `SetForegroundWindow` 切回原視窗。副作用：焦點閃離約 0.2 秒（正在打字會斷一下）。
4. `PostMessage`/`WriteConsoleInput` 免焦點方案對 Windows Terminal（ConPTY）不可靠，不賭；AutoHotkey `ControlSend` 要多裝東西，也先不用。

## 限制與風險

- 焦點閃爍是本方案的固定代價，先實測能不能接受。
- 只適用 split launcher 啟動的 session（有 registry 才找得到視窗）；平台上其他 agent（Codex/Gemini 或手開的 claude）不在射程內。
- SendKeys 打的是「鍵」不是「語意」：斜線指令要靠 Claude Code 的輸入框吃到 `/usage` + Enter，若當下 agent 正在跑（輸入框被佔用）行為未定，要實測。

## 替代路：/usage 類「查詢」直接讀檔

如果目的只是看用量（不是通用指令），有更乾淨的零 token 路：直接讀本機 transcript（`~\.claude\projects\**\*.jsonl` 有每回合 token 數，ccusage 就是這樣做的），chat 加 `/usage <target>` 在 broker 端自己算，零注入、零焦點閃爍。但只涵蓋「可從本地資料推導」的資訊，觸發不了任意原生指令。

## 待決問題（使用者決定後定案）

1. 接不接受焦點閃離 0.2 秒？不接受的話 Windows 上沒有可靠的免焦點注入，本計畫只剩讀檔替代路。
2. 需求清單裡到底有哪些指令？若只有 /usage 一種查詢，建議直接走讀檔，不做注入。
3. 目標定址用 work/personal 夠不夠（= 只管 split session）？

## 實作步驟（待定案後）

1. `claude-split.ps1`：`Invoke-ClaudeWithProfile` 寫入／清除 `sessions.json`。
2. 注入 helper：`sendkeys.ps1`（AppActivate + SendKeys + 焦點還原），或讀檔版 usage 統計。
3. `broker.js` chat 模式：`/key`、`/esc`、`/usage` 指令，spawn helper。
4. README 補 chat 指令說明；重跑 `Install-ClaudeSplit` 部署。

## 驗證

- agent 閒置時 `/usage work`：目標視窗跳出 usage 畫面，焦點回到 chat 視窗。
- agent 執行中 `/esc work`：正在跑的動作被打斷（觀察 agent 視窗）。
- 打字到一半在另一視窗觸發 `/key`：確認焦點閃爍的實際體感。

## 不做（YAGNI）

- 跨機器、非 Windows 支援。
- 對非 split session 的視窗探索（枚舉視窗猜標題之類的黑魔法）。
