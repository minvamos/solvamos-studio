# Install official pay CLI into tools/pay (Windows — avoids npx unzip dependency)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Dest = Join-Path $Root 'tools\pay'
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

Write-Host 'Fetching @solana/pay package to locate Windows binary…'
$tmp = Join-Path $env:TEMP ("pay-install-" + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  Push-Location $tmp
  npm pack @solana/pay --silent | Out-Null
  $tgz = Get-ChildItem -Filter '*.tgz' | Select-Object -First 1
  if (-not $tgz) { throw 'npm pack @solana/pay produced no tarball' }
  tar -xf $tgz.Name
  $zip = Get-ChildItem -Path (Join-Path $tmp 'package\bin') -Filter 'pay-*-windows-msvc.zip' -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $zip) {
    npm install @solana/pay --no-save --prefix $tmp 2>$null
    $zip = Get-ChildItem -Path $tmp -Recurse -Filter 'pay-*-windows-msvc.zip' |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
  }
  if (-not $zip) { throw 'pay Windows zip not found in package' }
  Expand-Archive -Path $zip.FullName -DestinationPath $Dest -Force
  $exe = Join-Path $Dest 'pay.exe'
  if (-not (Test-Path $exe)) { throw "pay.exe missing after extract at $Dest" }
  & $exe --version
  Write-Host "Installed: $exe"
  Write-Host 'Optional: copy System32\curl.exe → tools\pay\curl.exe if you need `pay curl` POST'
  Write-Host 'Next: $env:PAY_INTERNAL_SECRET="dev-pay-internal"; & .\tools\pay\pay.exe --sandbox server start pay\solvamos-provider.yml'
}
finally {
  Pop-Location -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
