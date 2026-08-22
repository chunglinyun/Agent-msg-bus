# 讓終端機的 claude session 也能被 session 指令定址

狀態：**修訂版 7，待核可**。
相關：`docs/session-registry-busname-plan.md`（登錄檔格式）、`docs/msg-native-cmd-plan.md`（按鍵注入）、`docs/msg-interrupt-plan.md`（桌面應用程式唯一可行的替代路徑）。

> 六版修訂只留下兩個結論（過程在 git log）：
> - **不能在 `join` 時自動登錄。** 爬祖先鏈與 `GetConsoleWindow()` 都實測失敗，只剩 `GetForegroundWindow()`——而 agent 呼叫 `join` 的那一刻前景視窗可能是任何東西。詳見下一節。
> - **終端機條目的身分鍵是 `hwnd`，不是 pid。** 前景視窗的 owner pid 是 `WindowsTerminal.exe`，多視窗共用，拿它去重與判活兩件事都會壞。詳見 C。

## 問題

`/stop`、`/compact`、`/usage`、`/model`、`/plugin`、`/skills` 六個指令查的是 `sessions.json`，而那個檔**只有 `claude-work` / `claude-personal` 兩個 launcher 會寫**。用 `Install-MsgBus`（skill-only）或 `install.ps1` 的人，`.claude-split` 目錄根本不存在，六個指令**百分之百**回同一句 `no registered session`。

過去這個缺口藏在前景 broker 的聊天視窗裡。**Web 前端把它攤開了**：placeholder 寫著 `/stop <session>`，打一個 `/` 就跳出六個指令的選單——對這些使用者來說那是一份全都不能用的清單。

**而且缺的不只是登錄。** `injectKeys()` 用 `path.join(__dirname, 'sendkeys.ps1')` 找注入腳本，但那個檔只有 `Install-ClaudeSplit` 會複製（`claude-split.ps1` 的檔案清單）；`Install-MsgBus` 只複製 `SKILL.md` + `msg.js` + `broker.js`，`install.ps1` 的 skill 分支只多了 `web.js`/`web.html`。所以就算登錄百分之百正確，這群人按下 `/stop foo` 也只是把 `no registered session` 換成 `failed: 找不到檔案`。**這是兩個獨立的缺口。**（`web.js`/`web.html` 有同一類漏檔——`Install-MsgBus` 與 `install.ps1` 的 other 分支都沒複製，那些人的 `Start-ClaudeWeb` 起不來。同樣是清單少東西，但與定址無關，一行 fix 自己走，不進本計畫。）

## 取得視窗的三條路，兩條死

按鍵注入需要一個**聚焦得了的、螢幕上的**視窗 handle。實測（2026-08-22，Windows 11 + Windows Terminal）：

| 方式 | 結果 |
|---|---|
| 爬祖先鏈找 `MainWindowHandle` | ❌ 主控台程式的 `MainWindowHandle` 恆為 0；`conhost.exe` 是**子行程**不是祖先；`WindowsTerminal.exe` 也**不在**祖先鏈上（WT 以 handoff 方式生 shell，實測 shell 的 parent 是 `explorer.exe`） |
| `GetConsoleWindow()` | ❌ ConPTY 下回傳 `class=PseudoConsoleWindow`：存在、`IsWindowVisible` 為真、owner 是 shell 本身，但**不是螢幕上那個視窗**。`sendkeys.ps1` 實測回 `could not focus target window` |
| `GetForegroundWindow()` | ✅ 回傳 `class=CASCADIA_HOSTING_WINDOW_CLASS`、owner=`WindowsTerminal` —— 真正、聚焦得了的視窗 |

split launcher 之所以一直能用，正是靠第三個：**它在建立視窗的那一瞬間呼叫**，當下該視窗必然是前景。

一般 session 沒有這個瞬間。agent 呼叫 `join` 時，前景視窗可能是使用者的瀏覽器——**在 `join` 自動抓前景視窗會靜靜登錄一個錯的 handle，之後 `/stop` 就往使用者當下在看的任何視窗送 Esc。那比不能用更糟。**

### 桌面應用程式：本質上做不到

