$ErrorActionPreference = 'Stop'

if (-not (Get-Command cmake.exe -ErrorAction SilentlyContinue)) {
  throw '构建内置 RDP 需要 CMake 3.18 或更高版本。请安装 CMake 并加入 PATH。'
}

if (-not $env:XSH_OPENSSL_ROOT) {
  # Git for Windows' Unix Perl cannot build MSVC OpenSSL. Prefer Strawberry
  # when present, including on GitHub-hosted Windows runners.
  $StrawberryRoot = 'C:\Strawberry'
  if (Test-Path -LiteralPath "$StrawberryRoot\perl\bin\perl.exe") {
    $env:PATH = "$StrawberryRoot\perl\bin;$StrawberryRoot\c\bin;$env:PATH"
  }
  $NativePerlCommand = Get-Command perl.exe -ErrorAction SilentlyContinue
  if (-not $NativePerlCommand) {
    throw '构建内置 RDP 的 OpenSSL 需要 Strawberry Perl。安装后重新打开终端。'
  }
  # Carry the checked executable across shells; Git Bash changes PATH ordering.
  $env:PERL = $NativePerlCommand.Source
  $PerlPlatform = (& $env:PERL -e 'print $^O').Trim()
  if ($LASTEXITCODE -ne 0 -or $PerlPlatform -ne 'MSWin32') {
    throw '请使用 Windows 原生 Strawberry Perl（MSWin32），不要使用 Git Bash/MSYS Perl 构建 OpenSSL。'
  }
}
