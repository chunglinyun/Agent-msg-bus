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
# Inside a split session USERPROFILE points at a fake home under .claude-split;
# strip that suffix to get the real home. The config file always lives there —
# it is the single bootstrap point, everything else is read from it.
$Global:ClaudeSplitRealHome = $env:USERPROFILE -replace '\\\.claude-split\\.*$', ''
# Config file: install mode (split/skill), the source clone dir, the base dir,
# and the broker path.
$Global:ClaudeMsgConfig = Join-Path $Global:ClaudeSplitRealHome ".claude-msgbus.json"

function Get-MsgBusConfig {
    if (Test-Path $Global:ClaudeMsgConfig) {
        try { return Get-Content $Global:ClaudeMsgConfig -Raw | ConvertFrom-Json } catch {}
    }
    return $null
}

# Base/bin/port come from the config when present; USERPROFILE derivation is only
# the pre-install fallback (a bare machine before Install-* has ever run).
$script:__msgBusCfg = Get-MsgBusConfig
$Global:ClaudeSplitBase = if ($script:__msgBusCfg -and $script:__msgBusCfg.base) { [string]$script:__msgBusCfg.base }
                          else { Join-Path $Global:ClaudeSplitRealHome ".claude-split" }
$Global:ClaudeSplitBin  = Join-Path $Global:ClaudeSplitBase "bin"   # holds broker.js / msg.js / msg.cmd
$Global:ClaudeMsgPort   = if ($script:__msgBusCfg -and $script:__msgBusCfg.port) { [int]$script:__msgBusCfg.port } else { 8787 }
$Global:ClaudeWebPort   = if ($script:__msgBusCfg -and $script:__msgBusCfg.webPort) { [int]$script:__msgBusCfg.webPort } else { 8788 }

function Write-MsgBusConfig {
    param([string]$Mode, [string]$Broker, [string]$SourceDir)
    @{ mode = $Mode; source = $SourceDir; base = $Global:ClaudeSplitBase; broker = $Broker; port = $Global:ClaudeMsgPort; webPort = $Global:ClaudeWebPort } |
        ConvertTo-Json | Set-Content -Path $Global:ClaudeMsgConfig -Encoding UTF8
    Write-Host "Config written to $Global:ClaudeMsgConfig (mode=$Mode)" -ForegroundColor DarkGray
}

# -SourceDir omitted on a re-install = reuse the clone dir recorded in the config.
function Resolve-MsgBusSource {
    param([string]$SourceDir)
    if ($SourceDir) { return $SourceDir }
    $cfg = Get-MsgBusConfig
    if ($cfg -and $cfg.source) { return [string]$cfg.source }
    return $null
}

# --- One-time install: create the folders and copy the tools ---------
# Usage: Install-ClaudeSplit -SourceDir "C:\tools\claude-msg-bus"
# (Note: at the SourceDir: prompt, do not type quotes; quotes are only needed after -SourceDir)
function Install-ClaudeSplit {
    param([string]$SourceDir)
    $SourceDir = Resolve-MsgBusSource $SourceDir
    if (-not $SourceDir) { Write-Error "no -SourceDir given and none recorded in $Global:ClaudeMsgConfig; run Install-ClaudeSplit -SourceDir <clone dir>"; return }
    New-Item -ItemType Directory -Force -Path $Global:ClaudeSplitBin | Out-Null
    foreach ($f in @("broker.js", "msg.js", "msg.cmd", "sendkeys.ps1", "web.js", "web.html")) {
        Copy-Item (Join-Path $SourceDir $f) (Join-Path $Global:ClaudeSplitBin $f) -Force
    }
    New-Item -ItemType Directory -Force -Path (Join-Path $Global:ClaudeSplitBase ".claude-work")     | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $Global:ClaudeSplitBase ".claude-personal") | Out-Null
    # No claude.exe copy per fake home: the launcher runs the real one by absolute path.

    # A session inside a fake home only sees skills under that home, so install a copy of the msg-bus skill in each
    Install-MsgBus -SourceDir $SourceDir -TargetHome (Join-Path $Global:ClaudeSplitBase ".claude-work")
    Install-MsgBus -SourceDir $SourceDir -TargetHome (Join-Path $Global:ClaudeSplitBase ".claude-personal")
    Write-MsgBusConfig -Mode "split" -Broker (Join-Path $Global:ClaudeSplitBin "broker.js") -SourceDir $SourceDir
    Write-Host "Installed to $Global:ClaudeSplitBin" -ForegroundColor Green
}

