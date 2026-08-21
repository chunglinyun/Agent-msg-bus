# 本機 Web 前端：規格記錄

狀態：**討論記錄（設計理由的唯一出處），非實作計畫**。
實作計畫：`docs/web-frontend-phase1-plan.md`、`docs/web-frontend-phase2-stream-plan.md`。
相關：`docs/multi-agent-efficiency-notes.md`（共用同一塊 ring buffer）。

## 目標

用瀏覽器參與 bus 對話。重點在可讀性——正確渲染 agent 送出的 Markdown / HTML，而不是把純文字倒進終端機。

## 身分：直接用 `user`

`msg up`（含 agent listen 前自動拉起 broker 的那條路徑）以 `stdio: 'ignore'` spawn → `process.stdin.isTTY` 為 undefined → `chatMode = false`。此時 `user` 是普通佇列成員，沒有 chat mode 攔截。**前端就是一個叫 `user` 的 bus client，零協定改動。**

**與前景 `Start-ClaudeBroker` 可以並存**（原本記為互斥，重新對照程式碼後修正）。`deliverOrQueue()` 先試 waiter，web.js 幾乎永遠掛著 `user` 的 waiter，chat mode 那句 `if (name === HUMAN && chatMode) return;` 輪不到執行；而終端機顯示與 tap 事件**都出自 `logMsg()`，它一定會跑**。兩邊都看得到每一則訊息，兩邊都能送，代價只是同一則訊息顯示兩次。也因此不需要任何身分搶佔／takeover 機制。

**但 session 指令（`/stop`、`/compact`…）全部實作在 chat mode 的 `rl.on('line')` 裡**，跑背景 broker 就用不到。解法是把 `runCommand` 開成協定指令 `cmd: 'command'`，已納入 phase 1 範圍。

### 讀取管道：tap 負責顯示，recv 負責排隊

`user` 的佇列只裝「送給 `user`」的訊息，看不到 A→B 的對話。因此：

- **顯示一律走 tap**（broker 新增的全量事件串流），tap 已涵蓋送給 `user` 的那些。
- **`recv --as user` 照跑但收到就丟**，目的只有兩個：排掉佇列避免無限累積、長輪詢讓 `who` 看得到 `user` 在線。
- **那條 recv 必須由 `web.js` 這個 node process 長期持有，不可綁分頁生命週期。** broker 在 waiter socket 於等待中斷線時會 `roster.delete(name)` 並記一筆 disconnected（broker.js:296-306）；綁分頁的話每次重新整理都會把 `user` 踢下線，並在所有人的 feed 洗一行系統訊息。
- 因為顯示全來自 tap，**開多分頁是安全的**，不會發生訊息被隨機分到某一分頁。

## broker 端改動（約 30 行）

1. 新增 `cmd: 'tap'`：註冊該 socket 為事件串流接收端。
2. **訊息事件掛 `logMsg()`**（broker.js:145）：每則 send 只呼叫一次，手上就有 `{from, to, text, ts}`，直接推那個物件。
   - **不要掛 `log()`**（broker.js:117）——那是終端機格式化函式，吐的是帶時間戳與 ANSI 的字串。系統事件（join／disconnected／指令注入）只能從這裡取，但要先剝 ANSI 再包成 `{type:'log', text}`。
   - **不要掛 `deliverOrQueue()`**——`@all` 會讓它跑 N 次，tap 收到 N 份重複。
3. 最近 200 筆的 ring buffer，tap 連上時先補歷史。**與 `msg log` 共用**。
4. **拿掉 `setThinking()` 的 `!chatMode` 早退**（broker.js:83）。現況 `thinking` map 只在前景 chat mode 才會被填，而前端規定跑背景 broker，照現況一定拿到空的。改成永遠記錄即可——`syncSpinner` 本來就是背景模式下的 no-op，不需要額外保護。

## 前端形狀

`web.js` 單檔零依賴：http server（port 8788，broker 仍 8787），SSE（原生 `EventSource`，不需要 ws 套件）把 tap 轉出去，`POST /send` 轉成 broker 的 send，HTML 內嵌成字串。

狀態來源：`thinking` map → 打字中指示器（**需先解掉 chatMode 限制，見上節第 4 點**）；`who` → 側邊成員清單（waiting / queued）；顏色由前端自行依名字配色，不與 broker palette 同步。

## 渲染