實測：桌面應用程式裡的 session `GetConsoleWindow()` 回 0（根本沒有主控台）；整條祖先鏈唯一的視窗是 app 本體的，而那**一個視窗承載多個 session**（實測同時 3 個），往它送 Esc 打中的是當下有焦點的分頁，可能是別的 project。

## 設計

五件事：**補齊安裝的檔案**、**`msg register` 取得視窗**、**條目以 hwnd 為身分**、**`claude` 包裝函式自動登錄**、**登錄檔位置跟著安裝走**。

### A. 安裝要帶 `sendkeys.ps1`

`Install-MsgBus` 與 `install.ps1`（**兩個分支都要**）的複製清單加上 `sendkeys.ps1`。broker 只會在自己 `__dirname` 旁找注入腳本，所以**每一份可能被當成 broker 跑的 broker.js，旁邊都要有一份 sendkeys.ps1**。只加這一個檔——`web.js`/`web.html` 的漏列是另一件事（見「問題」）。

這一條與登錄無關，可以先獨立合入。

### B. `msg register <busname>`，由人在目標視窗裡執行一次

（常態路徑是 D 的 `claude` 包裝函式，這一條是給沒有它的情況：只跑過 `install.ps1` 沒 source 過 `claude-split.ps1`、或 session 已經跑起來才想補登錄。）

```powershell
msg register termtest
```

（`msg` 函式來自 `claude-split.ps1`，跟哪個安裝器無關——沒 source 過那個檔就打完整路徑
`node "$HOME\.claude\skills\claude-msg\msg.js" register termtest`。）

按下 Enter 的那一刻，該終端機視窗**必然是前景**——這就重建了 launcher 擁有的那個瞬間。`GetForegroundWindow()` 拿到的就是正確的 handle。

**流程定案。** bus 名是 agent 依 SKILL.md 自己挑的，人事先不知道；而 claude 一跑起來就佔住整個視窗，沒有 shell 提示字元可以打 `register`。所以血統唯一乾淨的順序是**由人先定名**：

1. 在該終端機視窗的 shell 提示字元下跑 `... msg.js register <name>`。
2. 同一個視窗跑 `claude`。
3. 告訴 agent「join as `<name>`」——名字由人給，蓋過 SKILL.md 的自動命名。

**為什麼不直接用既有的 `Register-ClaudeSplitSession`。** 它已經在做 `GetForegroundWindow()` + 寫檔，從 shell 提示字元跑起來甚至更準（它記的 `$PID` 是那個視窗的 PowerShell，隨視窗一起死，pid 判活反而成立）。不用它的理由只有一個，但夠硬：**它住在 `claude-split.ps1`，而本計畫的目標族群正是沒有那個檔的 `install.ps1` 使用者**。維持單一路徑（`msg register`）比讓兩群人記兩套指令好。

備援路徑：已經跑起來、名字已經由 agent 挑好的 session，可以由**人明講**「跑 `node <path>/msg.js register <你的名字>`」讓 agent 用自己的 Bash 執行。此時抓到的是**當下的前景視窗**——使用者必須正看著那個視窗，切走就會登錄錯的視窗。這是給人的逃生門，不寫進 SKILL.md，agent 不會自己做。

### C. 終端機條目以 `hwnd` 為身分鍵，不是 pid

直覺的做法是沿用 `pid` 去重與判活。launcher 送的 pid 是 launcher 自己的 PowerShell 行程（每個 session 唯一，所以現在能用）；但 `register` 送的是**前景視窗的 owner pid = `WindowsTerminal.exe`，多個視窗共用同一個行程**。後果有二：

- 登錄第二個終端機視窗時，`x.pid !== req.pid` 會**把第一個視窗的條目刪掉**——一台機器同時只能有一個終端機 session 被定址，而多 session 正是這個 repo 的核心用途。
- 視窗關掉後 WT 行程還活著，`pidAlive` 恆真，**死條目永遠不會被清**；HWND 又會被 Windows 回收，舊條目哪天指到別人的視窗，`/stop` 就往那裡送 Esc——正是本文件開頭說「比不能用更糟」的那件事，只是延後發生。

