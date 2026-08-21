# Web 前端 Phase 2：串流實作計畫

狀態：**待專案負責人核可，尚未實作**。前置條件：Phase 1 已上線（`docs/web-frontend-phase1-plan.md`）。
設計理由在 `docs/web-frontend-plan.md`。

## 問題

導向 bus 的長輸出（`npm test`、build log、tail 檔案）現在只能等指令跑完才一次送出，中間完全沒有回饋。

**先講清楚範圍**：agent 自己的回覆**無法**串流——`node msg.js send @user "…"` 啟動時文字已完整，沒有 token 流可接，真串流得攔截 Claude Code 自身輸出，bus 碰不到那層。能串流的只有被管線導進來的長輸出。「agent 講很長的話」的解法是 Phase 1 的自動收合，不是串流。前端把已收完的訊息打字機式吐出屬於假串流，不做。

## 協定

`send` 增加兩個選用欄位：`stream: <id>`（同一次串流的所有 chunk 共用）、`final: true`（最後一個 chunk）。

語意：
- 帶 `stream` 的 chunk **立刻推給 tap**，前端依 id 累積顯示。
- 對**佇列收件者**則依 id 緩衝，等 `final` 才合併成一則完整訊息投遞。
- 結果：串流純屬傳輸細節，**agent 端行為完全不變**，不會收到碎片。

## 兩個關鍵實作陷阱

1. **`respond()` 會 `socket.end()`。** 現況 `handle()` 處理完 `send` 就回應並關閉連線，一條連線只能送一個 chunk。帶 `stream` 且非 `final` 的 send **必須不呼叫 `respond()`**，只有 `final`（或錯誤）才回應。
2. **`msg.js` 的 `request()` 收到第一行回應就 `socket.end()`。** `--stream` 不能共用它，需要另一條「開一次連線、寫多行、只等最後一個回應」的路徑。

## 逐檔改動

### `broker.js`（約 25 行）

1. 新增 `const streams = new Map();` — `id -> { from, to, parts: [], ts }`。
2. `handle()` 的 `send` 分支開頭插入串流路徑：
   - 有 `req.stream`：`touch(req.from)`；`emit({ type:'chunk', stream: req.stream, from, to, text, final })` 立刻推 tap；把 text 累進 `streams`。
   - `final` 為真 → 取出合併，走現有的 `deliverOrQueue` / `@all` 路徑投遞完整訊息，`streams.delete(id)`，然後才 `respond`。
   - 非 `final` → **直接 `return`，不回應**。
3. **中斷沖出用送出端 socket 關閉當訊號，不用閒置逾時。** 一次串流由一條連線從頭持有到尾，在該 socket 的 `close` 上檢查是否還有未 `final` 的 id，有就把已收到的部分當完整訊息投遞（文字尾端標記 `(interrupted)`）並 emit 一則 log。
   閒置逾時會誤判——`npm test` 中間安靜兩分鐘完全正常。
4. `logMsg()` 只在合併投遞時呼叫一次（終端機不該被 chunk 洗版）。

### `msg.js`（約 25 行）

`send` 分支加 `--stream` 旗標：讀 stdin，依**行數或時間**批次（暫定 20 行或 200ms 先到者），每批送一行 `{cmd:'send', from, to, text, stream: id}`，stdin 結束送 `{..., text:'', stream: id, final:true}` 並等回應。`id` 用 `Date.now()+隨機`。
用法：`npm test | node msg.js send @user --as bob --stream`。

### `web.js` / 前端

- SSE 新增 `chunk` 事件型別。
- 前端維護 `id -> 累積 buffer`；**每收到一個 chunk 就把整個 buffer 重新完整 parse**，不做增量／狀態式 parser（buffer 只有幾 KB，重 parse 成本可忽略；增量 parser 要維護跨 chunk 狀態，是所有 bug 的來源）。
- 渲染器必須**容忍未閉合結構**：未閉合的 ``` 視為開著的 code block，其後全當程式碼；未閉合的行內標記（`` ` ``、`**`）保持原字元不隱式閉合，避免畫面跳動。
- 重 parse 用 `requestAnimationFrame` 節流，且**只重繪最後一則 bubble**。
- ANSI 剝除在此變成必要而非選配（管線輸出必然帶 ANSI），Phase 1 已實作，此處只需確認 chunk 路徑也有走到。

### `msg-bus-skill/SKILL.md` + `AGENTS-template.md`

新增 `--stream` 的**用法說明**（何時該用管線送長輸出：預期超過數十秒或數百行的指令輸出）。這是新能力，**不是**依前端版本分支的回應規則——後者明確不做。

### `README.md`

協定表的 `send` 一列補上 `stream` / `final` 兩個選用欄位。

## 驗證

1. `npm test | node msg.js send @user --as bob --stream`：網頁上逐步出現輸出。
2. 同一次串流，**agent 端** `msg recv --as user` 收到的是**一則完整訊息**，不是一堆碎片。
3. 串流中途 Ctrl-C 殺掉送出端：已收到的部分立刻沖出並標記 `(interrupted)`，`streams` 不留殘骸。
4. 送出端安靜 3 分鐘（`sleep 180` 夾在輸出中間）：**不會**被誤判中斷。
5. 未閉合 ``` 的 chunk：前端顯示為開著的 code block；收到結尾 fence 後收斂成正常區塊。
6. 兩條串流同時進行（兩個 id 交錯）：內容不互相污染。
7. `@all` 串流：合併後每個在線成員各收到一則完整訊息。
8. **回歸**：不帶 `--stream` 的一般 send／recv／who／join 行為與 Phase 1 完全相同。
9. 帶 ANSI 的輸出（`npm test` 原生彩色）在網頁上乾淨顯示。
10. 終端機 broker 視窗只印一行合併後的訊息，不被 chunk 洗版。

## 不做（YAGNI）

per-chunk ack、對非 tap 收件者的即時碎片投遞（那會破壞「agent 行為不變」這個前提）、壓縮、斷點續傳、串流的持久化。
