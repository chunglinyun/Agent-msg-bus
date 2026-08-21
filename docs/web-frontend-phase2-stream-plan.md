# Web 前端 Phase 2：串流實作計畫

狀態：**修訂版，待重新核可**。前置條件：Phase 1 已上線（`docs/web-frontend-phase1-plan.md`）。
設計理由在 `docs/web-frontend-plan.md`。

> 第一版曾動工又回退。實作到一半暴露出三個問題：累積重 parse 在真實輸入下是 O(n²)、串流結束時畫面會出現兩次、chunk 會沖掉 ring buffer。本版是修正後的計畫，差異集中在「串流中怎麼顯示」一節。

## 問題

導向 bus 的長輸出（`npm test`、build log、tail 檔案）現在只能等指令跑完才一次送出，中間完全沒有回饋。

**先講清楚範圍**：agent 自己的回覆**無法**串流——`node msg.js send @user "…"` 啟動時文字已完整，沒有 token 流可接，真串流得攔截 Claude Code 自身輸出，bus 碰不到那層。能串流的只有被管線導進來的長輸出。「agent 講很長的話」的解法是 Phase 1 的自動收合，不是串流。前端把已收完的訊息打字機式吐出屬於假串流，不做。

**這個範圍限制決定了顯示方式**：串流內容依定義就是指令輸出，等寬純文字才是它的正確呈現，Markdown 不是。

## 協定

`send` 增加兩個選用欄位：`stream: <id>`（同一次串流的所有 chunk 共用）、`final: true`（最後一個 chunk）。

語意：
- 帶 `stream` 的 chunk **立刻推給 tap**，前端依 id 累積顯示。
- 對**佇列收件者**則依 id 緩衝，等 `final` 才合併成一則完整訊息投遞。
- 結果：串流純屬傳輸細節，**agent 端行為完全不變**，不會收到碎片。

## 四個實作陷阱

1. **`respond()` 會 `socket.end()`。** 現況 `handle()` 處理完 `send` 就回應並關閉連線，一條連線只能送一個 chunk。帶 `stream` 且非 `final` 的 send **必須不呼叫 `respond()`**，只有 `final`（或錯誤）才回應。
2. **`msg.js` 的 `request()` 收到第一行回應就 `socket.end()`。** `--stream` 不能共用它，需要另一條「開一次連線、寫多行、只等最後一個回應」的路徑。
3. **`final` 會產生兩個事件。** 最後一個 `chunk`，加上合併投遞觸發的 `msg`（走 `logMsg`）。前端若不處理，串流 bubble 已經有完整內容了，`msg` 還會再長出一則一模一樣的。**解法：把 stream id 掛到 emit 出去的 `msg` 事件上**（`logMsg(msg, extra, stream)`，只進 tap 事件，不進投遞給 agent 的訊息本體），前端看到認得的 id 就**替換**串流 bubble 而不是新增。
4. **`emit()` 現在的 history 條件是黑名單，`chunk` 一出現就破功。** 目前寫的是 `if (ev.type !== 'thinking')`，phase 1 只有三種事件時等價；chunk 進來後，一次 500 個 chunk 的串流會把 200 筆歷史整個擠掉，新分頁看到的是一堆碎片而不是對話。改成白名單 `if (ev.type === 'msg' || ev.type === 'log')`——phase 1 計畫原文本來就是這樣寫的。

## 逐檔改動

### `broker.js`（約 55 行，含註解）

原估 25 行沒算到 `deliver()` 的抽取。

1. 新增 `const streams = new Map();` — `id -> { from, to, parts }`。
2. **先把投遞邏輯從 `send` 分支抽成 `deliver(from, to, text, stream = null)`**，回傳原本 respond 的物件。不抽的話串流合併路徑得複製一份 `@all` 的邏輯，兩份遲早分岐。這是既有行為的重構，不改語意。
3. `emit()` 的 history 條件改白名單（陷阱 4）。
4. `logMsg(msg, extra, stream)` 第三個參數只影響 emit 出去的事件（陷阱 3）。
5. `handle()` 的 `send` 分支：`if (req.stream) return chunk(req, socket);`
   - `chunk()`：累積進 `streams`、`emit({type:'chunk', stream, from, to, text, final})` 立刻推 tap。
   - 非 `final` → **直接 `return`，不回應**。
   - `final` → 合併、`streams.delete(id)`、`respond(socket, deliver(..., id))`。
6. **中斷沖出用送出端 socket 關閉當訊號，不用閒置逾時。** 在 `createServer` 的 socket `close` 上檢查該連線是否還有未 `final` 的 id（掛一個 `socket.openStreams` Set），有就把已收到的部分投遞出去。閒置逾時會誤判——`npm test` 中間安靜兩分鐘完全正常。
7. `logMsg()` 只在合併投遞時呼叫一次，終端機不會被 chunk 洗版。

