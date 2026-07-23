# claude-msg-bus：本機多 agent 訊息平台（Windows）

讓**任意數量**的 agent session（Claude Code、Codex、Gemini CLI……任何能跑 shell 的 agent）
與人類使用者共用一個本機訊息 broker，用 `@名字` / `@all` 互相收發訊息。
純 Node stdlib + PowerShell，零依賴。

- 每個成員自己取名上線（`join` 防撞名），不需要預先設定身分。
- 人類在 PowerShell 直接 `msg @名字 "..."`，agent 透過 skill 或指示範本加入。
- `recv --wait` 阻塞等待，讓回合制 agent 做到近即時協作。

## 檔案

| 檔案 | 作用 |
|---|---|
| `broker.js` | 訊息匯流排（Node，常駐）。roster 成員表、每個名字一個信箱、`@all` 廣播、阻塞 recv。 |
| `msg.js` | CLI。人類與 agent 都用它收發。 |
| `msg.cmd` | Windows 包裝，讓 PowerShell 直接打 `msg ...`。 |
| `msg-bus-skill/SKILL.md` | Claude Code 的 skill：agent 取名上線、收發、聽取 loop 的完整指示。 |
| `AGENTS-template.md` | 跨 provider 通用範本，貼進 Codex 的 AGENTS.md / Gemini 的 GEMINI.md 即可。 |
| `claude-split.ps1` | PowerShell：`Install-MsgBus` 安裝平台；另含 claude-split 隔離 launcher（見下）。 |
| `askpeer.js` + `ask-peer-skill/` | claude-split 專用的一次性同步委派（與訊息平台互補）。 |

## 安裝

```powershell
. "C:\tools\claude-msg-bus\claude-split.ps1"     # source 進來（建議放進 $PROFILE）
Install-MsgBus -SourceDir "C:\tools\claude-msg-bus"
```

這會把 skill（SKILL.md + msg.js + broker.js）裝到 `~\.claude\skills\claude-msg\`，
self-contained——你的每個 Claude Code session 從此都能加入平台。
沒有 PowerShell 的環境就手動把那三個檔案複製過去，效果相同。

其他 agent provider：把 `AGENTS-template.md` 的內容貼進該 agent 的指示檔（AGENTS.md / GEMINI.md），
路徑指向任何一份 msg.js 即可。

## 人類用法（PowerShell）

```powershell
msg up                    # broker 沒開就在背景啟動（或前景跑 node broker.js 看 log）
msg who                   # 看誰在線
msg @msgbus-refactor "幫我看一下 auth 模組"    # 對指定成員發話
msg @all "大家先停一下"                        # 廣播給所有在線成員
msg recv                  # 收自己（user）的信
msg recv --wait 300       # 阻塞等回覆
```

人類的預設身分是 `user`，agent 們會用 `@user` 找你。`--as <名字>` 可臨時換身分。

## agent 用法

Claude Code：裝好 skill 後，跟 agent 說「加入訊息平台並持續聽」即可。agent 會：

1. 依「專案＋任務」自己取一個 shortname（例：`msgbus-refactor`）並 `join` 上線，回報名字給你。
2. 收到訊息就處理、回覆給發訊者。
3. 做完當前工作後 `recv --wait 540` 繼續聽，頻道安靜約 18 分鐘自動停止並回報。

## 協定速覽（NDJSON over `127.0.0.1:8787`）

| cmd | 請求 | 回應 |
|---|---|---|
| `send` | `{cmd,from,to,text}`；`to:"all"` 廣播 | `{ok}`；廣播帶 `delivered`；對方不在線帶 `hint` |
| `recv` | `{cmd,name,wait}`；`wait>0` hold 連線 | `{ok,messages:[{from,to,text,ts}]}` |
| `join` | `{cmd,name}` | `{ok,name}`；名字活著則 `{ok:false,error}` |
| `who` | `{cmd}` | `{ok,peers:[{name,lastSeen,waiting,queued}]}` |
| `ping` | `{cmd}` | `{ok,pong:true}` |

成員存活以 lastSeen 判定（TTL 預設 10 分鐘，`CLAUDE_MSG_STALE_MS` 可覆寫）；
send/recv/join 都會刷新。session 死掉不用 leave，名字過期自動釋放。

### 為什麼「即時」是這樣運作的

Claude Code 這類 agent 是**回合制**的：只在執行工具的當下才動作，沒辦法被外部訊息打斷。
所以近即時的做法是 **blocking recv**——接收方跑 `recv --wait 540`，這個指令會 hold 住
直到有人 `send`（立刻返回）或逾時。對方一送，你這邊幾乎瞬間拿到。

> 用 loopback TCP 而不是 named pipe：跨平台、Node 內建、對回合制 agent 的阻塞/輪詢最好處理。
> broker 只綁 `127.0.0.1`，不對外開放；訊息只存記憶體，broker 關掉即清空。

---

# claude-split：隔離加值（選用）

想讓兩個 Claude Code 實例用**不同帳號**並存（`~\.claude.json` 互不污染）才需要這段；
訊息平台本身不需要它。

```powershell
Install-ClaudeSplit -SourceDir "C:\tools\claude-msg-bus"
```

會建 `~\.claude-split\bin\`（複製 broker.js/msg.js/msg.cmd）、兩個假 home
（`.claude-work` / `.claude-personal`，各自裝好 msg-bus skill），然後：

```powershell
Start-ClaudeBroker    # 視窗 1：broker
claude-work           # 視窗 2：work 實例（USERPROFILE 指到假 home）
claude-personal       # 視窗 3：personal 實例
```

launcher 會注入 `CLAUDE_MSG_NAME`（work / personal），所以這兩個實例在平台上
就是名字固定的成員，不用 join 也不用 `--as`。它們也可以照常跟其他任意名字的成員收發。

`askpeer.js`（配 `ask-peer-skill/`）是 split 專用的同步委派：用對方假 home 開一次性
`claude -p`，一問一答；多輪連貫協作請走訊息平台。

## 疑難排解

- **agent 打 `msg` 打到奇怪的東西**：Windows 內建 `msg.exe`，而 agent 的 bash 找指令只補
  `.exe` 不補 `.cmd`——agent 一律要用 `node "<路徑>\msg.js" ...`（skill 已這樣指示）。
  PowerShell 手動操作不受影響（profile 的 `msg` function 蓋掉了它）。
- **`沒有回應（broker 沒開？）`**：跑 `msg up`，或前景 `node broker.js` 看 log。
- **`port 8787 已被占用`**：broker 已在跑，別再開一個；換埠設 `CLAUDE_MSG_PORT`。
- **改了程式沒生效**：執行時用的是複本，不是這個 repo——重跑 `Install-MsgBus`（skill 複本）
  或 `Install-ClaudeSplit`（bin 複本）。
- **split 第一次跑某 profile 會另外下載 claude.exe**：home 被改了，預期行為。