改成：

- **終端機條目以 hwnd 去重**，同一個視窗重複 `register` 就是換名字。副作用要講清楚：同一個視窗裡若已有 **launcher 條目**（`claude-work` 也是記 `GetForegroundWindow()`），`register` 會把它蓋掉——**這是對的**，一個視窗本來就只能可靠地定址一個 session。只有跨視窗才該互不干擾（見驗證 #10）。
- **`pidAlive` 整個刪掉。** 它是分支上那份未提交的改動多出來的第二份清理邏輯：launcher 條目本來就由 `Register-ClaudeSplitSession`（`Get-Process` 過濾）與 `Unregister-ClaudeSplitSession` 負責清，終端機條目又不該以 pid 判活。少一份規則，也順帶消掉「`process.kill(pid,0)` 遇提權行程丟 EPERM 而誤刪」這個坑。
- **死條目由注入時的失敗回收**：`sendkeys.ps1` 開頭就有 `IsWindow`，讓它在那個分支 `exit 2`，broker 收到結束碼 2 就把該條目刪掉。（不比對英文錯誤字串——那會把 broker 綁在腳本的訊息措辭上。）
- owner pid 照存，唯一的消費者是 `claude-split.ps1` 的 `Get-Process` 過濾：WT 還活著就保留這些條目，全部終端機關光才一起清掉。（沒有 pid 那個過濾會把條目當死的刪掉。）

刪掉 `pidAlive` 不是純粹的退步：結束碼 2 的回收**不分條目種類**，所以 `/stop` 打到一個視窗已經消失的 **split 條目**時同樣會被清掉——以前那種條目只有下一次跑 launcher（或正常結束時的 `Unregister`）才清得掉。

### D. `claude` 包裝函式：自動登錄、自動解除

`msg register` 是逃生門，不該是常態——人會忘記，忘記就是靜靜地沒有登錄。但**唯一能自動抓對視窗的時機是啟動那一刻**（見上面那張表），而 launcher 早就在那個時機了。所以：把 `Invoke-ClaudeWithProfile` 的「假 home」變成選配，多一個在**真 home** 跑的版本，包成 `claude` 函式。

- 不帶 `-ProfileName` → 不動 `USERPROFILE`／`PATH`／`CLAUDE_MSG_NAME`／`DISABLE_AUTOUPDATER`，就是原本的 `claude`，只多了登錄與解除。
- 登錄用 `Register-ClaudeSplitSession -MsgName "claude" -FallbackName $null`：`claude` 只是 join 前的佔位名，`profile` 留空（理由同 C：那個 fallback 對終端機條目只會回 ambiguous）。
- 名字照舊由 `CLAUDE_SPLIT_SESSION_PID` + `msg join` 改寫成 bus 名——**這條路已經在跑，不必新增機制**。
- 離開時 `finally` 呼叫 `Unregister-ClaudeSplitSession`，Ctrl+C 結束也會走到。
- pid 變回**那個視窗的 PowerShell**（隨視窗死），所以 `Get-Process` 判活對這種條目重新成立，不必倚賴結束碼 2。
- `claude -p ...` 這種一次性呼叫**不登錄**：它不擁有那個視窗，登錄只會替別人的視窗多一筆條目。

順手修掉兩個既有缺陷：

- 三個 wrapper 都改用 `-ClaudeArgs $args`（不再 `@args` 潑灑）。實測 `claude-work -p hi` 現在會炸在 `parameter 'ProfileName' is specified more than once`，而 `claude -p hi` 更糟——`hi` 會被吃進 `-ProfileName`。
- `Register-ClaudeSplitSession` 的過濾條件加上 hwnd：同一個視窗只留一筆條目，與 C 的規則對齊（兩個寫入者用同一條規則）。

### E. 登錄檔的位置跟著安裝走