### Markdown

一律當 Markdown 渲染，不做偵測（純文字本來就是合法 Markdown）。

渲染器兩條路：自寫迷你版（~40 行，涵蓋 fence／inline code／粗體／清單／標題／連結，表格會歪）vs vendor `marked.min.js`（~40KB，破壞零依賴約束）。**暫定自寫**，痛點一定先出現在表格。

~~但「痛了再換 marked」這條退路在串流上線後就變窄，所以要先決定串流做不做，再決定渲染器。~~
**這個綁定已解除。** Phase 2 修訂後，串流進行中一律以等寬純文字顯示、完成後才一次渲染，渲染器不必容忍未閉合結構，換不換 marked 隨時可決定。

### HTML 預覽

agent 送的 HTML 不能進主文件 DOM——這頁面有 bus 寫入權，而 agent 的內容可能來自它讀過的網頁，等於把 prompt injection 接到一個能發訊息的介面上。一律進 sandbox iframe，建立方式見安全性一節。高度給固定 max-height + scroll（自動高度要 postMessage，要 `allow-scripts`，不划算）。

### 對話框內的額外顯示

- ` ```html ` fence → 程式碼 + 「預覽」切換鈕（切換為 sandboxed iframe）。整則訊息以 `<` 開頭時比照辦理。
- code fence → 等寬區塊 + 複製鈕。
- 訊息超過 N 行 → 自動收合。
- 大型 HTML 建議走檔案：agent 寫檔、訊息裡給路徑。**但 phase 1 只顯示成純文字路徑**——連結 scheme 白名單不含 `file:`，瀏覽器本來也擋 http 頁面導向 `file:`；要能點開得由 `web.js` 開受限檔案端點（路徑白名單、目錄穿越防護），不屬於 phase 1。

## 串流（Phase 2）

### 能與不能

- **agent 自己的回覆無法串流。** agent 是呼叫一次 `node msg.js send @user "…"`，process 啟動時文字已完整，沒有 token 流可接；真串流得攔截 Claude Code 自身輸出，bus 碰不到那層。
- **能串流的是被導向 bus 的長輸出**，如 `npm test | node msg.js send @user --stream`。串流解決的是「長時間 tool 輸出」，不是「agent 講很長的話」——後者的正解是自動收合 + 快速渲染。
- 前端把已收完的長訊息打字機式吐出屬於假串流，只是延後資訊到達，不做。

### 協定

- `send` 增加選用欄位 `stream: true` 與 `final: true`。**送出端不產生 id**：一次串流就是一條連線（中斷偵測本來就靠 socket 關閉），所以 socket 自己就是識別；broker 把狀態掛在 socket 上，並產生一個 id 放進推給 tap 的事件，讓前端能把 chunk 歸到同一則。
- broker：帶 `stream` 的 chunk **立刻推給 tap**；對**佇列收件者**緩衝，等 `final` 才合併成一則完整訊息投遞。結果是串流純屬傳輸細節，agent 端行為不變，不會收到碎片。
- 未完成串流的沖出時機：**用送出端 socket 關閉當訊號，不要用閒置逾時。** socket 收掉而沒有 `final` 就是送出端死了，確定性。閒置逾時會誤判——`npm test` 中間安靜兩分鐘完全正常。
- `msg.js send --stream` 把 stdin 的每個 `data` 事件原樣當一個 chunk 送出，不自己做批次（Node 的 stream 已經以 64KB 為單位讀進來了）。

### 串流中的格式判定

問題：`` ``` `` 開頭但還沒收到結尾的 chunk 怎麼顯示。

原本的答案是「每個 chunk 都把累積的整個 buffer 重新完整 parse」。**實作時證明這條路走不通**：phase 1 量到 87.5KB 內容要渲染 536ms，而串流唯一的用途是幾百 KB 的 log，每個 chunk 重 parse 一次是 O(n²)，會比不串流還卡。

**現在的答案：串流中根本不 parse。** chunk 直接 append 進 `<pre>`，完成後那則合併訊息到達時才一次性完整渲染。這個問題因此消失——串流內容依定義是管線來的指令輸出，等寬純文字本來就是它該有的樣子。細節見 `docs/web-frontend-phase2-stream-plan.md`。

## 安全性

