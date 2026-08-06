# sendkeys.ps1 — inject keystrokes into a split session's terminal window (zero token).
# Spawned by broker.js chat commands (/stop, /compact, /usage, /model, /plugin,
# /skills). Focuses the target window by HWND,
# sends the keys, then restores focus to whatever window was foreground before.
# Known cost: focus flicks away for ~0.3s. Known limit: Windows Terminal tabs share
# one HWND — run each split session in its own window for reliable targeting.
param(
    [Parameter(Mandatory = $true)][long]$Hwnd,
    [Parameter(Mandatory = $true)][string]$Keys,
    # Send {ENTER} after a pause: typing "/xxx" opens Claude Code's slash menu and
    # Enter picks the highlighted candidate — the pause lets the filtering settle.
    [switch]$Enter
)

$sig = @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
'@
if (-not ('ClaudeSplit.SendKeysNative' -as [type])) {
    Add-Type -MemberDefinition $sig -Name SendKeysNative -Namespace ClaudeSplit
}

$target = [IntPtr]$Hwnd
if (-not [ClaudeSplit.SendKeysNative]::IsWindow($target)) {
    Write-Error "hwnd $Hwnd is not a window (session closed?)"
    exit 1
}

$prev = [ClaudeSplit.SendKeysNative]::GetForegroundWindow()

# Tap Alt (press+release): releases the foreground lock so SetForegroundWindow
# succeeds from a background process — the standard workaround.
function Tap-Alt {
    [ClaudeSplit.SendKeysNative]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    [ClaudeSplit.SendKeysNative]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
}

# Focus the target: SetForegroundWindow is blocked by the foreground lock when the
# caller is a background process, so verify by reading the actual foreground window
# and fall back to SwitchToThisWindow (the Alt+Tab path, not lock-restricted).
function Focus-Window([IntPtr]$h) {
    Tap-Alt
    [ClaudeSplit.SendKeysNative]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 100
    if ([ClaudeSplit.SendKeysNative]::GetForegroundWindow() -eq $h) { return $true }
    [ClaudeSplit.SendKeysNative]::SwitchToThisWindow($h, $true)
    Start-Sleep -Milliseconds 100
    return ([ClaudeSplit.SendKeysNative]::GetForegroundWindow() -eq $h)
}

if (-not (Focus-Window $target)) {
    Write-Error "could not focus target window (hwnd $Hwnd)"
    exit 1
}
Start-Sleep -Milliseconds 50
$shell = New-Object -ComObject WScript.Shell
$shell.SendKeys($Keys)
if ($Enter) { Start-Sleep -Milliseconds 200; $shell.SendKeys('{ENTER}') }
Start-Sleep -Milliseconds 100

# Restore focus; failure here is cosmetic (focus stays on the target), don't error.
if ($prev -ne [IntPtr]::Zero) { Focus-Window $prev | Out-Null }
