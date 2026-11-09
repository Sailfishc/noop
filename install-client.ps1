# Installs the Remi client app, or updates it (Windows):
#   irm https://raw.githubusercontent.com/Sailfishc/noop/main/install-client.ps1 | iex
# $env:NOOP_CLIENT_BASE_URL  where the release assets are (default: the latest GitHub release)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"  # the progress bar slows downloads down a lot

$Base = if ($env:NOOP_CLIENT_BASE_URL) { $env:NOOP_CLIENT_BASE_URL } else { "https://github.com/Sailfishc/noop/releases/latest/download" }
$Asset = "remi-windows-x86_64.zip"
$Dir = Join-Path $env:LOCALAPPDATA "Programs\Remi"
$Work = Join-Path ([IO.Path]::GetTempPath()) ("remi-" + [IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $Work | Out-Null

try {
  Write-Host "Downloading $Asset"
  $Zip = Join-Path $Work $Asset
  Invoke-WebRequest -UseBasicParsing -Uri "$Base/$Asset" -OutFile $Zip
  $Sums = Join-Path $Work "sha256sums"
  Invoke-WebRequest -UseBasicParsing -Uri "$Base/sha256sums" -OutFile $Sums
  $Line = Get-Content $Sums | Where-Object { ($_ -split "\s+")[1] -replace "^\*", "" -eq $Asset } | Select-Object -First 1
  if (-not $Line -or ($Line -split "\s+")[0] -ne (Get-FileHash -Algorithm SHA256 -Path $Zip).Hash) { throw "the checksum of $Asset does not match" }

  $Unpacked = Join-Path $Work "unpacked"
  Expand-Archive -Path $Zip -DestinationPath $Unpacked
  $Exe = Get-ChildItem -Path $Unpacked -Recurse -Filter "Remi.exe" | Select-Object -First 1
  if (-not $Exe) { throw "$Asset holds no Remi.exe" }

  # A running app locks its files.
  Get-Process -Name Remi -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Dir\*" } | Stop-Process -Force
  Start-Sleep -Milliseconds 500
  if (Test-Path $Dir) { Remove-Item -Recurse -Force $Dir }
  New-Item -ItemType Directory -Force -Path (Split-Path $Dir) | Out-Null
  Move-Item -Path $Exe.Directory.FullName -Destination $Dir

  $Shell = New-Object -ComObject WScript.Shell
  $Link = $Shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath("Programs")) "Remi.lnk"))
  $Link.TargetPath = Join-Path $Dir "Remi.exe"
  $Link.WorkingDirectory = $Dir
  $Link.Save()

  Write-Host "Installed $Dir"
  Write-Host ""
  Write-Host "Open Remi from the Start menu."
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Work
}
