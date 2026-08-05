# =====================================================================
#  install.ps1 - one-shot installer for the message platform
#  Detects which agent CLIs live on this machine (Claude Code / Codex /
#  Gemini CLI) and drops msg.js + the instructions where each one reads them.
#
#  Usage:  .\install.ps1                 # auto-detect, install everywhere
#          .\install.ps1 -DryRun         # show what it would do
#          .\install.ps1 -Agent codex    # force one target
#          .\install.ps1 -Agent other    # generic copy + instructions to paste
#          .\install.ps1 -SkipNodeCheck  # install anyway on an old/odd Node
# =====================================================================
[CmdletBinding()]
param(
    [ValidateSet('auto', 'claude', 'codex', 'gemini', 'other')]
    [string[]]$Agent = @('auto'),
    [string]$UserHome = $env:USERPROFILE,
    [switch]$DryRun,
    [switch]$SkipNodeCheck
)

$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
if (-not (Test-Path (Join-Path $src 'msg.js'))) { throw "run this script from the repo clone (msg.js not found next to it)" }

# --- Node.js ---------------------------------------------------------
# broker.js/msg.js are stdlib-only and their newest syntax is ?. / ?? (Node 14+),
# but 18 is the floor the agent CLIs themselves require, so demand that and keep
# one number to reason about. Everything is run as `node <file>`, so PATH is what matters.
$minNodeMajor = 18
if ($SkipNodeCheck) {
    Write-Host "Skipping the Node check (-SkipNodeCheck)." -ForegroundColor Yellow
}
else {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        throw "Node.js is not on PATH. Install Node $minNodeMajor+ (winget install OpenJS.NodeJS.LTS, or https://nodejs.org), reopen the shell, then re-run."
    }
    $nodeVer = & node -v          # e.g. v22.11.0
    if ($nodeVer -notmatch '^v(\d+)\.') { throw "could not parse 'node -v' output: '$nodeVer'" }
    if ([int]$Matches[1] -lt $minNodeMajor) {
        throw "Node $nodeVer is too old - need $minNodeMajor or newer (or re-run with -SkipNodeCheck to install regardless)."
    }
    Write-Host "Node $nodeVer ($($node.Source))" -ForegroundColor DarkGray
}

# home     = agent's config dir under the user home (also the detection marker)
# tools    = where msg.js + broker.js go
# kind     = skill (Claude Code skill dir) | agents (markdown instruction file)
# file     = instruction file name, for kind=agents
# probe    = command name on PATH; the config dir existing also counts as installed
$known = @(
    @{ name = 'claude'; probe = 'claude'; home = '.claude'; tools = '.claude\skills\claude-msg'; kind = 'skill' }
    @{ name = 'codex' ; probe = 'codex' ; home = '.codex' ; tools = '.codex\claude-msg' ; kind = 'agents'; file = 'AGENTS.md' }
    @{ name = 'gemini'; probe = 'gemini'; home = '.gemini'; tools = '.gemini\claude-msg'; kind = 'agents'; file = 'GEMINI.md' }
)

function Test-AgentInstalled($a) {
    if (Get-Command $a.probe -ErrorAction SilentlyContinue) { return $true }
    return (Test-Path (Join-Path $UserHome $a.home))
}

# The instruction body, with <install path> resolved to this target's msg.js.
# Everything above the template's first --- is the "paste me" note; drop it.
function Get-InstructionBody($msgPath) {
    # -Encoding UTF8 matters: PS 5.1 would otherwise read the BOM-less template as ANSI and mangle its dashes
    $tpl = Get-Content (Join-Path $src 'AGENTS-template.md') -Raw -Encoding UTF8
    $body = ($tpl -split "(?m)^---\s*$", 2)[1].Trim()
    return $body.Replace('<install path>', $msgPath)
}

