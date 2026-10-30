param([int]$Port = 18100)

# Use the script's own folder - avoids non-ASCII paths inside the script.
$ServerDir = $PSScriptRoot
$MainJs    = Join-Path $ServerDir "main.mjs"

# 1) kill whatever listens on the port
$listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
foreach ($l in $listeners) {
    try {
        Stop-Process -Id $l.OwningProcess -Force -ErrorAction Stop
        Write-Output ("stopped old pid=" + $l.OwningProcess)
    } catch {
        Write-Output ("stop failed pid=" + $l.OwningProcess + " : " + $_.Exception.Message)
    }
}

# 2) wait for port release
for ($i = 0; $i -lt 40; $i++) {
    if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 250
}
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    Write-Output "ERROR: port still in use"
    exit 1
}

# 3) clean stray main.mjs processes
$alive = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'main\.mjs' })
foreach ($p in $alive) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; Write-Output ("cleaned pid=" + $p.ProcessId) } catch {}
}

# 4) start one detached instance
$env:LEGECLOX_PORT = "$Port"
$env:LEGECLOX_LATENCY_MS = "0"
$proc = Start-Process -FilePath "node" -ArgumentList $MainJs -WorkingDirectory $ServerDir -WindowStyle Hidden -PassThru
Write-Output ("spawned node pid=" + $proc.Id)

# 5) wait until ready
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($c) { Write-Output ("OK server ready pid=" + $c.OwningProcess); exit 0 }
}
Write-Output "ERROR: start failed"
exit 1
