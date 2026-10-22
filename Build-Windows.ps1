param([string]$Sdk = $env:PREMIERE_CPP_SDK)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Run this script on Windows x64.' }
if (-not (Get-Command cl -ErrorAction SilentlyContinue)) { throw 'Open x64 Developer PowerShell for VS 2022, then run this script again.' }
if (-not $Sdk) { throw 'Pass -Sdk with the Premiere C++ SDK folder path.' }
$env:PREMIERE_CPP_SDK = (Resolve-Path -LiteralPath $Sdk).Path
foreach ($tool in @('node', 'npm', 'python')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Required tool not found: $tool" }
}
if (-not $env:MASK_TRACKER_ISCC -and -not (Get-Command ISCC.exe -ErrorAction SilentlyContinue)) {
    $candidates = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe")
    $env:MASK_TRACKER_ISCC = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $env:MASK_TRACKER_ISCC) { throw 'Install Inno Setup 6.3+ before building the EXE installer.' }
}
Push-Location (Join-Path $PSScriptRoot 'mask-motion')
try {
    & python (Join-Path $PSScriptRoot 'native\test-installers.py')
    if ($LASTEXITCODE -ne 0) { throw 'Installer tests failed.' }
    & npm.cmd run check
    if ($LASTEXITCODE -ne 0) { throw 'JavaScript syntax check failed.' }
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Windows build failed.' }
} finally { Pop-Location }
