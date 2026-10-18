<#
.SYNOPSIS
  下载并解压便携版 xPack OpenOCD（本仓库故意不提交这 7.6 MB 第三方二进制）。

.DESCRIPTION
  从官方 xPack OpenOCD release 下载 win32-x64 zip（约 3.2 MB），校验 SHA256 后解压到
  backend\tools\openocd\。只需运行一次；已存在时跳过，加 -Force 可强制重新下载。

  解压后的固定布局（后端 toolchain.js 会按这个路径找）：
    backend\tools\openocd\xpack-openocd-<version>\bin\openocd.exe

.PARAMETER Destination
  解压目标目录。默认 <仓库>\backend\tools\openocd。

.PARAMETER Force
  强制重新下载并解压（覆盖已有文件）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File backend\scripts\fetch-openocd.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File backend\scripts\fetch-openocd.ps1 -Force
#>
[CmdletBinding()]
param(
  [string]$Destination,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
# PS 5.1 下进度条会让 Invoke-WebRequest 慢十倍；TLS 1.2 是 GitHub 下载所需
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

$Version = '0.12.0-7'
$PkgName = "xpack-openocd-$Version"
$Asset   = "$PkgName-win32-x64.zip"
$Url     = "https://github.com/xpack-dev-tools/openocd-xpack/releases/download/v$Version/$Asset"
# 来自官方 release 的 .sha 资产（xpack-openocd-0.12.0-7-win32-x64.zip.sha）
$Sha256  = '6bfd3c97135aafef8affc9af1acf34fd0e2b9ca26044506f6abd7f95b7630052'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # <repo>
$backend  = Join-Path $repoRoot 'backend'
if (-not (Test-Path (Join-Path $backend 'server\server.js'))) {
  throw "没有找到 backend\server\server.js —— 这个脚本应放在 <仓库>\backend\scripts\ 下。当前推断的仓库根：$repoRoot"
}
if (-not $Destination) { $Destination = Join-Path $backend 'tools\openocd' }
$downloadDir = Join-Path $backend 'tools\_download'
$zipPath     = Join-Path $downloadDir $Asset
$pkgDir      = Join-Path $Destination $PkgName
$exePath     = Join-Path $pkgDir 'bin\openocd.exe'

Write-Host ''
Write-Host '  stm32-workbench · 便携 OpenOCD 准备' -ForegroundColor Cyan
Write-Host ('  ' + ('─' * 60))
Write-Host "  版本   xPack OpenOCD $Version (win32-x64)"
Write-Host "  目标   $Destination"
Write-Host ''

if ((Test-Path $exePath) -and -not $Force) {
  Write-Host "  已存在，跳过下载：$exePath" -ForegroundColor Green
  Write-Host '  （需要重新下载请加 -Force）'
  Write-Host ''
  exit 0
}

New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
if ($Force -and (Test-Path $pkgDir)) {
  Write-Host '  -Force：先删掉旧的解压目录…'
  Remove-Item -Recurse -Force $pkgDir
}

function Get-Sha256([string]$path) {
  return (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# 已有 zip 也校验一次；不对就重下
if ((Test-Path $zipPath) -and -not $Force) {
  $h = Get-Sha256 $zipPath
  if ($h -ne $Sha256) {
    Write-Host "  已有 zip 校验失败（$h），重新下载" -ForegroundColor Yellow
    Remove-Item -Force $zipPath
  }
}

if (-not (Test-Path $zipPath)) {
  Write-Host "  下载 $Url"
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $zipPath -TimeoutSec 300
  } catch {
    if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
    throw "下载失败：$($_.Exception.Message)。可以手动下载 $Url 放到 $downloadDir 后重试。"
  }
}

$actual = Get-Sha256 $zipPath
if ($actual -ne $Sha256) {
  Remove-Item -Force $zipPath
  throw "SHA256 校验失败：期望 $Sha256，实际 $actual。文件已删除，请重试或手动下载。"
}
Write-Host "  SHA256 校验通过（$Sha256）" -ForegroundColor Green

Write-Host '  解压…'
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
Expand-Archive -Path $zipPath -DestinationPath $Destination -Force

if (-not (Test-Path $exePath)) {
  throw "解压后没有找到 openocd.exe：$exePath。解压目录结构可能与预期不同，请检查 $Destination。"
}

$files = (Get-ChildItem $pkgDir -Recurse -File | Measure-Object).Count
Write-Host ''
Write-Host "  完成：$exePath" -ForegroundColor Green
Write-Host "  目录  $pkgDir（$files 个文件）"
Write-Host '  下一步：打开 DSH 工作台 → 选 Keil 工程 → 烧录；或直接运行 node backend/server/server.js 自检。'
Write-Host ''