# --- Install the whole platform into one Claude Code home ------------
# This is the install for the ordinary case: a single Claude Code, one account, any
# number of sessions on the bus. It is NOT a cut-down Install-ClaudeSplit — split
# exists only for people who need two isolated Claude Code configs (separate
# accounts/subscriptions), and it calls this function to furnish each fake home.
# Everything a session needs ships here: the skill, the CLI, the broker, the key
# injection helper, and the web frontend (Start-ClaudeWeb looks for web.js next to
# whichever broker.js the config points at, which for this install is the copy below).
# Usage: Install-MsgBus -SourceDir "C:\tools\claude-msg-bus"   (installs into the real home)
function Install-MsgBus {
    param(
        [string]$SourceDir,
        [string]$TargetHome = $Global:ClaudeSplitRealHome
    )
    $SourceDir = Resolve-MsgBusSource $SourceDir
    if (-not $SourceDir) { Write-Error "no -SourceDir given and none recorded in $Global:ClaudeMsgConfig; run Install-MsgBus -SourceDir <clone dir>"; return }
    $dest = Join-Path $TargetHome ".claude\skills\claude-msg"
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    # Same list install.ps1 lays down for Claude Code, and for the same reasons:
    # broker.js finds sendkeys.ps1 in its own directory, Start-ClaudeWeb finds web.js
    # next to broker.js. A fake home gets copies it never starts — harmless, and not
    # worth a second branch.
    foreach ($f in @("msg-bus-skill\SKILL.md", "msg.js", "broker.js", "sendkeys.ps1", "web.js", "web.html")) {
        Copy-Item (Join-Path $SourceDir $f) (Join-Path $dest (Split-Path $f -Leaf)) -Force
    }
    Write-Host "msg-bus platform installed to $dest" -ForegroundColor Green
    # Only write the config when installing into the real home; the fake-home calls made
    # by split don't count. If split is already installed, don't downgrade it to skill.
    if ($TargetHome -eq $Global:ClaudeSplitRealHome) {
        $cfg = Get-MsgBusConfig
        if (-not ($cfg -and $cfg.mode -eq "split")) {
            Write-MsgBusConfig -Mode "skill" -Broker (Join-Path $dest "broker.js") -SourceDir $SourceDir
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
              else { Join-Path $Global:ClaudeSplitRealHome ".claude\skills\claude-msg\broker.js" }
    if (-not (Test-Path $broker)) { Write-Error "broker.js not found (run Install-MsgBus or Install-ClaudeSplit first)"; return }
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { Write-Host "broker already running (port $Port), not starting another." -ForegroundColor Yellow; return }
    $env:CLAUDE_MSG_PORT = "$Port"
    Write-Host "Starting broker (port $Port)... close that window to stop it." -ForegroundColor Green
    Start-Process -FilePath "node" -ArgumentList @("`"$broker`"") -WindowStyle Normal
}

# --- Start the web frontend (in its own window; leave it open) -------
# The page joins the bus as `user`, so it can run alongside a foreground broker:
# both windows show every message, each one just shows it once.
function Start-ClaudeWeb {
    param([int]$Port = $Global:ClaudeWebPort)
    # web.js always sits next to broker.js, whichever install mode wrote the config
    $cfg = Get-MsgBusConfig
    $brokerPath = if ($cfg -and (Test-Path $cfg.broker)) { $cfg.broker }
                  elseif (Test-Path (Join-Path $Global:ClaudeSplitBin "broker.js")) { Join-Path $Global:ClaudeSplitBin "broker.js" }
                  else { Join-Path $Global:ClaudeSplitRealHome ".claude\skills\claude-msg\broker.js" }
    $web = Join-Path (Split-Path $brokerPath -Parent) "web.js"
    if (-not (Test-Path $web)) { Write-Error "web.js not found next to $brokerPath (re-run Install-MsgBus or Install-ClaudeSplit)"; return }
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { Write-Host "web frontend already running (port $Port), not starting another." -ForegroundColor Yellow; return }
    $env:CLAUDE_MSG_PORT = "$Global:ClaudeMsgPort"
    $env:CLAUDE_WEB_PORT = "$Port"
    Write-Host "Starting web frontend: http://127.0.0.1:$Port  (close that window to stop it)" -ForegroundColor Green
    Start-Process -FilePath "node" -ArgumentList @("`"$web`"") -WindowStyle Normal
}

# --- The msg shortcut for PowerShell --------------------------------
# PowerShell functions outrank external programs, so this reliably shadows the system msg.exe.
# (An agent's bash does not see this function; it uses the $CLAUDE_MSG env var injected below.)
# Tab completion: first field completes subcommands + online members (msg raja<TAB> sends straight
# away), second field completes member names.
# Note that @name is splatting in PowerShell and tab-completes to a variable; use bare names.
# Where msg.js lives: split's bin if installed, otherwise next to the broker recorded
# in the config (skill-only installs never create the bin dir).
function Get-ClaudeMsgCli {
    $binCopy = Join-Path $Global:ClaudeSplitBin "msg.js"
    if (Test-Path $binCopy) { return $binCopy }
    $cfg = Get-MsgBusConfig
    if ($cfg -and $cfg.broker) {
        $alt = Join-Path (Split-Path $cfg.broker -Parent) "msg.js"
        if (Test-Path $alt) { return $alt }
    }
    return $binCopy
}
# Where sessions.json lives — same rule as broker.js: the registry belongs to the
# install that owns the broker, i.e. the nearest ancestor of the installed copy whose
# name starts with a dot (~\.claude for a skill install, ~\.codex / ~\.gemini for the
# other agents, ~\.claude-split for split, whose copies sit in bin\).
function Get-ClaudeMsgSessionsFile {
    $toolsDir = Split-Path (Get-ClaudeMsgCli) -Parent
    $d = $toolsDir
    while ($d -and -not (Split-Path $d -Leaf).StartsWith('.')) {
        $up = Split-Path $d -Parent
        if (-not $up -or $up -eq $d) { return (Join-Path $toolsDir "sessions.json") }
        $d = $up
    }
    Join-Path $d "sessions.json"
}

function Get-ClaudeMsgPeers {
    try {
        node (Get-ClaudeMsgCli) who 2>$null |
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
                @('send','recv','join','register','who','up','ping','whoami') + (Get-ClaudeMsgPeers)
            } elseif ($pos -eq 2 -and $elems[1].Extent.Text -eq 'send') {
                @('all') + (Get-ClaudeMsgPeers)
            } else { @() }
            $cands | Where-Object { $_ -like "$word*" }
        })]
        $MsgArgs
    )
    node (Get-ClaudeMsgCli) @MsgArgs
}

