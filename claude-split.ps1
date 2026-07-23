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
    Write-Host "已安裝到 $Global:ClaudeSplitBin" -ForegroundColor Green
}

# --- 啟動 broker（在它自己的視窗，開著就好）--------------------------
function Start-ClaudeBroker {
    param([int]$Port = $Global:ClaudeMsgPort)
    $broker = Join-Path $Global:ClaudeSplitBin "broker.js"
    if (-not (Test-Path $broker)) { Write-Error "找不到 broker.js：$broker（先跑 Install-ClaudeSplit）"; return }
    $env:CLAUDE_MSG_PORT = "$Port"
    Write-Host "啟動 broker（port $Port）…關掉那個視窗即停止。" -ForegroundColor Green
    Start-Process -FilePath "node" -ArgumentList @("`"$broker`"") -WindowStyle Normal
}

# --- PowerShell 用的 msg 捷徑 ---------------------------------------
# PowerShell 的 function 優先權高於外部程式，能穩定蓋掉系統的 msg.exe。
# （agent 的 bash 不吃這個 function，改用下面注入的 $CLAUDE_MSG 環境變數。）
function msg {
    node (Join-Path $Global:ClaudeSplitBin "msg.js") @args
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
