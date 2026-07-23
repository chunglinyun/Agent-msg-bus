# claude-msg-bus 多 session 跨 agent 溝通平台化

## Context

現況是為「固定兩個 Claude session（work/personal）」設計的架構：身分由 launcher 注入環境變數、hook 與 askpeer 寫死二元 peer。目標是演進成一般人可用的溝通平台：**任意數量的 session（不需假 home、不限 Claude Code）都能加入**，人類與 agent 都能用 `@名字` / `@all` 定址，agent 透過 skill 加入時自己取一個「專案＋任務」shortname，做完事後繼續 loop 聽取訊息。

已定決策（與使用者確認）：
- **隔離與溝通全面脫鉤**：溝通平台獨立，claude-split 只剩隔離加值。
- **agent 自己取名**，broker 只防撞名。
- **跨 provider**：CLI 保持純 node 中立，交付 Claude SKILL.md ＋ 通用指示範本（AGENTS.md/GEMINI.md 可貼）。
- **持續聽取用 skill loop `recv --wait`**，不用 Stop hook。
- **hook-recv.js 刪除**，但要先 `git init` ＋ commit 現況再刪（repo 目前不是 git repo）。

探索確認的關鍵事實：broker 核心（queue/路由）本來就名字無關，任意名字免改；broker 無 presence／成員列表／廣播（要新建）；硬編集中在 `hook-recv.js:65`、`askpeer.js:21-24`、`claude-split.ps1:82-83`；`Install-ClaudeSplit` 只複製 broker.js/msg.js/msg.cmd。

## 實作步驟

### 0. git init ＋ commit 現況（使用者要求）

```powershell
git init; git add -A; git commit -m "初始 commit：work/personal 二元架構現況"
```

之後每個階段完成各自 commit；刪 `hook-recv.js` 在獨立 commit。
另依專案慣例把本計畫存一份到 `docs/msg-bus-platform-plan.md`。

### 1. broker.js — roster / join / who / @all（+約 35 行）

新增 presence 資料結構（一個 Map 就夠）：

```js
const roster = new Map(); // name -> lastSeen (ms)
const STALE_MS = Number(process.env.CLAUDE_MSG_STALE_MS || 10 * 60 * 1000);
const touch = (name) => { if (name && name !== '?') roster.set(name, Date.now()); };
const alive = (name) => (Date.now() - (roster.get(name) || 0)) < STALE_MS;
```

- **presence**：三處 `touch()` — `join`（name）、`send`（from）、`recv`（name）。不做 leave/心跳/定期清理；who 與廣播時用 `alive()` 過濾。agent 照 skill loop（wait 540s ≤ TTL 10min）自然保活；session 死掉 10 分鐘後名字自動釋放。
- **`join` cmd**：`{cmd:'join', name}`。拒絕空名／`all`／`@` 開頭；`alive(name)` 為真回 `{ok:false, error:'已被使用'}`，否則 `touch` 並回 `{ok:true, name}`。join 非必要條件（send/recv 照舊可用，向後相容 work/personal），只是防撞名的禮貌動作。
- **`who` cmd**：回 `{ok:true, peers:[{name, lastSeen, waiting, queued}]}`，只列 alive 成員。`waiting` = 有 waiter 正阻塞 recv；`queued` = queue 長度。全是現有資料的一行推導。
- **`@all` 廣播**：`send` 分支特判 `req.to === 'all'`：對 roster 中 alive 且 ≠ sender 的每個成員各跑一次 `deliverToWaiter || getQueue().push`（`msg.to` 保留 `'all'` 讓收端知道是廣播），回 `{ok:true, delivered:N}`。stale 成員不收（不塞死人 queue）。
- **單播黑洞防護**：目標非 alive 時回應多帶 `hint: '"xxx" 未上線，訊息已入列'`，typo 不再石沉大海。

不做：leave、channel/room、持久化、ACK、roster prune（YAGNI）。

### 2. msg.js — --as / @ 語法糖 / join / who / up（+約 30 行）