# --- Session registry: lets broker chat commands (/stop) address the window ----
# sessions.json entries: { name, profile, pid, hwnd, startedAt }, keyed by pid so
# two sessions of the same launcher coexist. name starts as the launcher identity
# (work/personal) and is rewritten to the agent's bus name by msg.js on join;
# profile stays work/personal (a usable fallback target while unambiguous).
# The HWND is whatever window is foreground when the launcher runs — i.e. the
# window you typed claude-work into. Windows Terminal tabs share one HWND, so for
# reliable /stop targeting run each split session in its own window.
function Register-ClaudeSplitSession {
    # FallbackName lands in the profile field, the secondary /stop target. Pass $null
    # for a session in the real home: "claude" as a fallback would match every one of
    # them, i.e. it could only ever answer "ambiguous".
    param([string]$MsgName, $FallbackName = $MsgName)
    if (-not ('ClaudeSplit.Native' -as [type])) {
        Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();' -Name Native -Namespace ClaudeSplit
    }
    $hwnd = [long][ClaudeSplit.Native]::GetForegroundWindow()
    $file = Get-ClaudeMsgSessionsFile
    $sessions = @()
    # PS 5.1: ConvertFrom-Json emits a JSON array as ONE pipeline item; assign to a
    # variable first, then pipe, so it enumerates instead of nesting.
    # Keep only other, still-alive sessions (drops our own stale entry and any
    # entry whose launcher process is gone — crashes never Unregister). Entries for
    # this same window go too: one window can only hold one addressable session, and
    # the broker's own writer dedups by hwnd for the same reason.
    if (Test-Path $file) { try { $parsed = Get-Content $file -Raw | ConvertFrom-Json; $sessions = @($parsed | Where-Object { $_ -and $_.pid -ne $PID -and $_.hwnd -ne $hwnd -and (Get-Process -Id $_.pid -ErrorAction SilentlyContinue) }) } catch {} }
    $sessions += [pscustomobject]@{ name = $MsgName; profile = $FallbackName; pid = $PID; hwnd = $hwnd; startedAt = (Get-Date -Format o) }
    # Normally an existing directory (it is an ancestor of the installed copy), but
    # create it anyway: a config pointing at a not-yet-installed path must not throw.
    New-Item -ItemType Directory -Force -Path (Split-Path $file -Parent) | Out-Null
    ConvertTo-Json -InputObject $sessions | Set-Content -Path $file -Encoding UTF8
}