# Idempotent: rewrite our marked block if it is already there, else append.
function Set-MsgBusBlock($file, $body) {
    $begin = '<!-- claude-msg:begin -->'
    $end = '<!-- claude-msg:end -->'
    $block = "$begin`n$body`n$end"
    $old = if (Test-Path $file) { Get-Content $file -Raw -Encoding UTF8 } else { '' }
    if ($old -match [regex]::Escape($begin)) {
        $pattern = "(?s)$([regex]::Escape($begin)).*?$([regex]::Escape($end))"
        $new = [regex]::Replace($old, $pattern, { $block })
    }
    else {
        $new = ("$($old.TrimEnd())`n`n$block").TrimStart()
    }
    Set-Content -Path $file -Value $new -Encoding utf8
}

function Copy-Tools($dest, [string[]]$files) {
    if ($DryRun) { Write-Host "  would copy $($files -join ', ') -> $dest" -ForegroundColor DarkGray; return }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    foreach ($f in $files) { Copy-Item (Join-Path $src $f) (Join-Path $dest (Split-Path $f -Leaf)) -Force }
}

# --- pick targets ----------------------------------------------------
if ($Agent -contains 'auto') {
    $targets = @($known | Where-Object { Test-AgentInstalled $_ })
    if (-not $targets) {
        Write-Host "No known agent CLI detected - falling back to a generic install." -ForegroundColor Yellow
        $Agent = @('other')
    }
}
if ($Agent -notcontains 'auto') {
    $targets = @($known | Where-Object { $Agent -contains $_.name })
    if ($Agent -contains 'other') {
        $targets += @{ name = 'other'; home = '.claude-msg'; tools = '.claude-msg'; kind = 'agents'; file = 'AGENTS.md' }
    }
}

Write-Host "Installing from $src for: $(($targets | ForEach-Object { $_.name }) -join ', ')" -ForegroundColor Cyan

# --- install ---------------------------------------------------------
$brokerForConfig = $null
foreach ($t in $targets) {
    $dest = Join-Path $UserHome $t.tools
    if ($t.kind -eq 'skill') {
        Copy-Tools $dest @('msg-bus-skill\SKILL.md', 'msg.js', 'broker.js')
        Write-Host "[$($t.name)] skill -> $dest" -ForegroundColor Green
    }
    else {
        Copy-Tools $dest @('msg.js', 'broker.js')
        $file = Join-Path $UserHome "$($t.home)\$($t.file)"
        if ($DryRun) { Write-Host "  would update $file (claude-msg block)" -ForegroundColor DarkGray }
        else { Set-MsgBusBlock $file (Get-InstructionBody (Join-Path $dest 'msg.js')) }
        Write-Host "[$($t.name)] tools -> $dest, instructions -> $file" -ForegroundColor Green
        if ($t.name -eq 'other') { Write-Host "  paste that file's claude-msg block into your agent's system instructions." -ForegroundColor Yellow }
    }
    if (-not $brokerForConfig) { $brokerForConfig = Join-Path $dest 'broker.js' }
}

# --- config (claude-split.ps1 / Start-ClaudeBroker read this) --------
# Never downgrade an existing split install; just refresh the clone dir.
$cfgPath = Join-Path $UserHome '.claude-msgbus.json'
$cfg = if (Test-Path $cfgPath) { try { Get-Content $cfgPath -Raw | ConvertFrom-Json } catch { $null } } else { $null }
if (-not $DryRun -and -not ($cfg -and $cfg.mode -eq 'split')) {
    @{
        mode   = 'skill'
        source = $src
        base   = Join-Path $UserHome '.claude-split'
        broker = $brokerForConfig
        port   = if ($cfg -and $cfg.port) { [int]$cfg.port } else { 8787 }
    } | ConvertTo-Json | Set-Content -Path $cfgPath -Encoding utf8
    Write-Host "Config -> $cfgPath" -ForegroundColor DarkGray
}

Write-Host "Done. Start the broker with: node `"$brokerForConfig`"" -ForegroundColor Cyan
Write-Host "For the PowerShell shortcuts (msg / Start-ClaudeBroker), source the launcher too:" -ForegroundColor Cyan
Write-Host "  . `"$src\claude-split.ps1`"      # put this line in `$PROFILE to keep them" -ForegroundColor DarkGray
