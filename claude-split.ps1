# =====================================================================
#  claude-split.ps1
#  Two isolated-but-connected Claude Code instances (Windows)
#  - Isolation: each gets its own fake home (USERPROFILE), so ~\.claude.json never mixes
#  - Communication: one shared broker (localhost TCP), driven by the msg CLI
#
#  Install: paste this file into your PowerShell profile (notepad $PROFILE),
#           or source it from the profile with  . "path\claude-split.ps1"
# =====================================================================

# --- Shared settings ------------------------------------------------
$Global:ClaudeSplitBase = Join-Path $env:USERPROFILE ".claude-split"
$Global:ClaudeSplitBin  = Join-Path $Global:ClaudeSplitBase "bin"   # holds broker.js / msg.js / msg.cmd
$Global:ClaudeMsgPort   = 8787
# Install-mode config file: records whether this machine runs split or skill-only;
# the broker path is read from here.
$Global:ClaudeMsgConfig = Join-Path $env:USERPROFILE ".claude-msgbus.json"

function Write-MsgBusConfig {
    param([string]$Mode, [string]$Broker)
    @{ mode = $Mode; broker = $Broker; port = $Global:ClaudeMsgPort } |
        ConvertTo-Json | Set-Content -Path $Global:ClaudeMsgConfig -Encoding UTF8
    Write-Host "Config written to $Global:ClaudeMsgConfig (mode=$Mode)" -ForegroundColor DarkGray
}

function Get-MsgBusConfig {
    if (Test-Path $Global:ClaudeMsgConfig) {
        try { return Get-Content $Global:ClaudeMsgConfig -Raw | ConvertFrom-Json } catch {}
    }
    return $null
}

# --- One-time install: create the folders and copy the tools ---------
# Usage: Install-ClaudeSplit -SourceDir "C:\tools\claude-msg-bus"
# (Note: at the SourceDir: prompt, do not type quotes; quotes are only needed after -SourceDir)
function Install-ClaudeSplit {
    param([Parameter(Mandatory=$true)][string]$SourceDir)
    New-Item -ItemType Directory -Force -Path $Global:ClaudeSplitBin | Out-Null
    foreach ($f in @("broker.js", "msg.js", "msg.cmd", "sendkeys.ps1")) {
        Copy-Item (Join-Path $SourceDir $f) (Join-Path $Global:ClaudeSplitBin $f) -Force
    }
    New-Item -ItemType Directory -Force -Path (Join-Path $Global:ClaudeSplitBase ".claude-work")     | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $Global:ClaudeSplitBase ".claude-personal") | Out-Null
    # A session inside a fake home only sees skills under that home, so install a copy of the msg-bus skill in each
    Install-MsgBus -SourceDir $SourceDir -TargetHome (Join-Path $Global:ClaudeSplitBase ".claude-work")
    Install-MsgBus -SourceDir $SourceDir -TargetHome (Join-Path $Global:ClaudeSplitBase ".claude-personal")
    Write-MsgBusConfig -Mode "split" -Broker (Join-Path $Global:ClaudeSplitBin "broker.js")
    Write-Host "Installed to $Global:ClaudeSplitBin" -ForegroundColor Green
}

# --- Install the msg-bus skill (for everyone: any Claude Code session can join the platform) ---
# Usage: Install-MsgBus -SourceDir "C:\tools\claude-msg-bus"   (installs into the real home)
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
    Write-Host "msg-bus skill installed to $dest" -ForegroundColor Green
    # Only write the config when installing into the real home; the fake-home calls made
    # by split don't count. If split is already installed, don't downgrade it to skill.
    if ($TargetHome -eq $env:USERPROFILE) {
        $cfg = Get-MsgBusConfig
        if (-not ($cfg -and $cfg.mode -eq "split")) {
            Write-MsgBusConfig -Mode "skill" -Broker (Join-Path $dest "broker.js")
        }
    }
}