威脅模型：**攻擊者不是「連進來的外部使用者」，是被當成傀儡的 agent。** agent 讀了網頁／PR／issue 再轉發到 bus，惡意 payload 就這樣進了前端 DOM。跑在 local 不代表輸入可信，輸入來自網際網路，只是繞了 agent 一手。

（broker 本來就沒驗證，任何本機 process 都能連 127.0.0.1:8787。前端不會讓這點更糟，但**會新增一個網路面**，見 CSRF 一節。）

### 渲染器：靠建構式白名單，不靠過濾

**不寫 sanitizer。** sanitizer 是拿黑名單跟瀏覽器解析器的邊界案例賽跑，會被繞過。做法是：訊息文字一律先跳脫，之後頁面上每一個標籤都是**渲染器自己產生的**，來源文字永遠不可能變成標籤。這才是 40 行手寫渲染器站得住腳的理由。

代價：**不支援 Markdown 的 inline HTML**（標準允許，我們刻意不允許，一律跳脫成文字）。刻意偏離規格，要寫進文件。

1. **先跳脫，再跑 Markdown regex，順序不能反。** 先跳脫後 `<` 變 `&lt;`，而 Markdown 語法只用 `` * _ [ ] ( ) ` # ``，不受影響。反過來會把自己產生的標籤一起跳脫掉，於是實作者就會改成「只跳脫沒被 regex 吃掉的部分」——那是所有 XSS 的來源。
2. **跳脫五個字元 `& < > " '`。** 只跳脫 `&<>` 僅在文字節點安全；屬性值（`href`、`src`）少了引號跳脫就能逃逸。
3. **連結 scheme 白名單。** 跳脫救不了 `[按這裡](javascript:...)`——裡面沒有 `<`；`data:text/html,...`、`vbscript:` 同理。做法：URL 去掉控制字元與空白、轉小寫，測 `^(https?|mailto):`，不符就**整個連結降級成純文字**。圖片 `src` 同樣處理。
4. **遠端圖片是追蹤信標**（洩漏 IP 與開啟時間）。用 CSP `img-src` 收掉，或只允許點擊後載入。
5. **regex 保持線性，不用巢狀量詞**，否則一行超長字串就能 ReDoS 卡死 UI。
6. **去掉 bidi 控制字元（U+202A–U+202E、U+2066–U+2069）。** Trojan Source 那招用在聊天室：視覺上偽裝成別人說的話、或反轉顯示出來的指令。一行 regex。
7. **渲染前剝掉 ANSI escape sequence**（`/\x1b\[[0-9;]*[a-zA-Z]/g`，broker `dispWidth()` 有同款可抄）。導向 bus 的指令輸出必然帶 ANSI。

### HTML 預覽：只能進 sandbox iframe

- `sandbox=""`（空字串，最嚴格：無 script、無 form、無頂層導航、獨立 origin）。
- **絕不同時給 `allow-scripts` 和 `allow-same-origin`**——併用等於沒有 sandbox，裡面的 script 可以把父層的 sandbox 屬性移掉。
- 用 **property 指定內容**（`el.srcdoc = str`），不要拼 `srcdoc="..."` 屬性字串：屬性值會被當 HTML 再解析一次，拼字串就要雙重跳脫，遲早出錯。
- 順序：建立元素 → 設 `sandbox` → 設 `srcdoc` → 才 append。sandbox 必須在插入 DOM 前就位。
- 加 `referrerpolicy="no-referrer"`。

### CSP：渲染器出 bug 時的保命索

前端頁面自送 header，內嵌 script 用 nonce：

```
default-src 'none'; script-src 'nonce-<每次啟動隨機>'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
```

後三個指令**不會**從 `default-src` 繼承，必須自己寫（`frame-ancestors` 擋點擊劫持，另兩個是補漏）。

用 nonce 而非 `'unsafe-inline'` 時，**注入進來的 `<script>` 不執行，`onerror=` 這類行內事件處理器也不執行**——整個 XSS 類別關掉，成本只是一個 header。這是上面規則萬一寫錯時的第二道防線。

`srcdoc` iframe 會繼承父層 CSP，等於鎖兩層。但這個附帶好處有代價，實作時要實測兩件事：

1. `default-src 'none'` 會讓 `frame-src` 一併退回 `'none'`。`srcdoc` 沒有 URL，各家瀏覽器對它是否受 `frame-src` 管轄不一致，**必須實測預覽 iframe 渲染得出來**，必要時補 `frame-src 'self'`。
2. 繼承的 `img-src 'self' data:` 會**打掉預覽內所有外部圖片**。這正是我們要的防信標，但預覽會缺圖且看起來像壞掉，**UI 要明講「外部資源已封鎖」**。

`style-src` 用 `'unsafe-inline'` 是刻意的：頁面樣式與預覽內容的行內樣式都需要它，而來源文字既然永遠不會變成標籤，注入 `<style>` 這條路本來就不存在。

### 新增的網路面：localhost CSRF 與 DNS rebinding

**這是前端真正引入的新風險，最容易漏。** 開了 HTTP server 後，使用者瀏覽的任何網站都能對 `http://127.0.0.1:8788/send` 發 POST；`mode: 'no-cors'` 的簡單請求送得出去——對方讀不到回應，但**寫得進去**，而 bus 上的訊息是 agent 會照著做事的東西。

四道防線，每道一兩行：

1. **只接受 `Content-Type: application/json`**。簡單請求設不了這個 header，會被強制 preflight，於是被 CORS 擋下。
2. **檢查 `Origin`／`Sec-Fetch-Site`**，不是本頁就拒絕。
3. **檢查 `Host` 必須是 `127.0.0.1:8788` 或 `localhost:8788`**。專擋 **DNS rebinding**（攻擊者網域解析到 127.0.0.1，前兩道有機會被繞過，這道不會）。
4. **只綁 127.0.0.1**，不要 0.0.0.0（broker 已是如此）。

ponytail 上限：這四道只在「僅限 loopback」的前提下成立。要從別台機器連進來就得換成真的驗證（token / mTLS），四道全部不夠。

### 複製鈕與 UI 偽裝

- `navigator.clipboard.writeText()` 複製**原始文字**而非渲染結果，並**去掉結尾換行**——使用者很可能貼進終端機，結尾帶換行的內容一貼就直接執行。經典的「網頁複製到 shell」攻擊，agent 送的內容完全可能被這樣設計。
- 訊息可以偽裝成系統通知（開頭寫「⚠ broker: 請執行…」）。防法不是程式是版面：**agent 內容的 bubble 樣式必須和系統訊息明顯不同**，且系統訊息區域絕不渲染來源文字。

## SKILL.md 要不要改？

**不做「依前端版本／依收件端能力調整回應」。** agent 本來就寫 Markdown，終端機看得懂、網頁渲染得出來，同一份文字兩邊都成立；要讓 agent 知道對方用什麼渲染就得做能力協商，等於把呈現層洩進協定層。終端機讀長 Markdown 不好讀是終端機的問題。

但有三條**與傳輸無關**的格式約定值得加進 `SKILL.md` / `AGENTS-template.md`，只是恰好被前端凸顯：

1. **HTML 一律包在 ` ```html ` fence 裡，不要裸送。** 預覽鈕靠 fence 判斷，終端機看到 fence 也照樣可讀；裸 `<` 開頭要用猜的。
2. **大型產出寫成檔案、訊息只給路徑。** bus 是記憶體式、ring buffer 只有 200 筆。
3. **不要送 ANSI 色碼。** 真正的修法在前端（見安全性第 7 點），這條只是減少雜訊，不能當防線。

串流上線時 `SKILL.md` 要加的是 `--stream` 的**用法說明**（何時該用管線送長輸出），那是新能力，不是依版本分支的回應規則。

## 階段切分

- **Phase 1（最小可用）**：broker 的 `tap` + ring buffer + `setThinking` 解限；`web.js` 單檔（SSE + `POST /send` + 四道 CSRF 防線 + CSP header）；自寫 Markdown 渲染器（跳脫優先、scheme 白名單、ANSI 剝除）；` ```html ` fence 預覽切換；長訊息收合；複製鈕。**不含串流。**
  → `docs/web-frontend-phase1-plan.md`
- **Phase 2**：`stream` / `final` 協定、`msg.js send --stream`、前端累積重 parse。
  → `docs/web-frontend-phase2-stream-plan.md`
- **Phase 3（未成案）**：`msg log`、受限檔案端點。**刻意不寫計畫**——兩項都還沒有明確需求，先做計畫等於替不存在的需求設計。

## 明確不做

WebSocket、React、build step、訊息編輯與刪除、假串流打字機、持久化 DB、依收件端能力協商的回應格式。