- **身分優先序**：`--as <name>` ＞ `CLAUDE_MSG_NAME` ＞ `'user'`（人類預設）。agent 每次 Bash 呼叫是新 shell、env 不持久 → skill 教 agent 每次帶 `--as`；split launcher 注入 env 照舊生效；人類裸打 `msg` 就是 `user`。移除 recv 的「未設定 CLAUDE_MSG_NAME 就報錯」（msg.js:50）。
- **`@` 語法糖**：所有 to 參數 strip 前導 `@`（`@all` → `'all'`）；第一參數以 `@` 開頭視同 send：`msg @foo "hi"` ≡ `msg send foo "hi"`。
- **新子指令**：
  - `join <name>` → broker join，失敗 exit 1（agent 據此換名重試）。
  - `who` → 印每行 `name  (等待中|閒置 Ns)  queue:N`。
  - `up` → 先 ping，失敗才 `spawn(process.execPath, [__dirname/broker.js], {detached:true, stdio:'ignore'}).unref()`。顯式啟動而非隱式自動 spawn（避免 split brain 與不可預測行為）；broker.js 與 msg.js 同目錄即可用，配合 self-contained 安裝成立。
- **recv 顯示**：廣播訊息加 `@all ` 前綴；send 印出 broker 回的 `hint`。
- `whoami` 改印解析後身分（含 `user` 預設）。

### 3. msg-bus-skill/SKILL.md — 核心交付（新檔）

