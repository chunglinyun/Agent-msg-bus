# claude-split：兩個「隔離 + 可溝通」的 Claude Code 實例（Windows）

兩件事是正交的，這套把它們合在一起：

- **隔離**：每個實例用假 home（`USERPROFILE`），`~\.claude.json`、`~\.claude\...` 各自獨立，避免 cross-account 污染。（沿用你原本的 launcher 做法。）
- **溝通**：一個共用的 broker（localhost TCP），兩個實例用 `msg` 指令收發訊息。broker 在 OS 層，不受假 home 影響，所以隔離與溝通可以並存。

## 檔案

| 檔案 | 作用 |
|---|---|
| `broker.js` | 訊息匯流排（Node，常駐）。維護每個名字的信箱，`recv` 支援阻塞等待。 |
| `msg.js` | CLI helper。agent 透過 Bash 呼叫來收發。 |
| `msg.cmd` | Windows 包裝，讓你直接打 `msg ...`（PATH 上找得到即可）。 |
| `claude-split.ps1` | PowerShell profile：假 home launcher + 啟動 broker + 身分注入。 |

## 前提

- 已安裝 Node（Claude Code 本來就需要，通常已有）。
- 已安裝 Claude Code，`claude` 在系統 PATH 上。

---

## 安裝（一次）

1. 把整個 `claude-msg-bus` 資料夾放到你想要的位置，例如 `C:\tools\claude-msg-bus`。

2. 開 PowerShell，source 進來並執行安裝（會建立 `~\.claude-split\bin\` 並複製工具、建立兩個假 home）：

   ```powershell
   . "C:\tools\claude-msg-bus\claude-split.ps1"
   Install-ClaudeSplit -SourceDir "C:\tools\claude-msg-bus"
   ```

3. 讓每次開 PowerShell 都自動載入。編輯 profile：

   ```powershell
   notepad $PROFILE
   ```

   在裡面加一行（把上面的 source 那行放進去）：

   ```powershell
   . "C:\tools\claude-msg-bus\claude-split.ps1"
   ```

> 這套用 loopback TCP（`127.0.0.1:8787`）而不是 named pipe：跨平台、Node 內建、對回合制 agent 的阻塞/輪詢最好處理。要改埠號改 `claude-split.ps1` 裡的 `$Global:ClaudeMsgPort`。

---

## 使用（每次）

開 **三個** PowerShell 視窗：

**視窗 1 — broker（開著就好）**
```powershell
Start-ClaudeBroker
```

**視窗 2 — work 實例**
```powershell
claude-work
```

**視窗 3 — personal 實例**
```powershell
claude-personal
```

每個實例裡，agent 可以用這些指令（身分已由 launcher 自動設好）：

```text
msg whoami                     # 我是誰（work / personal）
msg send personal "訊息內容"    # 送給對方
msg send work     "訊息內容"
msg recv                       # 非阻塞：把信箱裡的訊息全拿出來
msg recv --wait 300            # 阻塞：等最多 300 秒，一有訊息立刻返回
msg ping                       # 檢查 broker 活著沒
```

### 為什麼「即時」是這樣運作的

Claude Code 是**回合制**的：agent 只在執行工具的當下才動作，沒辦法被外部訊息打斷。所以近即時的做法是 **blocking recv**——接收方跑 `msg recv --wait 300`，這個指令會 hold 住直到對方 `send`（立刻返回）或逾時。對方一送，你這邊幾乎瞬間拿到。

一來一回的模式：

```text
work:     msg send personal "幫我看 auth 模組有沒有問題"
personal: msg recv --wait 300     ← 立刻收到，去做事
personal: msg send work "看完了，第 42 行有 race condition"
work:     msg recv --wait 300     ← 立刻收到
```

---

## 讓 agent 自動知道怎麼用（建議）

把下面這段放進**每個假 home** 的 `~\.claude\CLAUDE.md`
（即 `~\.claude-split\.claude-work\.claude\CLAUDE.md` 與 `...\.claude-personal\.claude\CLAUDE.md`），
或放進你專案的 `CLAUDE.md`，agent 就會主動使用：

```markdown
## 跟另一個 Claude Code 實例溝通

你是一個有身分的實例。你們共用一個訊息 broker，用 CLI 收發。

**重要：一律用 `node "$CLAUDE_MSG" ...` 呼叫，不要直接打 `msg`。**
因為你的 shell 是 bash，`msg` 會打到 Windows 內建的 `msg.exe`，不是這個工具。
`$CLAUDE_MSG` 環境變數已指向正確的 msg.js，身分（from）也已由環境設好。

- 看自己是誰：`node "$CLAUDE_MSG" whoami`（回 work 或 personal，對方就是另一個）
- 送訊息：`node "$CLAUDE_MSG" send <對方> "內容"`（work 的對方是 personal，反之亦然）
- 等回覆：`node "$CLAUDE_MSG" recv --wait 300`（阻塞到有訊息或逾時；即時協作主要靠這個）
- 看有沒有訊息（不等）：`node "$CLAUDE_MSG" recv`

協作守則：
- 需要對方時，先 send 說清楚要什麼，再 `recv --wait 300` 等回覆。
- 收到請求就處理，完成後 send 回報結果。
- 訊息盡量一則講清楚一件事，方便對方理解。
```

> 為什麼不用短指令 `msg`？Windows 內建 `C:\Windows\system32\msg.exe`，而 Claude Code 的 Bash 工具走 bash，找指令時只自動補 `.exe` 不補 `.cmd`，所以 agent 打 `msg` 一定打到系統的那支。**在 PowerShell 手動操作**時 `msg ...` 沒問題（本 profile 有定義 `msg` function 蓋掉它）；**只有 agent 的 bash** 要改用 `node "$CLAUDE_MSG" ...`。

---

## 疑難排解

- **`msg` 找不到指令**：確認你是用 `claude-work` / `claude-personal` 進去的（它們才會把共用 bin 加到 PATH）。或直接 `node "%USERPROFILE%\.claude-split\bin\msg.js" ...`。
- **`沒有回應（broker 沒開？）`**：broker 視窗沒開或被關了，重跑 `Start-ClaudeBroker`。
- **`port 8787 已被占用`**：broker 已在跑，別再開一個；或換埠號。
- **第一次跑某 profile 會另外下載一份 claude.exe**：因為 home 被改了，這是預期行為，影響不大（沿用你原方案的已知取捨）。
- **想共用其他 CLI 工具狀態（如 glab）**：對該工具的 config 目錄建 symlink 到假 home 對應位置（見你原本筆記；通常需系統管理員或開 Developer Mode）。

## 安全性

broker 只綁 `127.0.0.1`，同機的本機程式才連得到，不對外開放。訊息只存在記憶體，broker 關掉即清空。
