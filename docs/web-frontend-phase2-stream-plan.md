# Web 前端 Phase 2：串流實作計畫

狀態：**修訂版，待重新核可**。前置條件：Phase 1 已上線（`docs/web-frontend-phase1-plan.md`）。
設計理由在 `docs/web-frontend-plan.md`。

> 第一版曾動工又回退。實作到一半暴露出三個問題：累積重 parse 在真實輸入下是 O(n²)、串流結束時畫面會出現兩次、chunk 會沖掉 ring buffer。本版是修正後的計畫。

## 問題

導向 bus 的長輸出（`npm test`、build log、tail 檔案）現在只能等指令跑完才一次送出，中間完全沒有回饋。

**先講清楚範圍**：agent 自己的回覆**無法**串流——`node msg.js send @user "…"` 啟動時文字已完整，沒有 token 流可接，真串流得攔截 Claude Code 自身輸出，bus 碰不到那層。能串流的只有被管線導進來的長輸出。「agent 講很長的話」的解法是 Phase 1 的自動收合，不是串流。前端把已收完的訊息打字機式吐出屬於假串流，不做。

## 協定

`send` 增加兩個選用欄位：`stream: true`（這條連線是一次串流）、`final: true`（最後一個 chunk）。

**送出端不產生 id。** 一次串流從頭到尾就是一條連線——中斷偵測本來就靠 socket 關閉，所以 socket 自己就是串流的識別。broker 在串流開始時把狀態掛在該 socket 上（`socket.stream = { from, to, parts, id }`），`id` 由 broker 產生，只出現在推給 tap 的事件裡，讓前端能把 chunk 歸到同一則。沒有 Map、沒有 Set、送出端不必記任何東西。

語意：
- 帶 `stream` 的 chunk **立刻推給 tap**。
- 對**佇列收件者**則緩衝，等 `final` 才合併成一則完整訊息投遞。
- 結果：串流純屬傳輸細節，**agent 端行為完全不變**，不會收到碎片。

## 四個實作陷阱

1. **`respond()` 會 `socket.end()`。** 現況 `handle()` 處理完 `send` 就回應並關閉連線，一條連線只能送一個 chunk。帶 `stream` 且非 `final` 的 send **必須不呼叫 `respond()`**，只有 `final`（或錯誤）才回應。
2. **`msg.js` 的 `request()` 收到第一行回應就 `socket.end()`。** `--stream` 不能共用它，需要另一條「開一次連線、寫多行、只等最後一個回應」的路徑。
3. **`final` 會產生兩個事件。** 最後一個 `chunk`，加上合併投遞觸發的 `msg`（走 `logMsg`）。前端若不處理，串流區塊已經有完整內容了，`msg` 還會再長出一則一模一樣的。**解法：把 stream id 掛到 emit 出去的 `msg` 事件上**（`logMsg(msg, extra, stream)`，只進 tap 事件，不進投遞給 agent 的訊息本體），前端看到認得的 id 就**替換**串流區塊而不是新增。
4. **`emit()` 現在的 history 條件是黑名單，`chunk` 一出現就破功。** 目前寫的是 `if (ev.type !== 'thinking')`，phase 1 只有三種事件時等價；chunk 進來後，一次 500 個 chunk 的串流會把 200 筆歷史整個擠掉，新分頁看到的是一堆碎片而不是對話。改成白名單 `if (ev.type === 'msg' || ev.type === 'log')`——phase 1 計畫原文本來就是這樣寫的。

## 逐檔改動

### `broker.js`（約 45 行，含註解）

1. **先把投遞邏輯從 `send` 分支抽成 `deliver(from, to, text, stream = null)`**，回傳原本 respond 的物件。不抽的話串流合併路徑得複製一份 `@all` 的邏輯，兩份遲早分岐。這是既有行為的重構，不改語意。
2. `emit()` 的 history 條件改白名單（陷阱 4）。
3. `logMsg(msg, extra, stream)` 第三個參數只影響 emit 出去的事件（陷阱 3）。
4. `handle()` 的 `send` 分支開頭：`if (req.stream) return chunk(req, socket);`
   `chunk()` 把 text 累進 `socket.stream.parts`（第一個 chunk 時建立，順便產生 id）、`emit({type:'chunk', stream: id, from, to, text, final})` 推給 tap。**非 `final` 就 `return`，不回應**；`final` 才合併、清掉 `socket.stream`、`respond(socket, deliver(..., id))`。終端機因此只會在合併時被 `logMsg` 印一行，不會被 chunk 洗版。
5. **中斷沖出用送出端 socket 關閉當訊號，不用閒置逾時。** 在 `createServer` 的 socket `close` 上檢查 `socket.stream` 還在不在，在就把已收到的部分投遞出去。閒置逾時會誤判——`npm test` 中間安靜兩分鐘完全正常。

