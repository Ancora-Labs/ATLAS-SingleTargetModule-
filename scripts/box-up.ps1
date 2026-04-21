# BOX UP — starts dashboard + daemon in background (detached, survives terminal close)
# Usage: pwsh -NoProfile -File scripts/box-up.ps1

$Root = (Get-Item $PSScriptRoot).Parent.FullName
Set-Location $Root

# Kill stale dashboard on port 8787
$c = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($c) {
    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
    Write-Host "[box-up] killed stale dashboard on port 8787"
}

# Start dashboard (detached, hidden window)
$dash = Start-Process `
    -FilePath "node" `
    -ArgumentList "--import", "tsx", "src/dashboard/live_dashboard.ts" `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -PassThru
$dash.Id | Out-File -FilePath "state/dashboard.pid" -Force -Encoding ascii
Write-Host "[box-up] dashboard started  pid=$($dash.Id)  http://localhost:8787"

# Start daemon (detached, hidden window)
$daemon = Start-Process `
    -FilePath "node" `
    -ArgumentList "--import", "tsx", "src/cli.ts", "start" `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -PassThru
$daemon.Id | Out-File -FilePath "state/daemon.pid" -Force -Encoding ascii
Write-Host "[box-up] daemon started      pid=$($daemon.Id)"

Write-Host ""
Write-Host "BOX is running. Dashboard: http://localhost:8787"
Write-Host "To stop:  pwsh -NoProfile -File scripts/box-down.ps1"
Write-Host "     or:  npm run box:down"
