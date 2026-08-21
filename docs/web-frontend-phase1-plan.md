# Web 前端 Phase 1 實作計畫

狀態：**已實作於 `feat/web-frontend` 分支**（實作時的偏離記於各節）。
設計理由一律在 `docs/web-frontend-plan.md`（討論記錄），本文件不重複論證，只寫「改哪裡、怎麼驗」。
Phase 2（串流）另見 `docs/web-frontend-phase2-stream-plan.md`。

## 問題

終端機讀 bus 對話很吃力：Markdown 是純文字、HTML 完全看不出結果、長訊息把畫面沖掉。要一個本機網頁介面參與同一條 bus。

## 範圍

**做**：瀏覽器以 `user` 身分即時看到 bus 上**所有**訊息（含 A→B）、送訊息、**六個 session 指令**、Markdown 渲染、` ```html ` fence 的 sandbox 預覽、長訊息收合、複製鈕、打字中指示器、成員清單。

**操作方式與前景 broker 完全一致**：同一套輸入語法（`<member|all> <message>`、`/who`、`/<cmd> <session>`），不另創一套 UI 慣例。

**不做**：串流（Phase 2）、`msg log`／受限檔案端點（Phase 3，未成案）、訊息編輯刪除、持久化。

## 設計摘要

1. 前端就是一個叫 `user` 的 bus client，**零身分概念新增**、不呼叫 `join`。與前景 `Start-ClaudeBroker` **可以並存**（理由見下方「身分衝突」一節），同一則訊息會在兩個視窗各出現一次。
2. **顯示走新增的 `tap`，不走 `recv`**——`user` 的佇列看不到 A→B。`recv --as user` 照跑但收到就丟，只為排佇列與維持在線。
3. **那條 recv 由 `web.js` process 長期持有**，不綁分頁；否則每次重新整理都會觸發 broker.js:296-306 的 `roster.delete` 並洗一行 disconnected。
4. **渲染靠建構式白名單**：先跳脫，之後頁面上每個標籤都是渲染器自己產生的。不寫 sanitizer、不支援 inline HTML。
5. **CSP nonce 當保命索**，agent 送的 HTML 只進 `sandbox=""` iframe。
6. **HTTP server 是新增的網路面**，四道 CSRF／DNS-rebinding 防線一道都不能省。

## 身分衝突：不需要「後踢前」機制

**不需要搶佔，也不需要 takeover 協定，因為根本沒有人去 `join`。** web.js 靠 `recv` 的 `touch()` 上線，`join` 從頭到尾不會被呼叫，clash 檢查也就不會觸發。兩個 web.js 同時跑的情況由 port 8788 佔用擋掉，比協定層便宜。

**而且前景 broker 與前端其實可以並存**，原本文件寫的「互斥」比實際情況嚴格。重新對照程式碼：

- `deliverOrQueue()` 先試 `deliverToWaiter()`，web.js 幾乎永遠掛著一個 `user` 的 waiter，所以 chat mode 那句 `if (name === HUMAN && chatMode) return;` 根本輪不到執行。
- 更關鍵的是 **`logMsg()` 一定會跑**（broker.js 的 send 分支：先 `deliverOrQueue` 再 `logMsg`，與誰收走了無關），而終端機的顯示和 tap 的事件**都出自它**。

結論：兩邊都會看到每一則訊息，兩邊都能送。真正被消耗掉的只有「排進 `user` 佇列」這件事，而前端本來就把 recv 的結果丟掉。因此文件只需要一句軟性提醒——同一則訊息會在兩個視窗各出現一次——不需要互斥警語，也不需要搶佔。

## 逐檔改動

### `broker.js`（約 30 行）

1. **新增模組層狀態**：`const taps = new Set();`、`const history = []; const HISTORY_MAX = 200;`
2. **新增 `emit(ev)`**：`ev.ts` 補上 → push 進 `history`（超過 200 從頭砍）→ 對每個 tap socket 寫 `JSON.stringify(ev) + '\n'`（try/catch 吞掉死 socket）。
   **不可用 `respond()`**：它寫完就 `socket.end()`，tap 需要長連線。
   **`history` 只收 `msg` 與 `log`，不收 `thinking`。** thinking 是高頻狀態切換，進了 ring buffer 會把真正的訊息擠出 200 筆之外；而 Phase 3 的 `msg log` 共用這塊 buffer，更不該看到它。
3. **`log(s)` 加一個參數**：`function log(s, tap = true)`，在函式尾端 `if (tap) emit({ type: 'log', text: String(s).replace(ANSI, '') })`。
   把 `dispWidth()` 裡的 `/\x1b\[[0-9;]*m/g` 抽成模組層 `const ANSI = ...` 給兩邊共用（只用於 `.replace`，不會有 `lastIndex` 問題）。
4. **`logMsg()` 改呼叫 `log(..., false)`**，並自行 `emit({ type: 'msg', ...msg, queued: msg.to !== 'all' && !alive(msg.to) })`。
   `extra` 那個顯示字串不要原樣塞進事件——前端要的是「對方離線、已排隊」這個布林，不是中文字尾；`@all` 的收件人數前端從 `who` 自己算得出來。
   理由：`logMsg` 手上就有結構化的 `{from, to, text, ts}`；若讓它經由 `log` 的 tap 路徑，前端只會拿到格式化字串，而且會與 msg 事件重複。
   **不要掛 `deliverOrQueue()`**——`@all` 會跑 N 次，tap 收到 N 份重複。
5. **`setThinking()` 拿掉 `!chatMode`**：`if (!name || name === HUMAN) return;`。`syncSpinner` 本來就是背景模式下的 no-op，不需額外保護。函式尾端加 `emit({ type: 'thinking', name, on })`。
6. **`handle()` 新增 `cmd === 'tap'`**：`taps.add(socket)` → 逐筆寫 `history` → 寫一筆 `{ type: 'ready', thinking: [...thinking.keys()] }` → `socket.on('close', () => taps.delete(socket))` → **`return` 不 respond**（不能結束連線）。
   - **加入與補歷史必須在同一個同步 tick 內完成**（都是 `socket.write`，不要改成 async），否則補歷史途中進來的 `emit` 會與歷史交錯或重複。
   - **`ready` 不是裝飾，是必要的分界線**：tap 重連時會再收到一次完整歷史，前端要能「取代」而非「追加」自己那份 buffer，靠的就是這個標記。順便把當下的 `thinking` 帶過去，否則新連上的 tap 要等下一次狀態變化才知道誰在忙。

7. **新增 `cmd === 'command'`**：`{cmd:'command', name:'stop'|'compact'|…, target:'<session>'}` → 驗證 `name` 在 `COMMANDS` 裡（**白名單，不可直接把字串當 key 取值**）→ 呼叫既有的 `runCommand(name, target)` → `respond({ok:true})`。
   `runCommand` 已經是獨立函式、不碰 `rl`，它內部的 `log()`（找不到 session、ambiguous、送出成功）也會自然流進 tap，所以 broker 這邊實際只多 3 行。
   不做的話，改用網頁前端等於失去全部六個 session 指令，其中 `/stop` 是 Claude Code 唯一的外部中斷手段。

ponytail 上限：
- `history` 只存記憶體，broker 重啟即空。
- tap 沒有 backpressure（寫入失敗就丟該 socket）。
- ring buffer 是 200 筆**訊息物件**，沒有單筆大小上限——agent 硬塞幾十 KB 的 HTML，200 筆就是幾十 MB。這正是「大型產出寫檔案」那條約定要擋的事；真咬到再加單筆截斷。

### `web.js` + `web.html`（新檔）

Node http server，port 8788（broker 仍 8787），零依賴。

**偏離計畫：頁面拆成 `web.html`，沒有內嵌成 JS 字串。** 原因是頁面裡到處是正規表示式與反引號，塞進 template literal 要層層跳脫，讀起來與改起來都危險。`web.js` 啟動時讀一次、把 `__NONCE__` 換掉。依賴數仍是零，只是多一個檔案——兩份安裝清單都要一起複製。

**與 broker 的兩條長連線**（process 自己持有，與瀏覽器無關）：

- tap 連線：連上送 `{cmd:'tap'}`，逐行 parse，扇出給所有 SSE client。斷線每 2 秒重連，重連期間對前端送一則離線提示。
- recv 迴圈：`{cmd:'recv', name:'user', wait:300}` 收到就丟，回來後立刻再送下一輪。
  **`wait` 用 300 不用 540。** roster TTL 是 600 秒，而 `recv` 的 `touch()` 是背景模式下 `user` **唯一**的保活來源（`who` 不 touch，chat 模式那個每 60 秒的 `touch(HUMAN)` 在背景模式根本不執行）。540 只剩 60 秒餘裕，任何一次重連延遲都會讓 `user` 在別人的 `who` 裡短暫消失。
  **不要呼叫 `join`。** `recv` 的 `touch()` 已足夠讓 `user` 上線，而 `join` 在 `user` 仍存活時會直接失敗（例如 web.js 重啟得夠快）。

**路由**：

| 路由 | 行為 |
|---|---|
| `GET /` | 內嵌 HTML；回應帶 `Content-Security-Policy` header，內嵌 script 用每次啟動隨機的 nonce |
| `GET /events` | SSE；先補歷史（tap 已在連上時補過，web.js 自己也留一份最近 200 筆給後進的分頁）→ 之後即時推送；每 15 秒送一個 `:\n\n` heartbeat |
| `POST /send` | 四道檢查通過後轉成 broker 的 `{cmd:'send', from:'user', to, text}` |
| `GET /who` | 轉發 broker 的 `who`（前端每 5 秒輪詢，用於成員清單與 idle 時間） |
| `POST /command` | 四道檢查通過後轉成 broker 的 `{cmd:'command', name, target}` |

**web.js 自己也要留一份最近 200 筆**：後進的分頁沒辦法叫 broker 重放（web.js 對 broker 只有一條 tap 連線）。
**tap 重連時必須「取代」而非「追加」**：收到 `ready` 之前的事件全視為歷史重放（清空後重建），`ready` 之後才是即時事件。少了這條，一次 tap 重連就會讓所有歷史訊息在畫面上出現兩份。

**`POST /send` 的四道防線**（順序即成本順序，任一不過就 403）：

1. `Content-Type` 必須是 `application/json`。
2. `Origin` / `Sec-Fetch-Site` 必須是本頁。
3. `Host` 必須是 `127.0.0.1:8788` 或 `localhost:8788`（擋 DNS rebinding）。
4. `server.listen(8788, '127.0.0.1')`，不綁 `0.0.0.0`。

兩個配套，少了任一道第 1、2 道就形同虛設：

- **不要實作 `OPTIONS`，也絕不回任何 `Access-Control-Allow-*` header。** 第 1 道的整個原理是「跨站要送 JSON 就得先 preflight」，preflight 必須失敗才擋得住；反射式地補上 CORS header 等於自己把門打開。
- **頁面裡的 `fetch` 一律用相對路徑**（`/send`），不要寫死 `http://127.0.0.1:8788/send`。`localhost` 與 `127.0.0.1` 是**不同 origin**，使用者用 `localhost:8788` 開頁面時，寫死 IP 會讓自己的請求變成跨站，撞上第 2 道檢查。

**CSP header**：

```
default-src 'none'; script-src 'nonce-<random>'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
```

後三個指令**不會**從 `default-src` 繼承，必須自己寫出來：`frame-ancestors` 擋外部網頁把本頁 iframe 起來做點擊劫持（送出鈕就在頁面上），`base-uri` 與 `form-action` 是渲染器萬一被繞過時的補漏。

實作時必須實測 `srcdoc` 預覽 iframe 渲染得出來（`default-src 'none'` 會讓 `frame-src` 退回 `'none'`，各瀏覽器對無 URL 的 srcdoc 管轄認定不一致），必要時補 `frame-src 'self'`。

**內嵌前端 JS 的處理順序**（順序即安全性，不可調換）：

1. 剝 ANSI escape sequence。
2. 去掉 bidi 控制字元（U+202A–U+202E、U+2066–U+2069）。
3. 跳脫五個字元 `& < > " '`。
4. 跑 Markdown regex（fence／inline code／粗體／清單／標題／連結；regex 保持線性，不用巢狀量詞）。
5. 連結／圖片 URL 去控制字元與空白、轉小寫後測 `^(https?|mailto):`，不符者整個降級成純文字。

**預覽 iframe 建立順序**：`createElement` → 設 `sandbox=""` → 設 `referrerpolicy="no-referrer"` → `el.srcdoc = str`（**property，不拼屬性字串**）→ 才 append。固定 max-height + scroll。UI 上要標示「外部資源已封鎖」（繼承的 `img-src` 會打掉預覽內所有外部圖片，否則看起來像壞掉）。

**送出介面：照抄前景 broker 的輸入行語法，不另創慣例。**

| 輸入 | 行為 | 對應現況 |
|---|---|---|
| `<member> <message>` / `@member <message>` | 送給該成員 | broker.js:516 起的 `rl.on('line')` |
| `all <message>` | 廣播 | 同上 |
| `/who` | 列出在線成員 | 前端已有側欄，仍保留指令 |
| `/stop`、`/compact`、`/usage`、`/model`、`/plugin`、`/skills` + `<session>` | `POST /command` | `runCommand` |
| 其他 `/` 開頭 | 印出指令說明 | 同 broker.js:512 |

Tab 補全成員名稱（清單來自 `who`），與 PowerShell `msg` 的補全同一個心智模型。
解析放在前端，`POST /send` 與 `POST /command` 收到的是已經拆好的 `{to, text}` / `{name, target}`——**web.js 不要再做一次字串解析**，兩份解析器遲早會分岐。

**其餘 UI**：agent 內容的 bubble 樣式必須與系統訊息明顯不同（防偽裝成 broker 通知）；系統訊息區絕不渲染來源文字；複製鈕複製原始文字並**去掉結尾換行**；超過 N 行自動收合；大型 HTML 的檔案路徑顯示為純文字（`file:` 連結做不到，見討論記錄）。

**渲染器選型**：暫定自寫迷你版（表格會歪）。Phase 2 上線後改用 `marked` 的成本會變高（需容忍未閉合結構），若要換就趁 Phase 1。

### `claude-split.ps1`

1. `Install-ClaudeSplit` 的複製清單加 `web.js`、`web.html`。
2. 新增 `Start-ClaudeWeb`：比照 `Start-ClaudeBroker` 從 config 解析路徑（`Join-Path (Split-Path $cfg.broker) 'web.js'`），port 佔用就拒開，`Start-Process node`。
3. **不動** `Invoke-ClaudeWithProfile` 與 sessions.json 那條鏈。

### `install.ps1`

`Copy-Tools $dest @('msg-bus-skill\SKILL.md', 'msg.js', 'broker.js')`（claude skill 那行）加上 `web.js`、`web.html`；**codex / gemini 那行不加**（前端是人用的，agent 不需要）。
ponytail 取捨：skill 目錄多一個 agent 用不到的檔案，換來「web.js 永遠在 broker.js 隔壁」這條單一解析規則。

### `README.md`

協定表新增 `tap`（註冊為事件串流接收端，長連線，不回應）與 `command`（對 split session 注入按鍵，等同 chat mode 的 `/<cmd> <target>`）。使用章節加 `Start-ClaudeWeb`，並註明與前景 broker 並存時同一則訊息會顯示兩次。

### 明確不動

`msg-bus-skill/SKILL.md`、`AGENTS-template.md`。

（`msg.js` 後來還是動了一處，但**與本計畫無關**：`send` 加了 `--file <path>`。實測時發現 PowerShell 把原生程式的參數包進雙引號卻不跳脫裡面的雙引號，手動送含 HTML 的訊息會靜靜掉字元。純 CLI 便利性修正，不涉協定。）
依 CLAUDE.md 的協定改動檢查清單逐項確認過：`tap` 是純新增指令，agent 永遠不會呼叫它（web.js 直接說協定），既有指令的請求／回應格式一字未改，因此 CLI 與兩份 agent 指示文件都不需要同步。

## 驗證

其中 1、4、5、6、7、10、10b、17、18 已寫成 `web-smoke.js`（無框架、純 assert，自己起一組 broker + web 在備用埠上跑）。其餘要人眼看瀏覽器，仍需手動。

1. 背景 broker + `Start-ClaudeWeb`，兩個 agent 互傳（A→B，不經過 user）：訊息出現在網頁上。
2. 重新整理分頁 5 次：feed **沒有**出現 `disconnected, marked offline`，`msg who` 仍看得到 `user`。
3. 同時開兩個分頁：同一則訊息兩邊都出現，不會被隨機分給其中一個。
4. `msg send @all --as alice "hi"`（3 個成員在線）：網頁 feed 只出現**一次**。
5. 連續送 210 則後開新分頁：只補到最近 200 筆，最舊的已被丟掉。
6. agent `recv` 收到訊息 → 網頁出現打字中指示器；它 `send` 後指示器消失（驗證 `setThinking` 解限，此項在**背景** broker 下測）。
7. `join` 與 disconnected 事件在 feed 顯示為乾淨文字，無 `[36m` 之類殘留。
8. XSS 三連：送 `<img src=x onerror=alert(1)>` → 顯示為文字；送 `[x](javascript:alert(1))` → 純文字不可點；` ```html ` fence 內含 `<script>alert(1)</script>` → 預覽 iframe 內不執行。
9. DevTools console 無 CSP violation，且預覽 iframe 確實渲染得出來（不行就補 `frame-src 'self'`）。
10. CSRF：從任意外部網頁的 console 跑 `fetch('http://127.0.0.1:8788/send',{method:'POST',mode:'no-cors',body:'x'})` → 訊息**沒有**送出；`curl -H "Host: evil.com" http://127.0.0.1:8788/send` → 403。**同樣兩項對 `/command` 各測一次**（它會送按鍵進終端機視窗，賭注比 `/send` 大）。
10b. `POST /command` 帶不在 `COMMANDS` 白名單裡的 `name`（例如 `constructor`、`__proto__`）→ 拒絕，不得走進 `injectKeys`。
11. 複製鈕複製多行 code fence，貼進 PowerShell：最後一行**不會**自動執行。
12. 關掉 broker：網頁顯示離線；重開 broker：自動重連並繼續收訊息。
13. 前景 `Start-ClaudeBroker` 與前端同時開：同一則訊息在終端機與網頁**各出現一次**；從任一邊送出，另一邊都看得到；兩邊的 `/stop` 都能打斷同一個 agent。
14. **tap 重連**：不重啟 broker 的情況下切斷 web.js 的 tap 連線（防火牆或直接 kill 該 socket）→ 重連後畫面上的歷史訊息**沒有**變成兩份。
15. **ReDoS**：送一則 100KB 的單行訊息（大量 `*` 與 `` ` `` 交錯）→ 畫面不卡死，渲染在一秒內完成。
16. **bidi**：送一則含 U+202E 的訊息 → 顯示順序正常，不會偽裝成別人的發言。
17. **保活**：前端開著閒置 15 分鐘（> TTL 600 秒）→ 期間任何時候 `msg who` 都看得到 `user`。
18. **thinking 初始狀態**：某個 agent 正在忙時才開瀏覽器 → 靠 `ready` 帶過來的狀態，指示器立刻正確，不必等下一次狀態變化。
19. **session 指令**：網頁輸入 `/stop <session>` → 該 split session 被 Esc 打斷、指示器清掉、feed 出現「Esc sent」；`/compact <session>` → 對方視窗真的收到指令。目標不存在或 ambiguous 時，錯誤訊息出現在網頁 feed（走 tap 的 log 事件），不是只印在 broker 視窗。

## 不做（YAGNI）

WebSocket、React、build step、訊息編輯與刪除、多使用者、驗證機制（四道防線只在 loopback 前提下成立，要跨機器就得換成 token / mTLS）。