兩個刻意決定，要記著：

- **`(interrupted)` 直接接在訊息內容尾巴**，等於改動 payload。保留，因為收件的 agent 必須知道內容被截斷。
- **`@all` 的收件人在合併時才決定**，不是串流開始時。串流中途上線的成員會收到，中途離線的收不到。

### `msg.js`（約 15 行）

`send` 分支加 `--stream` 旗標：開一條連線，**把 `process.stdin` 的每個 `data` 事件原樣當成一個 chunk 送出**，`end` 時送 `{..., final: true}` 並等回應。

不要自己做「N 行或 N 毫秒」的批次——Node 的 stream 本來就以 64KB 為單位讀進來，那層批次已經存在，再疊一層只是多一個計數器和一個 timer。

用法：`npm test | node msg.js send @user --as bob --stream`。

**stdin 是 TTY 時會停在那裡等 Ctrl+D**（標準 unix 行為），使用說明要寫清楚這是給管線用的。

### `web.js` / 前端

SSE 新增 `chunk` 事件型別。**前端的改動比第一版計畫小得多**：

- **串流進行中不做 Markdown**，chunk 直接 `textContent +=` 進一個 `<pre>`。不 parse、不重繪、不需要 rAF 節流，**也不需要累積 buffer**——文字就存在那個 DOM 節點裡，前端只要記住 id 對應的節點。
- **`final` 之後那則 `msg` 事件到達時**（帶著同一個 stream id），把整則換成正常的完整渲染 bubble——Markdown、code fence、複製鈕、收合全部照舊，一次做完。

**為什麼不照第一版的「累積後整個 buffer 重 parse」**：phase 1 實測 87.5KB 內容渲染要 536ms，而串流唯一的用途就是幾百 KB 起跳的 log。500KB 分 100 個 chunk、每個 chunk 重 parse 一次平均 250KB 的 buffer，等於兩位數秒級的主執行緒阻塞，而且是 O(n²)——串流本來要讓人邊跑邊看，結果比一次送到還卡。而且等寬純文字本來就是指令輸出該有的樣子，Markdown 不是。

連帶效果：「未閉合 ``` 怎麼顯示」這個問題消失了；「渲染器必須容忍未閉合結構」從必要條件降級成 nice-to-have，**也因此解除了「先決定串流再決定渲染器」的綁定**。ANSI 剝除在串流路徑上是必要的（管線輸出必然帶 ANSI），phase 1 已實作，只需確認 chunk 路徑也走到。

### `msg-bus-skill/SKILL.md` + `AGENTS-template.md`

新增 `--stream` 的**用法說明**（何時該用管線送長輸出：預期超過數十秒或數百行的指令輸出）。這是新能力，**不是**依前端版本分支的回應規則——後者明確不做。

### `README.md`

協定表的 `send` 一列補上 `stream` / `final` 兩個選用欄位。

### `web-smoke.js`

加一組串流檢查（見驗證 2、3、10、11），這幾項不需要瀏覽器。

## 驗證

1. `npm test | node msg.js send @user --as bob --stream`：網頁上逐步出現輸出。
2. 同一次串流，**agent 端** `msg recv --as user` 收到的是**一則完整訊息**，不是一堆碎片。
3. 串流中途 Ctrl-C 殺掉送出端：已收到的部分立刻沖出並標記 `(interrupted)`，`socket.stream` 不留殘骸。
4. 送出端安靜 3 分鐘（`sleep 180` 夾在輸出中間）：**不會**被誤判中斷。
5. 串流中的內容以等寬純文字逐段長出；`final` 之後**同一個位置**換成完整渲染（fence 變成程式碼區塊、複製鈕出現），畫面上只有一則，不是串流一則加合併一則。
6. 兩條串流同時進行（兩條連線）：內容不互相污染。
7. `@all` 串流：合併後每個在線成員各收到一則完整訊息。
8. **回歸**：不帶 `--stream` 的一般 send／recv／who／join 行為與 Phase 1 完全相同。
9. 帶 ANSI 的輸出（`npm test` 原生彩色）在網頁上乾淨顯示。
10. 終端機 broker 視窗只印一行合併後的訊息，不被 chunk 洗版。
11. **ring buffer 不被汙染**：串流 300 個 chunk 之後開新分頁，先前的歷史訊息還在。
12. 大檔實測：至少跑一次 500KB 以上的真實輸出，確認串流中 UI 不卡、`final` 之後的一次性渲染可接受。

## 不做（YAGNI）

per-chunk ack、對非 tap 收件者的即時碎片投遞（那會破壞「agent 行為不變」這個前提）、壓縮、斷點續傳、串流的持久化、串流中的即時 Markdown、送出端自訂的批次策略。
