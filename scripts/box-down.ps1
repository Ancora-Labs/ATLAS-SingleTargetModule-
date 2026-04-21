# BOX DOWN — gracefully stops daemon, then kills dashboard
# Usage: pwsh -NoProfile -File scripts/box-down.ps1

$Root = (Get-Item $PSScriptRoot).Parent.FullName
Set-Location $Root

# --- 1. Graceful daemon stop via CLI ---
Write-Host "[box-down] sending stop request to daemon..."
$stopResult = & node --import tsx src/cli.ts stop 2>&1
Write-Host "[box-down] $stopResult"

# Wait up to 6 seconds for daemon to exit cleanly
$daemonPidFile = "state/daemon.pid"
if (Test-Path $daemonPidFile) {
    $daemonPid = [int](Get-Content $daemonPidFile -Raw).Trim()
    $waited = 0
    while ($waited -lt 6000) {
        if (-not (Get-Process -Id $daemonPid -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 500
        $waited += 500
    }
    # Force kill if still alive
    if (Get-Process -Id $daemonPid -ErrorAction SilentlyContinue) {
        Stop-Process -Id $daemonPid -Force -ErrorAction SilentlyContinue
        Write-Host "[box-down] daemon force-killed (pid=$daemonPid)"
    } else {
        Write-Host "[box-down] daemon stopped cleanly"
    }
    Remove-Item $daemonPidFile -ErrorAction SilentlyContinue
}

# --- 2. Stop dashboard ---
# Try by saved PID first
$dashPidFile = "state/dashboard.pid"
if (Test-Path $dashPidFile) {
    $dashPid = [int](Get-Content $dashPidFile -Raw).Trim()
    Stop-Process -Id $dashPid -Force -ErrorAction SilentlyContinue
    Remove-Item $dashPidFile -ErrorAction SilentlyContinue
    Write-Host "[box-down] dashboard stopped (pid=$dashPid)"
}

# Also kill by port 8787 as fallback
$c = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($c) {
    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
    Write-Host "[box-down] dashboard killed by port 8787"
}

Write-Host ""
Write-Host "BOX is down."