function Unregister-ClaudeSplitSession {
    $file = Get-ClaudeMsgSessionsFile
    if (-not (Test-Path $file)) { return }
    try {
        $parsed = Get-Content $file -Raw | ConvertFrom-Json
        $sessions = @($parsed | Where-Object { $_ -and $_.pid -ne $PID })
        ConvertTo-Json -InputObject $sessions | Set-Content -Path $file -Encoding UTF8
    } catch {}
}

# --- Core launcher: pick the home + set the identity + inject paths --
# With -ProfileName it runs claude in that fake home (the isolation launchers).
# Without, it runs claude in the real home exactly as a bare `claude` would; the only
# thing it adds is the sessions.json entry that lets /stop and friends find this
# window, and its removal on the way out. Registering has to happen here, at the
# shell prompt, because this is the one moment the target window is provably the
# foreground one — a session cannot work that out about itself later.
function Invoke-ClaudeWithProfile {
    param(
        [string]$ProfileName,   # fake home folder name; omit for the real home
        [string]$MsgName,       # message identity: work / personal (fake homes only)
        [Parameter(ValueFromRemainingArguments=$true)]$ClaudeArgs
    )
    $split = [bool]$ProfileName
    $targetPath = if ($split) { Join-Path $Global:ClaudeSplitBase $ProfileName } else { $Global:ClaudeSplitRealHome }
    $profileBin = Join-Path $targetPath ".local\bin"
    if ($split) { New-Item -ItemType Directory -Path $profileBin -Force | Out-Null }

    # `claude -p` is a one-shot with no window of its own to speak of: registering it
    # would just add a second entry for a window someone else is sitting in.
    $register = -not ($ClaudeArgs -contains '-p' -or $ClaudeArgs -contains '--print')
    # "claude" is a placeholder until msg join renames the entry to the bus name.
    if ($register) {
        if ($split) { Register-ClaudeSplitSession -MsgName $MsgName }
        else        { Register-ClaudeSplitSession -MsgName "claude" -FallbackName $null }
    }

    $oldUserProfile = $env:USERPROFILE
    $oldPath        = $env:PATH
    $oldMsgName     = $env:CLAUDE_MSG_NAME
    $oldMsgPort     = $env:CLAUDE_MSG_PORT
    $oldMsg         = $env:CLAUDE_MSG
    $oldSessPid     = $env:CLAUDE_SPLIT_SESSION_PID
    $oldSessFile    = $env:CLAUDE_SPLIT_SESSIONS_FILE
    $oldNoUpdate    = $env:DISABLE_AUTOUPDATER
    try {
        if ($split) {
            $env:USERPROFILE     = $targetPath
            $env:PATH            = "$profileBin;$Global:ClaudeSplitBin;$env:PATH"
            $env:CLAUDE_MSG_NAME = $MsgName
            # The updater derives its install dir from the (faked) home, so an update run inside a split
            # session installs into the fake home where nothing ever launches it. Update in a normal
            # shell instead: claude update.
            $env:DISABLE_AUTOUPDATER = "1"
        }
        $env:CLAUDE_MSG_PORT = "$Global:ClaudeMsgPort"
        # Full path for the agent's bash, so it never hits the system msg.exe: node "$CLAUDE_MSG" recv
        $env:CLAUDE_MSG      = Get-ClaudeMsgCli
        # msg join sends this pid so the broker can rename our entry to the bus name.
        $env:CLAUDE_SPLIT_SESSION_PID   = if ($register) { "$PID" } else { $null }
        $env:CLAUDE_SPLIT_SESSIONS_FILE = Get-ClaudeMsgSessionsFile
        Write-Host "--- Claude Instance: [$(if ($split) { $MsgName } else { 'default home' })] ($targetPath) ---" -ForegroundColor Cyan
        # Absolute path, not a bare `claude`: machine PATH (e.g. C:\nvm4w\nodejs) precedes the user's
        # ~\.local\bin, so a bare claude can resolve to a leftover npm shim whose bundled claude.exe
        # is a foreign-platform stub ("not a valid application for this OS platform").
        $native = Join-Path $Global:ClaudeSplitRealHome ".local\bin\claude.exe"
        if (-not (Test-Path $native)) {
            if ($split) { Write-Error "native claude.exe not found at $native; run 'irm https://claude.ai/install.ps1 | iex' first"; return }
            # Real home: PATH is untouched here, so whatever `claude` normally resolves to
            # is the right binary. This wrapper must not take the command away from someone
            # who installed Claude Code another way (npm shim, custom location).
            # -CommandType Application, or it would resolve back to this function.
            $native = (Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
            if (-not $native) { Write-Error "claude not found in $Global:ClaudeSplitRealHome\.local\bin or on PATH; run 'irm https://claude.ai/install.ps1 | iex' first"; return }
        }
        & $native @ClaudeArgs
    }
    finally {
        $env:USERPROFILE     = $oldUserProfile
        $env:PATH            = $oldPath
        $env:CLAUDE_MSG_NAME = $oldMsgName
        $env:CLAUDE_MSG_PORT = $oldMsgPort
        $env:CLAUDE_MSG      = $oldMsg
        $env:CLAUDE_SPLIT_SESSION_PID   = $oldSessPid
        $env:CLAUDE_SPLIT_SESSIONS_FILE = $oldSessFile
        $env:DISABLE_AUTOUPDATER        = $oldNoUpdate
        if ($register) { Unregister-ClaudeSplitSession }
    }
}

# -ClaudeArgs $args, not @args: splatting lets claude's own flags bind to this
# function's parameters instead ("claude -p hi" would pass "hi" as -ProfileName).
function claude          { Invoke-ClaudeWithProfile -ClaudeArgs $args }
function claude-work     { Invoke-ClaudeWithProfile -ProfileName ".claude-work"     -MsgName "work"     -ClaudeArgs $args }
function claude-personal { Invoke-ClaudeWithProfile -ProfileName ".claude-personal" -MsgName "personal" -ClaudeArgs $args }
