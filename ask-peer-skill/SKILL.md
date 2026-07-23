---
name: ask-peer
description: 同步委派一件簡單、不連貫（無狀態、一次性）的任務給「另一個 Claude Code 實例」（work 與 personal 互相），並直接拿回結果。適用於一問一答、查一個東西、跑一段整理回報等不需要跨呼叫記憶的任務。當使用者說「叫 personal 幫我查／整理…」「請 work 幫我看…」而該任務可一次做完時觸發。需要連貫脈絡、多輪來回、或對方要一直活著的協作，請改用訊息 channel（msg send/recv），不要用本 skill。
---

# ask-peer：同步委派給另一個實例

## 什麼時候用（重要）

**用本 skill（bash / `claude -p`）—— 簡單、不連貫的任務：**
一次就能做完、不需要記得上一次講過什麼。例如：
「叫 personal 幫我查 TT-1720 並整理回報」「請 personal 看這個檔案有沒有問題」。
特性：同步（馬上拿回結果）、無狀態（每次是全新的一次性 agent）、不用等收發時機。

**不要用本 skill、改用訊息 channel —— 連貫、多輪的協作：**
需要對方記得脈絡、你們要來回討論好幾輪、或希望對方是一個一直活著的 peer。
那用 `node "$CLAUDE_MSG" send <peer> "…"` 與 `node "$CLAUDE_MSG" recv --wait N`。

一句話判準：**「這件事一次講清楚、對方做完回我就結束」→ 用 bash；「要邊做邊聊、要記得前情」→ 用 channel。**

## 怎麼做

在你的 Bash 工具執行（peer 填 `work` 或 `personal`，也就是「對方」）：

```bash
node "C:\Users\g3197\.claude-split\bin\askpeer.js" personal "幫我看 TT-1720 並整理回報：1) 標題與目的 2) 需求描述 3) 驗收條件"
```

它會用對方的假 home 開一個一次性 `claude -p`，**同步**把對方 agent 的輸出串回來。拿到結果後，把重點整理回報給使用者即可。

## 注意

- 這是**無狀態**呼叫：對方不會記得你上一次問過什麼；需要脈絡就一次在 prompt 裡講齊，或改用 channel。
- 對方用的是它自己的假 home（帳號／設定），所以它看得到的工具與登入狀態以那個 home 為準。
- 逾時或對方沒裝好時會有非 0 離開碼與錯誤訊息；照訊息排查即可。