原本 `sessions.json` 一律寫在 `~\.claude-split\`——那是 split 的目錄，skill-only 安裝根本沒有它。實測（`claude` 一跑就爆）：`Set-Content : 找不到路徑 '...\.claude-split\sessions.json' 的一部分`。補一個 `mkdir` 會讓每個 skill 使用者的家目錄多一個他永遠用不到的 `.claude-split`，那是把症狀蓋掉。

改成**由安裝位置決定**：登錄檔放在「擁有這個 broker 的那個安裝的家目錄」，兩邊用同一條規則推——**從安裝好的那份副本往上找，第一個名字以 `.` 開頭的祖先目錄**。

| 安裝方式 | broker/msg.js 副本 | `sessions.json` |
|---|---|---|
| `Install-MsgBus`／`install.ps1`（claude） | `~\.claude\skills\claude-msg\` | `~\.claude\` |
| `install.ps1`（codex／gemini／other） | `~\.codex\claude-msg\` … | `~\.codex\` … |
| `Install-ClaudeSplit` | `~\.claude-split\bin\` | `~\.claude-split\`（與現況相同） |
| 直接從 clone 跑 broker（開發） | repo 根目錄 | repo 根目錄（進 `.gitignore`） |

好處不只是「不亂建目錄」：broker.js 那段 `REAL_HOME` → `.claude-msgbus.json` → `cfg.base` 的推導**整段刪掉**（8 行變 1 行），因為 `__dirname` 已經知道答案；PowerShell 端多一個 `Get-ClaudeMsgSessionsFile`，兩個寫入者從此看同一條規則。既有 split 安裝的路徑沒有變，不需要搬檔案。

覆蓋範圍：

| 使用方式 | 六個指令 | 機制 |
|---|---|---|
| `claude-work` / `claude-personal`（split） | ✅ 現況已可用 | launcher 自動登錄 |
| 有 source `claude-split.ps1` 的終端機跑 `claude` | ✅ **自動** | D 的包裝函式，啟動登錄、離開解除 |
| 沒 source（只跑過 `install.ps1`）或事後才想補 | ✅ 人手動 `register` 一次 | B，逃生門 |
| Claude 桌面應用程式 | ❌ **本質做不到** | 改用 `docs/msg-interrupt-plan.md` 的合作式中斷 |

## 逐檔改動

### `claude-split.ps1`（6 處）

1. `Install-MsgBus` 的複製清單 `SKILL.md / msg.js / broker.js` 加上 `sendkeys.ps1`。（`Install-ClaudeSplit` 那份已經有，不動。兩個假 home 也會多拿一份副本，多餘但無害——不為此多開一個分支。）
2. `msg` 函式的 ArgumentCompleter 硬寫著子指令清單，加 `register`，否則沒有 Tab 補全。
3. `Register-ClaudeSplitSession` 加 `-FallbackName`（預設 `$MsgName`，寫進 `profile`），過濾條件加 hwnd 去重。`Unregister-ClaudeSplitSession` **不動**——刪掉 broker 的 `pidAlive` 之後，它們是 launcher 條目唯一的常態清理者，這是刻意的。
4. `Invoke-ClaudeWithProfile` 的 `-ProfileName`／`-MsgName` 改為選配；沒帶就在真 home 跑（見 D），並跳過 `-p`／`--print` 的登錄。
5. 新增 `claude` 函式；三個 wrapper 一律 `-ClaudeArgs $args`。
6. 新增 `Get-ClaudeMsgSessionsFile`（E 的規則），`Register`／`Unregister`／`CLAUDE_SPLIT_SESSIONS_FILE` 三處改用它，不再自己 `Join-Path $Global:ClaudeSplitBase`。

### `install.ps1`（2 行）

- skill 分支的 `Copy-Tools` 清單加 `sendkeys.ps1`。
- 其他 provider（codex/gemini/other）分支的清單同樣加 `sendkeys.ps1`。理由不是「以防萬一」：`$brokerForConfig` 取的是**第一個裝到的 target 目錄**，所以只裝 codex／gemini 的人，設定檔指向的 broker 就是 `~\.codex\claude-msg\broker.js`，那份旁邊沒有腳本就一樣全滅。

### `sendkeys.ps1`（1 行）

`IsWindow` 失敗那個分支改成 `exit 2`（訊息不變）。這是 broker 分辨「視窗已消失」與「聚焦失敗」的唯一依據。

### `broker.js`（約 30 行，**分支上已有未提交的版本，需依 C 修改**）

1. `registerSession(name, req)`：**registry 唯一的 Node 寫入者**（PowerShell launcher 仍會寫，見「已知上限」）。
   - 帶 `sessionPid`（launcher 注入）→ 把該 pid 的條目改名成 bus 名。等同原本 `msg.js` 做的事，換個地方。**不動。**
   - 帶 `hwnd` + `pid` → 去重條件從 `x.pid !== req.pid` **改成 `x.hwnd !== req.hwnd`**；push `{ name, pid, hwnd, startedAt }`，必要時建目錄後寫回。**不寫 `profile`**：那個欄位對終端機條目沒有有用的消費者（`findSession` 的 profile fallback 拿它只會回 ambiguous，broker 自己的補全還會把必定失敗的 `claude` 列成候選）。缺欄位是安全的——`x.profile === target` 對 `undefined` 永遠不成立。
   - **刪掉 `pidAlive` 與那個存活過濾**。
   - 全程 best-effort，失敗絕不能讓呼叫失敗。
2. 新增 `cmd: 'register'`：收 `{name, hwnd, pid}`，呼叫 `registerSession`，回 `{ok}`。（hwnd 是 CLI 自己送出去的，要印在本地印，不用回傳。）
3. `injectKeys` 的失敗回呼：`err.code === 2` 時把該條目從 `sessions.json` 刪掉，並在訊息裡說明視窗已不存在。**這是死條目唯一的清理路徑。** 兩個實作細節不能省：
   - **回呼裡重讀 `sessions.json` 再刪**。`execFile` 的回呼是非同步的，呼叫前讀到的那份 list 期間可能已被 PowerShell 端或另一次 `register` 覆寫。
   - **以 `s.hwnd` 比對刪除，不是 `target`／`name`。** 同名兩筆正是「已知上限」那個死結的場景，照 name 刪會刪錯一筆；hwnd 是這個設計裡唯一的身分鍵，刪除也走它。
   - `err.code` 的型別約定：行程有跑但非 0 時 Node 給的是**數字**（2），`powershell` 找不到時給的是字串（`ENOENT`）。嚴格比數字 `=== 2`，別寫成 `== '2'`。
4. 查無 session 的錯誤訊息重寫（**已改**）：同時點出三種情況——終端機請跑 `msg register`、或用 split launcher、桌面應用程式無法定址。

5. **登錄檔路徑改由 `__dirname` 推導**（見 E）：刪掉 `REAL_HOME`／`SPLIT_BASE`／讀 `.claude-msgbus.json` 那三段，換成 `registryDir(__dirname)` + `SESSIONS_FILE`。`writeSessions` 的 `mkdirSync` 也跟著刪——推出來的一定是既有目錄。

`findSession()` **不動**；`readSessions()` 只換讀取路徑。

### `msg.js`（約 25 行）

1. **移除分支上未提交的 `consoleWindow()`**（用 `GetConsoleWindow`）——已證實拿到的是聚焦不了的偽視窗。
2. **`join` 恢復原樣，只多帶 `sessionPid`**：登錄寫入已搬到 broker，但 join **不再**嘗試自動登錄。
3. **新增 `register <name>` 子指令**：內嵌 PowerShell 呼叫 `GetForegroundWindow()` 取 hwnd 與 owner pid → 送 `{cmd:'register', name, hwnd, pid}` → 印出登錄到哪個 hwnd。
   - `name` **必填**，缺就走 `join` 現成那行 `usage: msg register <name>` 樣板。不去撈 `CLAUDE_MSG_NAME`／`--as`：人在 shell 提示字元下那兩個必然是空的，撈了只是多一條路徑加一個「登錄成 undefined」的坑。
   - 拿不到視窗（非 Windows、沒有 PowerShell、hwnd 為 0）→ 印出為什麼不能登錄，**不要靜默成功**。
   - broker 沒開 → 照既有的連線失敗訊息走，別另外發明一種。
4. **`register` 加進 `KNOWN`**：那個集合決定「第一個參數是子指令還是收訊人」，漏掉就會先對 broker 打一次 `who` 去猜，broker 沒開時直接掉到 usage。
5. **usage 那一行加上 `register`。**

### `README.md`（3 處）

1. 「Native session commands」那節目前標著 `(split only)`，改寫成上面那張覆蓋範圍表，並寫明：`register` 的三步驟流程、「必須在該視窗執行」這個前提、沒 source 過 `claude-split.ps1` 就打 `node <path>\msg.js`、以及 Tab 補全補不出未 join 的名字（見已知上限）。該節末尾的 caveats 段落也在這節裡，一併改寫。
2. **檔案表裡 `sendkeys.ps1` 那一列**同樣寫著 `claude-split only`，要一起改——本計畫的重點正是讓它不再是 split 專屬。（同一張表的 `askpeer.js` 那列確實仍是 split-only，不要動。）
3. **協定表加一列**：`register` | `{cmd,name,hwnd,pid}` | `{ok}`。（CLAUDE.md 要求動協定就要同步這張表。）

### `msg-bus-skill/SKILL.md` + `AGENTS-template.md`

**不動。** `register` 是人做的事，不是 agent 自己會做的事。

### `web.html`

**不動。**

### 部署注意

`broker.js` 與 `msg.js` 必須一起更新：登錄寫入已從 msg.js 搬到 broker，新舊混搭會讓 split 的「條目改名為 bus 名」沒人做。`sendkeys.ps1` 也必須跟 `broker.js` 同版（結束碼 2 的約定）。重跑 `Install-MsgBus`／`Install-ClaudeSplit`（split 的兩個假 home 各一份）／`install.ps1`——這次重跑還負責把 `sendkeys.ps1` 補進去，**不重跑安裝就只是換一句錯誤訊息**。

## 已知上限（都要寫進 README）

- **`register` 必須由人在目標視窗執行**（從 session 內部自動抓一定會抓到錯的視窗）。免手動的路徑只有 D 的 `claude` 函式，而它要求 source 過 `claude-split.ps1`。
- **Windows Terminal 的分頁共用一個視窗 handle。** 既有限制：一個視窗跑一個 session 才可靠。
- **HWND 會被作業系統回收。** 條目只在注入時被 `IsWindow` 判定失效才清掉；理論上仍存在「舊條目指到新視窗」的空窗期。真的要收斂，就在條目裡多存視窗標題並在注入前比對——現在不做。
- **終端機條目沒有 `profile`**，所以 profile fallback（`/stop work`）只對 split 有效，對終端機 session 只能用名字。刻意如此。
- **Tab 補全補不出「已 register、還沒 join」的名字**：web 前端補的是 roster（`who`），broker 聊天視窗補的是 `sessions.json` 的 name＋profile。前者那段空窗補不出來，**但整個打完仍然可用**——補全只是便利，定址走的是登錄檔。
- **`register <name>` 不檢查名字是否已被別的條目或 roster 佔用。** 兩筆同名的結果是 `findSession` 回 ambiguous，而不是報錯。而且 ambiguous 是在注入**之前**就 return，等於那筆死條目吃不到結束碼 2、自己清不掉。逃生門兩步：先把還活著的那個視窗用新名字 `register` 一次（hwnd 去重會改名），再 `/stop <舊名字>` 讓死條目被回收。
- **`sessions.json` 有兩個寫入者**（broker 與 `claude-split.ps1` 的 Register/Unregister），沒有檔案鎖。同時發生會丟更新；實務上兩者都在人為操作的瞬間才寫。
- **桌面應用程式完全不支援。**
- **Windows 專屬。**

## 驗證

1. **純 skill 安裝的完整鏈路**（最重要）：重跑 `Install-MsgBus` → `~\.claude\skills\claude-msg\` 裡出現 `sendkeys.ps1`。要驗「完全沒裝過 split」的情境，用一個臨時 `$env:USERPROFILE` 指到空目錄再跑一次；**不要去刪 `~\.claude-split`，那裡面是 split 的兩個假 home。**
2. **`install.ps1` 那條路**（本計畫的目標族群）：`.\install.ps1 -DryRun` 的複製清單兩個分支都列得出 `sendkeys.ps1`；實跑後 `$brokerForConfig` 指到的那個目錄（只裝 codex 時是 `~\.codex\claude-msg\`）旁邊真的有 `sendkeys.ps1`。
3. 終端機視窗跑 `register termtest` → `sessions.json` 出現一筆 `hwnd` 非 0、**沒有 `profile`** 的條目；原本沒有 `.claude-split` 目錄的環境上，目錄被建出來。
4. **決定性測試**：讓那個視窗停在 `Read-Host`，從 bus 送 `/compact termtest` → 視窗**真的收到 `/compact` 文字加 Enter**。（涵蓋 `/stop`：同一條注入路徑，只差送出去的鍵。）
5. **多視窗**：開兩個終端機視窗各 `register a` / `register b` → `sessions.json` **兩筆都在**；`/stop a`、`/stop b` 各自打中正確的視窗。
6. 同一視窗重複 `register`（換個名字）→ 條目不重複，名字被更新。
7. 關掉視窗後 `/stop <該名字>` → broker 回報視窗已不存在（`sendkeys.ps1` 結束碼 2），**並且該條目從 `sessions.json` 消失**；再送一次是乾淨的 `no registered session`，不是重複噴同一個錯。
8. `register` 之後把視窗**遮住但不關掉**再 `/stop` → 仍然成功（結束碼 2 只在視窗真的消失時出現，不能誤刪還活著的條目）。
9. 桌面應用程式裡跑 `register` → 明確告知無法登錄，`sessions.json` 沒有新條目。
10. **回歸**：split session 的條目仍在 `join` 後改名為 bus 名（改由 broker 執行），`/stop <busname>` 行為與現在相同；終端機條目存在時，**在另一個視窗**再開一個 `claude-work`，兩邊條目互不刪除（`Register-ClaudeSplitSession` 的 `Get-Process` 過濾不會誤殺 hwnd 條目，因為 WT 行程活著）。「不同視窗」是前提：同一個視窗兩者本來就該互相蓋掉（見 C）。
11. `msg register` 走 Tab 補全補得出來；`msg`（無參數）的 usage 列得出 `register`；不給名字時報 usage 而不是登錄成空名字。
12. 非 Windows：`register` 明確報告不支援，`join` 不受影響。
13. **D 的自動路徑**：source 過 `claude-split.ps1` 的視窗跑 `claude` → `sessions.json` 立刻出現一筆 `name: "claude"`、pid 是**該視窗 PowerShell** 的條目；agent join 之後那筆改名成 bus 名；`/stop <bus 名>` 打中該視窗；**離開 claude 後條目消失**。
14. `claude -p "hi"` → 不留任何條目（也不會動到同一視窗既有的條目）。
15. **登錄檔位置**（E）：skill-only 安裝跑 `claude` → 條目出現在 `~\.claude\sessions.json`，且**沒有生出 `~\.claude-split`**；broker 從 `~\.claude\skills\claude-msgroker.js` 起來時讀寫的是同一個檔。split 安裝的位置與現況相同。
16. `claude-work -p "hi"` 與 `claude --resume` 都能把參數原樣傳給 claude（`-ClaudeArgs $args` 之前，前者直接炸、後者會被 `-ProfileName` 吃掉）。

## 不做（YAGNI）

**在 `join` 時自動登錄**（會抓到錯的視窗，比不做更糟）、背景 reaper、`sessions.json` 檔案鎖、視窗標題比對防 HWND 回收、非 Windows 支援、`sessions.json` 的檔案格式或檔名（位置改了，格式沒動）、為桌面應用程式另找注入路徑、順手移除已無人讀取的 `CLAUDE_SPLIT_SESSIONS_FILE`（清理是另一件事）、`register` 從 `CLAUDE_MSG_NAME`／`--as` 推名字（人在 shell 提示字元下那兩個是空的）、把 `web.js`/`web.html` 補進 `Install-MsgBus` 與 `install.ps1` 的 other 分支（真的漏了，但那是另一行 fix）。