repo 只放 `msg-bus-skill/SKILL.md`；安裝時由 `Install-MsgBus` 組成 self-contained skill 目錄（SKILL.md + msg.js + broker.js 三檔複製到 `~\.claude\skills\claude-msg\`）。skill 載入時 Claude Code 注入 Base directory，SKILL.md 指示用「本 skill 目錄下的 msg.js」，**零環境變數依賴**——任何 session 免假 home 即可加入。

frontmatter 沿用 ask-peer-skill 的兩欄格式（name: claude-msg ＋ 長 description 含觸發語：「加入訊息平台」「上線」「聽訊息」「@xxx」「廣播」；一次性委派請用 ask-peer 不要用本 skill）。

body 四節：

1. **上線與取名**：一律 `node "<skill目錄>/msg.js" ...`（不裸打 `msg`，bash 會撞系統 msg.exe）。先 `ping`，失敗跑 `up`，再 `join`。取名規則（少而硬）：小寫英數與 `-`、2 詞 20 字內；第一詞＝當前專案資料夾名（可縮短）、第二詞＝本次任務一個詞（例：`msgbus-refactor`）；撞名加 `-2`/`-3` 重試最多三次再換詞。join 成功後告訴使用者「我以 `<name>` 上線了，可用 @<name> 找我」，之後**每次呼叫都帶 `--as <name>`**（名字記在對話脈絡）。
2. **收發**：`send @對方 --as <me> "..."`；`send @all` 廣播；找不到人先 `who`；出現「未上線已入列」提示要如實回報。收到 `@all` 訊息回覆 sender 不回 all。
3. **聽取 loop**（逐字指示）：完成當前工作後跑 `recv --as <me> --wait 540`，**Bash tool timeout 必須設 600000**（10 分鐘上限，wait 540 留緩衝）。有訊息 → 逐則處理 → send 回 @from → 回去聽；空返回 → 再聽一次；**連續 2 次空（約 18 分鐘）→ 停止聽取並回報使用者**。
4. **停止條件**：使用者叫停或發新指令（使用者優先）、對方表明結束、連續 2 次空 wait。原則：寧可停下來問，不無限 loop 燒 token。

### 4. AGENTS-template.md — 跨 provider 通用範本（新檔，repo 根目錄）

SKILL.md body 的 provider 中立版：msg.js 路徑留 `<你的安裝路徑>` 佔位、wait 秒數註明「依你的 shell 工具上限調整」。使用者自行貼進 Codex 的 AGENTS.md / Gemini 的 GEMINI.md。

### 5. claude-split.ps1 — Install-MsgBus（+約 15 行）

- **`Invoke-ClaudeWithProfile` 不動**：work/personal 只是平台上兩個固定名字成員，env 注入照舊（有 `CLAUDE_MSG_NAME` 時 msg.js fallback 生效），零衝突。
- **新增 `Install-MsgBus`**：`param($SourceDir, $TargetHome=$env:USERPROFILE)`，把 `msg-bus-skill\SKILL.md` + `msg.js` + `broker.js` 複製到 `$TargetHome\.claude\skills\claude-msg\`。這是給一般人（無 split）的唯一安裝步驟。
- **`Install-ClaudeSplit` 末尾追加**：對 `.claude-work`/`.claude-personal` 兩個假 home 各呼叫 `Install-MsgBus -TargetHome <假home>`（split session 看得到的 skills 位置在假 home 底下）。bin 複製清單不動（`Start-ClaudeBroker` 與 PowerShell `msg` function 依賴它）。

### 6. 刪除 hook-recv.js（獨立 commit，在步驟 0 的存檔 commit 之後）

**將刪除的項目（已獲使用者同意，前提是先 git commit 存檔）**：`hook-recv.js` 整個檔案。askpeer.js 與 ask-peer-skill/ 完全不動（屬 split 隔離範疇的同步委派，與平台化正交）。

### 7. 文件

- **README.md 重寫**：結構翻轉為「平台為主、split 為輔」。上半部：平台是什麼、安裝（Install-MsgBus 或手動複製三檔）、人類用法（`msg up` / `msg who` / `msg @name "..."` / `msg @all "..."` / `msg recv`）、agent 用法（指向 skill）、協定速覽（send/recv/ping/join/who 一張表）。刪除現有 96-123 行的二元「對方」範本，改為「Claude 裝 skill；其他 agent 貼 AGENTS-template.md」。下半部 split 內容沿用，語彙改名字制。
- **CLAUDE.md 更新**：架構段補 roster/join/who/@all；部署注意改為兩個複本位置（`~\.claude-split\bin\` 與 `~\.claude\skills\claude-msg\`，改完各自重跑 Install-*）；移除 hook-recv.js 相關描述（含「協定改動要看三個 client」改為兩個）。

## 修改檔案清單

| 檔案 | 動作 |
|---|---|
| `broker.js` | 修改：roster、join、who、@all、未上線 hint |
| `msg.js` | 修改：--as、@ 語法糖、join/who/up 子指令 |
| `msg-bus-skill/SKILL.md` | 新增（核心交付） |
| `AGENTS-template.md` | 新增 |
| `claude-split.ps1` | 修改：Install-MsgBus、Install-ClaudeSplit 追加 |
| `README.md`、`CLAUDE.md` | 重寫／更新 |
| `docs/msg-bus-platform-plan.md` | 新增（本計畫存檔，專案慣例） |
| `hook-recv.js` | **刪除**（先 git 存檔 commit） |
| `askpeer.js`、`ask-peer-skill/`、`msg.cmd` | 不動 |

## 驗證（無測試框架，手動）

前景 `node broker.js` 看 log，多開 PowerShell 視窗：

1. **join 撞名**：`node msg.js join alice` 成功 → 再 join alice 失敗 → `join all` 拒絕。
2. **TTL 回收**：broker 帶 `CLAUDE_MSG_STALE_MS=3000` 重啟，join bob → 等 4 秒 → 再 join bob 成功。
3. **收發與身分**：`send @alice --as bob "hi"` → `recv --as alice` 顯示 `bob: hi`；`send @nobody "x"` 出現未上線提示；裸 `whoami` 印 `user`。
4. **who**：列出 alice/bob/user 含 waiting/queued。
5. **@all 三視窗**：A 阻塞 `recv --as alice --wait 60`、B `join carol` 閒置、C `send @all --as user "大家好"` → A 立即收到（`@all` 前綴）、carol 之後 recv 拿到、sender 自己收不到、回應 `delivered:2`。
6. **msg up**：關 broker → `up` → `ping` 回 OK。
7. **端對端 skill loop**：`Install-MsgBus` → 開普通 claude session（無 split）→「加入訊息平台並持續聽」→ agent 回報名字 → PowerShell `msg @<名字> "回我 pong"` → 幾秒內收到回覆 → 停止傳訊，等兩輪空 wait，agent 應回報停止聽取。
8. **向後相容**：跑一次舊 work/personal 流程（launcher env 注入）確認不受影響。

## 風險點

- **Bash 10 分鐘上限**：agent 忘了把 timeout 設 600000 時預設 120 秒會腰斬 recv（broker 的 socket-close 清理能善後，不會殭屍，但體感常提早返回）。SKILL.md 粗體標示；實測常忘就降級 wait 90 多輪。
- **TTL 假死**：agent 埋頭 >10 分鐘不碰 bus 會漏收 @all、名字可能被搶——已接受的取捨，`who` 的 lastSeen 提供可觀察性。
- **複本 drift**：兩個部署位置（bin、skills），改碼忘重裝是最大的坑，CLAUDE.md 部署段是防線。
- **`msg up` 無 log**：stdio ignore；要看 log 前景跑，ponytail 註解標升級路徑。
