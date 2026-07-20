param(
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $RootDir

# aws-lc-sys 0.43.0 ships prebuilt x86_64 NASM objects. Use them by default
# so a local Windows build does not depend on NASM being installed globally.
if (-not $env:AWS_LC_SYS_PREBUILT_NASM) {
  $env:AWS_LC_SYS_PREBUILT_NASM = '1'
}

if ($env:OS -ne 'Windows_NT') {
  throw '此脚本只能在 Windows 上运行。'
}

$PnpmCommand = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue).Source
if (-not $PnpmCommand) {
  throw '未找到 pnpm.cmd。请先执行：corepack enable；corepack prepare pnpm@11.10.0 --activate'
}

if (-not (Get-Command rustc -ErrorAction SilentlyContinue) -or -not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  throw '未找到 Rust 工具链。请安装 rustup，并确保已安装 stable-x86_64-pc-windows-msvc。'
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw '未找到 Node.js。请安装 Node.js 22 或更高版本。'
}

$NodeVersion = (node --version).TrimStart('v')
$NodeMajor = [int]($NodeVersion.Split('.')[0])
if ($NodeMajor -lt 22) {
  throw "Node.js 版本过低：$NodeVersion。项目要求 Node.js 22 或更高版本。"
}

if (-not $SkipInstall) {
  Write-Host '安装/校验依赖...' -ForegroundColor Cyan
  & $PnpmCommand install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm install 失败，退出码：$LASTEXITCODE"
  }
}

Write-Host '构建 Windows 安装包...' -ForegroundColor Cyan
& $PnpmCommand --filter desktop exec tauri build --bundles nsis,msi
if ($LASTEXITCODE -ne 0) {
  throw "Tauri Windows 构建失败，退出码：$LASTEXITCODE"
}

$NsisDir = Join-Path $RootDir 'target\release\bundle\nsis'
$MsiDir = Join-Path $RootDir 'target\release\bundle\msi'
$NsisPackages = @(Get-ChildItem -Path $NsisDir -Filter '*.exe' -File -ErrorAction SilentlyContinue)
$MsiPackages = @(Get-ChildItem -Path $MsiDir -Filter '*.msi' -File -ErrorAction SilentlyContinue)

if ($NsisPackages.Count -eq 0 -or $MsiPackages.Count -eq 0) {
  throw "构建命令执行完毕，但没有找到预期的安装包。请检查：`n  $NsisDir`n  $MsiDir"
}

Write-Host ''
Write-Host 'Windows 构建完成：' -ForegroundColor Green
foreach ($Package in $NsisPackages + $MsiPackages) {
  Write-Host "  $($Package.FullName)"
}
Write-Host ''
Write-Host '如果只想重新打包而不重新安装依赖，可执行：' -ForegroundColor DarkGray
Write-Host '  powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1 -SkipInstall' -ForegroundColor DarkGray
