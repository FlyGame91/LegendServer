# Start the local server without a visible console window.
$ServerDir = $PSScriptRoot
$MainJs    = Join-Path $ServerDir "main.mjs"
$OutLog    = Join-Path $ServerDir "_server_run.log"
$ErrLog    = Join-Path $ServerDir "_server_err.log"

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "node.exe" }

Start-Process -FilePath $node -ArgumentList $MainJs -WorkingDirectory $ServerDir -WindowStyle Hidden `
  -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog
