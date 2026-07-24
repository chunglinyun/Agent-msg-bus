# Session registry 改用 bus 名 + chat tab 補全規劃

狀態：**已實作（2026-07-24）**。tab 補全與 /stop 實機注入的體感驗證留待日常使用確認。

## Context

Bug（2026-07-24 使用者回報）：同一個 launcher（例如兩個 `claude-work`）開第二個 agent 時，`sessions.json` 的 pid/hwnd 被蓋掉。

根因：registry 以 launcher 身分（work/personal）當 key——
- `Register-ClaudeSplitSession`（claude-split.ps1:137）寫入前把同名舊條目濾掉 → 第二個 session 蓋掉第一個。
- `Unregister-ClaudeSplitSession` 也按 name 刪 → 任一個退出會把還活著的另一個條目一起刪掉。
- `/stop`（broker.js:159）按 name 只找一筆，兩個同名 session 根本無法分別定址。

另一個根因（使用者補充）：`claude-split.ps1` 開頭的全域路徑全部在 profile 載入時從 `$env:USERPROFILE` 推導——

```powershell
$Global:ClaudeSplitBase = Join-Path $env:USERPROFILE ".claude-split"
$Global:ClaudeSplitBin  = Join-Path $Global:ClaudeSplitBase "bin"
$Global:ClaudeMsgConfig = Join-Path $env:USERPROFILE ".claude-msgbus.json"
```

在 split session 內（USERPROFILE 已指向假 home）再開 PowerShell 時，profile 重新載入，
Base 會解析成 `…\.claude-split\.claude-work\.claude-split`：sessions.json 寫錯地方、
config 讀不到、bin 指錯，巢狀啟動的 session 完全脫離 registry。

修正方向（使用者定案）：**session 命名改用聊天室（bus）名字**，並讓 chat 視窗能用 **tab 補全**快速選到要觸發 `/stop`、`/usage` 的 agent；全域路徑推導須對假 home 免疫。

## 設計

sessions.json 條目改為 `{ name, profile, pid, hwnd, startedAt }`：
- **key = pid**（每個 session 唯一），不再以 name 當 key。
- `profile` = launcher 身分（work/personal），`/usage` 找 transcript 目錄要用。
- `name` 啟動時先填 profile 當佔位，agent `msg join` 成功後改成 bus 名。

bus 名 ↔ 視窗的連結（原計畫認為「bus 名跟視窗對不上」，這裡補上連結機制）：
launcher 多注入兩個環境變數，session 內的 msg.js join 時據此回寫自己的條目——
- `CLAUDE_SPLIT_SESSION_PID`：launcher 的 $PID（條目 key）。
- `CLAUDE_SPLIT_SESSIONS_FILE`：sessions.json 完整路徑（split session 的 USERPROFILE 是假 home，不能用它推導）。

## 實作步驟

0. 設定檔承載路徑（先做，其他都建立在正確的 Base 上）
   - 擴充既有的 `~\.claude-msgbus.json`（`Write-MsgBusConfig`）：
     `{ mode: split|skill, source: <clone 目錄>, base: <.claude-split 完整路徑>, broker, port }`。
     `Install-ClaudeSplit` 寫 `mode=split`；`Install-MsgBus`（裝進真 home 時）寫 `mode=skill`；
     兩者都把 `-SourceDir`（clone 位置）記進 `source`，split 另記 `base`。
   - profile 載入時：先定位設定檔——路徑仍從 USERPROFILE 推導，但先剝掉 `\.claude-split\` 之後的
     假 home 段還原真 home（一行 regex；設定檔本體永遠放真 home，這是唯一的 bootstrap 點）。
     讀到設定檔後，`ClaudeSplitBase`/`ClaudeSplitBin` 一律取自 `base`；沒有設定檔才 fallback
     到現行的 USERPROFILE 推導（首次安裝前的裸環境）。
   - 效果：split session 內開的 shell 讀同一份設定檔，Base 指回真位置；重裝／搬 repo 只要重跑
     install，`source` 也讓之後的 re-install 可以不帶參數（`Install-ClaudeSplit` 無 `-SourceDir`
     時取 config 的 `source`）。
1. `claude-split.ps1`
   - `Register-ClaudeSplitSession`：改按 pid 過濾（不按 name）；順手清掉 pid 已死的殘留條目（Get-Process 檢查）；條目加 `profile` 欄位。
   - `Unregister-ClaudeSplitSession`：改按 $PID 刪。
   - `Invoke-ClaudeWithProfile`：注入上述兩個環境變數（try/finally 還原）。
2. `msg.js`
   - `join` 成功後，若兩個環境變數都在：讀 sessions.json（去 BOM）→ 找 pid 相符條目 → `name` 改成 bus 名 → 寫回。best-effort（try/catch 靜默略過），非 split 環境完全不受影響。
3. `broker.js`
   - `/stop`、`/usage` 目標解析：先比對 `name`；沒中再比對 `profile`——恰一筆就用，多筆則列出候選並提示改用 bus 名（agent 要先 join）。
   - `usageReport` 改用條目的 `profile` 組 transcript 路徑；查無條目時維持舊行為（把 target 直接當 profile）。
   - chat completer：輸入符合 `^/(stop|usage)\s+\S*$` 時，第二欄補全 sessions.json 的 name（＋profile）。
   - 說明文字同步更新。
4. 文件與部署：README chat 指令段落；重跑 `Install-ClaudeSplit` 與 `Install-MsgBus`（msg.js 有改，skill 副本也要更新）。

## 邊界情況

- agent 還沒 join：name 停在 profile，`/stop work` 照舊可用（單一 session 時）。
- 兩個同 profile session 都沒 join：定址不了是本質限制，broker 列出候選（含 pid）並提示先 join。
- launcher 寫檔 vs msg.js 回寫的競態：視窗極小，last-writer-wins，接受（ponytail）。

## 不做（YAGNI）

- sessions.json 檔案鎖。
- broker 端主動追蹤 join → registry 的同步（保持 registry 是純檔案、broker 只讀）。
- 非 split session 的註冊。

## 驗證

0. 在 split session 內開新 PowerShell：`$Global:ClaudeSplitBase` 從設定檔讀出、仍指向真 home 的
   `.claude-split`；從該 shell 啟動 launcher，sessions.json 寫在正確位置。
   另驗：刪掉設定檔後 profile 載入不報錯（fallback 到 USERPROFILE 推導）；
   `Install-ClaudeSplit` 不帶 `-SourceDir` 重跑時取 config 的 `source`。
1. 開兩個 `claude-work`：sessions.json 兩筆條目並存，pid 不互蓋。
2. 兩個 agent 各自 join 不同 bus 名：條目 name 更新為 bus 名。
3. chat 視窗 `/stop <tab>`：補全出兩個 bus 名；`/stop <bus名>` 只中斷該視窗。
4. `/usage <bus名>`：正確讀到該 session 所屬 profile 的 transcript。
5. 關掉其中一個 session：只刪自己的條目，另一個仍在。
6. 未 join 就 `/stop work`（單一 work session）：照舊可用。
