$ErrorActionPreference = 'Stop'

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $RootDir

if ($env:OS -ne 'Windows_NT') {
  Write-Error '此脚本只能在 Windows 上运行。请使用 Windows 电脑或 GitHub Actions 构建。'
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Error '未找到 pnpm。请先执行：corepack enable；corepack prepare pnpm@11.10.0 --activate'
}

pnpm install --frozen-lockfile
pnpm --filter desktop exec tauri build --bundles nsis,msi

Write-Host ''
Write-Host 'Windows 构建完成：' -ForegroundColor Green
Write-Host "  $RootDir\target\release\bundle\nsis"
Write-Host "  $RootDir\target\release\bundle\msi"