# --- Start the broker (in its own window; just leave it open) --------
function Start-ClaudeBroker {
    param([int]$Port = $Global:ClaudeMsgPort)
    # The broker path comes from the install mode in the config file; only guess if the config is missing
    $cfg = Get-MsgBusConfig
    $broker = if ($cfg -and (Test-Path $cfg.broker)) { $cfg.broker }
              elseif (Test-Path (Join-Path $Global:ClaudeSplitBin "broker.js")) { Join-Path $Global:ClaudeSplitBin "broker.js" }
              else { Join-Path $env:USERPROFILE ".claude\skills\claude-msg\broker.js" }
    if (-not (Test-Path $broker)) { Write-Error "broker.js not found (run Install-MsgBus or Install-ClaudeSplit first)"; return }
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { Write-Host "broker already running (port $Port), not starting another." -ForegroundColor Yellow; return }
    $env:CLAUDE_MSG_PORT = "$Port"
    Write-Host "Starting broker (port $Port)... close that window to stop it." -ForegroundColor Green
    Start-Process -FilePath "node" -ArgumentList @("`"$broker`"") -WindowStyle Normal
}

# --- The msg shortcut for PowerShell --------------------------------
# PowerShell functions outrank external programs, so this reliably shadows the system msg.exe.
# (An agent's bash does not see this function; it uses the $CLAUDE_MSG env var injected below.)
# Tab completion: first field completes subcommands + online members (msg raja<TAB> sends straight
# away), second field completes member names.
# Note that @name is splatting in PowerShell and tab-completes to a variable; use bare names.
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
            # Which field are we completing: when $word is non-empty it is itself the last element
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

# --- Session registry: lets broker chat commands (/stop) address the window ----
# sessions.json entries: { name, pid, hwnd, startedAt }. The HWND is whatever
# window is foreground when the launcher runs — i.e. the window you typed
# claude-work into. Windows Terminal tabs share one HWND, so for reliable
# /stop targeting run each split session in its own window.
function Register-ClaudeSplitSession {
    param([string]$MsgName)
    if (-not ('ClaudeSplit.Native' -as [type])) {
        Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();' -Name Native -Namespace ClaudeSplit
    }
    $hwnd = [long][ClaudeSplit.Native]::GetForegroundWindow()
    $file = Join-Path $Global:ClaudeSplitBase "sessions.json"
    $sessions = @()
    # PS 5.1: ConvertFrom-Json emits a JSON array as ONE pipeline item; assign to a
    # variable first, then pipe, so it enumerates instead of nesting.
    if (Test-Path $file) { try { $parsed = Get-Content $file -Raw | ConvertFrom-Json; $sessions = @($parsed | Where-Object { $_ -and $_.name -ne $MsgName }) } catch {} }
    $sessions += [pscustomobject]@{ name = $MsgName; pid = $PID; hwnd = $hwnd; startedAt = (Get-Date -Format o) }
    ConvertTo-Json -InputObject $sessions | Set-Content -Path $file -Encoding UTF8
}

function Unregister-ClaudeSplitSession {
    param([string]$MsgName)
    $file = Join-Path $Global:ClaudeSplitBase "sessions.json"
    if (-not (Test-Path $file)) { return }
    try {
        $parsed = Get-Content $file -Raw | ConvertFrom-Json
        $sessions = @($parsed | Where-Object { $_ -and $_.name -ne $MsgName })
        ConvertTo-Json -InputObject $sessions | Set-Content -Path $file -Encoding UTF8
    } catch {}
}

# --- Core launcher: fake the home + set the identity + inject paths --
function Invoke-ClaudeWithProfile {
    param(
        [Parameter(Mandatory=$true)][string]$ProfileName,   # fake home folder name
        [Parameter(Mandatory=$true)][string]$MsgName,        # message identity: work / personal
        [Parameter(ValueFromRemainingArguments=$true)]$ClaudeArgs
    )
    $targetPath = Join-Path $Global:ClaudeSplitBase $ProfileName
    $profileBin = Join-Path $targetPath ".local\bin"
    New-Item -ItemType Directory -Path $profileBin -Force | Out-Null
    Register-ClaudeSplitSession -MsgName $MsgName

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
        # Full path for the agent's bash, so it never hits the system msg.exe: node "$CLAUDE_MSG" recv
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
        Unregister-ClaudeSplitSession -MsgName $MsgName
    }
}

function claude-work     { Invoke-ClaudeWithProfile -ProfileName ".claude-work"     -MsgName "work"     @args }
function claude-personal { Invoke-ClaudeWithProfile -ProfileName ".claude-personal" -MsgName "personal" @args }