兩個刻意決定，要記著：

- **`(interrupted)` 直接接在訊息內容尾巴**，等於改動 payload。保留，因為收件的 agent 必須知道內容被截斷。
- **`@all` 的收件人在合併時才決定**，不是串流開始時。串流中途上線的成員會收到，中途離線的收不到。

### `msg.js`（約 25 行）

`send` 分支加 `--stream` 旗標：讀 stdin，依**行數或時間**批次（暫定 20 行或 200ms 先到者），每批送一行 `{cmd:'send', from, to, text, stream: id}`，stdin 結束送 `{..., stream: id, final:true}` 並等回應。`id` 用 `Date.now()` 加隨機字串。

用法：`npm test | node msg.js send @user --as bob --stream`。

**stdin 是 TTY 時會停在那裡等 Ctrl+D**（標準 unix 行為），使用說明要寫清楚這是給管線用的。

### `web.js` / 前端

SSE 新增 `chunk` 事件型別。**前端的改動比第一版計畫小得多**，因為顯示方式改了：

- **串流進行中不做 Markdown。** chunk 直接 `textContent +=` 進一個 `<pre>`，不 parse、不重繪、不需要 rAF 節流。
- **`final` 之後那則 `msg` 事件到達時**（帶著同一個 stream id），把整則換成正常的完整渲染 bubble——Markdown、code fence、複製鈕、收合全部照舊，一次做完。

**為什麼不照第一版的「累積後整個 buffer 重 parse」**：phase 1 實測 87.5KB 內容渲染要 536ms，而串流唯一的用途就是幾百 KB 起跳的 log。500KB 分 100 個 chunk、每個 chunk 重 parse 一次平均 250KB 的 buffer，等於兩位數秒級的主執行緒阻塞，而且是 O(n²)——串流本來要讓人邊跑邊看，結果比一次送到還卡。

連帶效果：

- 「未閉合 ``` 怎麼顯示」這個問題**不存在了**，串流中一律等寬純文字。
- 「渲染器必須容忍未閉合結構」從必要條件降級成 nice-to-have，phase 1 的自寫渲染器本來就是這個行為（未閉合 fence 吃到結尾、未閉合行內標記保持原字元），不必為它做事。
- **也因此解除了「先決定串流再決定渲染器」的綁定**——要換 marked 隨時可以換。
- ANSI 剝除在串流路徑上是必要的（管線輸出必然帶 ANSI）。phase 1 已實作，只需確認 chunk 路徑也走到。

### `msg-bus-skill/SKILL.md` + `AGENTS-template.md`

新增 `--stream` 的**用法說明**（何時該用管線送長輸出：預期超過數十秒或數百行的指令輸出）。這是新能力，**不是**依前端版本分支的回應規則——後者明確不做。

### `README.md`

協定表的 `send` 一列補上 `stream` / `final` 兩個選用欄位。

### `web-smoke.js`

加一組串流檢查（見驗證 2、3、11、12），這幾項不需要瀏覽器。

## 驗證

1. `npm test | node msg.js send @user --as bob --stream`：網頁上逐步出現輸出。
2. 同一次串流，**agent 端** `msg recv --as user` 收到的是**一則完整訊息**，不是一堆碎片。
3. 串流中途 Ctrl-C 殺掉送出端：已收到的部分立刻沖出並標記 `(interrupted)`，`streams` 不留殘骸。
4. 送出端安靜 3 分鐘（`sleep 180` 夾在輸出中間）：**不會**被誤判中斷。
5. 串流中的內容以等寬純文字逐段長出；`final` 之後同一個位置換成完整渲染（fence 變成程式碼區塊、複製鈕出現）。
6. 兩條串流同時進行（兩個 id 交錯）：內容不互相污染。
7. `@all` 串流：合併後每個在線成員各收到一則完整訊息。
8. **回歸**：不帶 `--stream` 的一般 send／recv／who／join 行為與 Phase 1 完全相同。
9. 帶 ANSI 的輸出（`npm test` 原生彩色）在網頁上乾淨顯示。
10. 終端機 broker 視窗只印一行合併後的訊息，不被 chunk 洗版。
11. **ring buffer 不被汙染**：串流 300 個 chunk 之後開新分頁，先前的歷史訊息還在。
12. **完成後畫面只有一則**：不是串流一則加合併一則。
13. 大檔實測：至少跑一次 500KB 以上的真實輸出，確認串流中 UI 不卡、`final` 之後的一次性渲染可接受。

## 不做（YAGNI）

per-chunk ack、對非 tap 收件者的即時碎片投遞（那會破壞「agent 行為不變」這個前提）、壓縮、斷點續傳、串流的持久化、串流中的即時 Markdown（見上）。
