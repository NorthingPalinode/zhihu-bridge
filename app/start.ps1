# Zhihu Bridge launcher for Windows PowerShell. Usage: .\start.ps1 [--smoke] [--port 9000] [--offline]
# If the execution policy blocks scripts, allow it for this process only:
#   powershell -ExecutionPolicy Bypass -File .\start.ps1
# All logic lives in start.py (binds 127.0.0.1 only).
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
$launcher = Join-Path $PSScriptRoot "start.py"
if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 $launcher @args
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    & python $launcher @args
} else {
    Write-Error "Python 3.10+ not found. Install Python (3.12 or 3.13 recommended) and tick Add python.exe to PATH."
    exit 1
}
exit $LASTEXITCODE
