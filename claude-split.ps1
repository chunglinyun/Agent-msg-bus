# =====================================================================
#  claude-split.ps1
#  兩個「隔離 + 可溝通」的 Claude Code 實例（Windows）
#  - 隔離：各自假 home（USERPROFILE），~\.claude.json 不互相污染
#  - 溝通：一個共用 broker（localhost TCP），用 msg CLI 收發
#
#  安裝：把本檔內容貼進 PowerShell profile（notepad $PROFILE），
#        或於 profile 裡  . "路徑\claude-split.ps1"  來 source 它。
# =====================================================================

# --- 共用設定 -------------------------------------------------------
$Global:ClaudeSplitBase = Join-Path $env:USERPROFILE ".claude-split"
$Global:ClaudeSplitBin  = Join-Path $Global:ClaudeSplitBase "bin"   # 放 broker.js / msg.js / msg.cmd
$Global:ClaudeMsgPort   = 8787
# 安裝模式設定檔：記錄這台裝的是 split 還是 skill-only，broker 路徑從這裡讀
$Global:ClaudeMsgConfig = Join-Path $env:USERPROFILE ".claude-msgbus.json"

function Write-MsgBusConfig {
    param([string]$Mode, [string]$Broker)
    @{ mode = $Mode; broker = $Broker; port = $Global:ClaudeMsgPort } |
        ConvertTo-Json | Set-Content -Path $Global:ClaudeMsgConfig -Encoding UTF8
    Write-Host "設定檔已寫入 $Global:ClaudeMsgConfig（mode=$Mode）" -ForegroundColor DarkGray
}

function Get-MsgBusConfig {
    if (Test-Path $Global:ClaudeMsgConfig) {
        try { return Get-Content $Global:ClaudeMsgConfig -Raw | ConvertFrom-Json } catch {}
    }
    return $null
}

# --- 一次性安裝：建立資料夾並複製工具 --------------------------------
# 用法：Install-ClaudeSplit -SourceDir "C:\tools\claude-msg-bus"
#（注意：跳出 SourceDir: 提示時不要打引號；帶在 -SourceDir 後面才要引號）
function Install-ClaudeSplit {
    param([Parameter(Mandatory=$true)][string]$SourceDir)
    New-Item -ItemType Directory -Force -Path $Global:ClaudeSplitBin | Out-Null
    foreach ($f in @("broker.js", "msg.js", "msg.cmd")) {
        Copy-Item (Join-Path $SourceDir $f) (Join-Path $Global:ClaudeSplitBin $f) -Force
    }
    New-Item -ItemType Directory -Force -Path (Join-Path $Global:ClaudeSplitBase ".claude-work")     | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $Global:ClaudeSplitBase ".claude-personal") | Out-Null
    # 假 home 的 session 看得到的 skills 位置在假 home 底下，各裝一份 msg-bus skill
    Install-MsgBus -SourceDir $SourceDir -TargetHome (Join-Path $Global:ClaudeSplitBase ".claude-work")
    Install-MsgBus -SourceDir $SourceDir -TargetHome (Join-Path $Global:ClaudeSplitBase ".claude-personal")
    Write-MsgBusConfig -Mode "split" -Broker (Join-Path $Global:ClaudeSplitBin "broker.js")
    Write-Host "已安裝到 $Global:ClaudeSplitBin" -ForegroundColor Green
}

# --- 安裝 msg-bus skill（給一般人：任何 Claude Code session 都能加入平台）---
# 用法：Install-MsgBus -SourceDir "C:\tools\claude-msg-bus"   （裝到真 home）
function Install-MsgBus {
    param(
        [Parameter(Mandatory=$true)][string]$SourceDir,
        [string]$TargetHome = $env:USERPROFILE
    )
    $dest = Join-Path $TargetHome ".claude\skills\claude-msg"
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item (Join-Path $SourceDir "msg-bus-skill\SKILL.md") $dest -Force
    Copy-Item (Join-Path $SourceDir "msg.js")    $dest -Force
    Copy-Item (Join-Path $SourceDir "broker.js") $dest -Force
    Write-Host "msg-bus skill 已安裝到 $dest" -ForegroundColor Green
    # 只有裝進真 home 才寫設定檔；split 內部灌假 home 的呼叫不算。已是 split 就不降級成 skill
    if ($TargetHome -eq $env:USERPROFILE) {
        $cfg = Get-MsgBusConfig
        if (-not ($cfg -and $cfg.mode -eq "split")) {
            Write-MsgBusConfig -Mode "skill" -Broker (Join-Path $dest "broker.js")
        }
    }
}

# --- 啟動 broker（在它自己的視窗，開著就好）--------------------------
function Start-ClaudeBroker {
    param([int]$Port = $Global:ClaudeMsgPort)
    # broker 路徑照設定檔的安裝模式決定；設定檔缺了才退回猜路徑
    $cfg = Get-MsgBusConfig
    $broker = if ($cfg -and (Test-Path $cfg.broker)) { $cfg.broker }
              elseif (Test-Path (Join-Path $Global:ClaudeSplitBin "broker.js")) { Join-Path $Global:ClaudeSplitBin "broker.js" }
              else { Join-Path $env:USERPROFILE ".claude\skills\claude-msg\broker.js" }
    if (-not (Test-Path $broker)) { Write-Error "找不到 broker.js（先跑 Install-MsgBus 或 Install-ClaudeSplit）"; return }
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { Write-Host "broker 已在跑（port $Port），不重複啟動。" -ForegroundColor Yellow; return }
    $env:CLAUDE_MSG_PORT = "$Port"
    Write-Host "啟動 broker（port $Port）…關掉那個視窗即停止。" -ForegroundColor Green
    Start-Process -FilePath "node" -ArgumentList @("`"$broker`"") -WindowStyle Normal
}

# --- PowerShell 用的 msg 捷徑 ---------------------------------------
# PowerShell 的 function 優先權高於外部程式，能穩定蓋掉系統的 msg.exe。
# （agent 的 bash 不吃這個 function，改用下面注入的 $CLAUDE_MSG 環境變數。）
# tab 補全：第一格補子指令＋在線成員（msg raja<TAB> 直接送訊），第二格補成員名。
# 注意 @名字 在 PowerShell 是 splatting，tab 會補到變數；請用裸名字。
function Get-ClaudeMsgPeers {
    try {
        node (Join-Path $Global:ClaudeSplitBin "msg.js") who 2>$null |
            ForEach-Object { ($_ -split '\s+')[0] } |
            Where-Object { $_ -and $_ -notmatch '^\(' }
    } catch {}
}
function msg {
    param(
        [Parameter(ValueFromRemainingArguments=$true)]
        [ArgumentCompleter({
            param($cmdName, $paramName, $word, $ast, $bound)
            $elems = $ast.CommandElements
            # 正在補第幾格：word 非空時它自己就是最後一個 element
            $pos = if ($word) { $elems.Count - 1 } else { $elems.Count }
            $cands = if ($pos -le 1) {
                @('send','recv','join','who','up','ping','whoami') + (Get-ClaudeMsgPeers)
            } elseif ($pos -eq 2 -and $elems[1].Extent.Text -eq 'send') {
                @('all') + (Get-ClaudeMsgPeers)
            } else { @() }
            $cands | Where-Object { $_ -like "$word*" }
        })]
        $MsgArgs
    )
    node (Join-Path $Global:ClaudeSplitBin "msg.js") @MsgArgs
}

# --- 核心 launcher：偽造 home + 設定身分 + 注入路徑 ------------------
function Invoke-ClaudeWithProfile {
    param(
        [Parameter(Mandatory=$true)][string]$ProfileName,   # 假 home 資料夾名
        [Parameter(Mandatory=$true)][string]$MsgName,        # 訊息身分 work / personal
        [Parameter(ValueFromRemainingArguments=$true)]$ClaudeArgs
    )
    $targetPath = Join-Path $Global:ClaudeSplitBase $ProfileName
    $profileBin = Join-Path $targetPath ".local\bin"
    New-Item -ItemType Directory -Path $profileBin -Force | Out-Null

    $oldUserProfile = $env:USERPROFILE
    $oldPath        = $env:PATH
    $oldMsgName     = $env:CLAUDE_MSG_NAME
    $oldMsgPort     = $env:CLAUDE_MSG_PORT
    $oldMsg         = $env:CLAUDE_MSG
    try {
        $env:USERPROFILE     = $targetPath
        $env:PATH            = "$profileBin;$Global:ClaudeSplitBin;$env:PATH"
        $env:CLAUDE_MSG_NAME = $MsgName
        $env:CLAUDE_MSG_PORT = "$Global:ClaudeMsgPort"
        # 給 agent 的 bash 用的完整路徑，避免撞到系統 msg.exe：node "$CLAUDE_MSG" recv
        $env:CLAUDE_MSG      = (Join-Path $Global:ClaudeSplitBin "msg.js")
        Write-Host "--- Claude Instance: [$MsgName] ($targetPath) ---" -ForegroundColor Cyan
        & claude @ClaudeArgs
    }
    finally {
        $env:USERPROFILE     = $oldUserProfile
        $env:PATH            = $oldPath
        $env:CLAUDE_MSG_NAME = $oldMsgName
        $env:CLAUDE_MSG_PORT = $oldMsgPort
        $env:CLAUDE_MSG      = $oldMsg
    }
}

function claude-work     { Invoke-ClaudeWithProfile -ProfileName ".claude-work"     -MsgName "work"     @args }
function claude-personal { Invoke-ClaudeWithProfile -ProfileName ".claude-personal" -MsgName "personal" @args }
