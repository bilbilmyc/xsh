param(
  [string]$LibraryPath = 'target\release\xsh-rdp-native.dll'
)
$ErrorActionPreference = 'Stop'
$SourceLibrary = (Resolve-Path -LiteralPath $LibraryPath).Path
$ProbeDirectory = Join-Path ([IO.Path]::GetTempPath()) ("xsh-rdp-bundle-" + [Guid]::NewGuid().ToString('N'))
$ProbeDirectory = [IO.Path]::GetFullPath($ProbeDirectory)
$TemporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $ProbeDirectory.StartsWith($TemporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw '原生库验证目录不在预期临时目录中。'
}
[IO.Directory]::CreateDirectory($ProbeDirectory) | Out-Null
$ProbeLibrary = Join-Path $ProbeDirectory 'xsh-rdp-native.dll'
Copy-Item -LiteralPath $SourceLibrary -Destination $ProbeLibrary

if (-not ('XshBundledRdpProbe' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class XshBundledRdpProbe {
  [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr LoadLibraryEx(string name, IntPtr file, uint flags);
  [DllImport("kernel32", CharSet = CharSet.Ansi, ExactSpelling = true)]
  public static extern IntPtr GetProcAddress(IntPtr module, string name);
  [DllImport("kernel32")]
  public static extern bool FreeLibrary(IntPtr module);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
  public delegate int Initialize();
}
'@
}
$Module = [IntPtr]::Zero
try {
  # Only this otherwise empty directory and Windows system libraries may
  # satisfy imports. PATH and globally installed protocol libraries are unused.
  $Module = [XshBundledRdpProbe]::LoadLibraryEx($ProbeLibrary, [IntPtr]::Zero, 0x900)
  if ($Module -eq [IntPtr]::Zero) {
    throw "内置 RDP 库无法独立加载，Win32 错误：$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  $InitializeAddress = [XshBundledRdpProbe]::GetProcAddress($Module, 'xsh_rdp_global_init')
  if ($InitializeAddress -eq [IntPtr]::Zero) { throw '缺少内置 RDP 初始化入口。' }
  if ([XshBundledRdpProbe]::GetProcAddress($Module, 'xsh_rdp_test_peer_run') -ne [IntPtr]::Zero) {
    throw '发布库错误地包含了测试 peer，请使用默认 feature 构建安装包。'
  }
  $Initialize = [Runtime.InteropServices.Marshal]::GetDelegateForFunctionPointer($InitializeAddress, [XshBundledRdpProbe+Initialize])
  if ($Initialize.Invoke() -ne 1) { throw '内置 RDP 初始化失败。' }
  Write-Host "PASS: RDP 原生库可单独加载并初始化，未依赖 PATH 或外部协议 DLL：$SourceLibrary"
} finally {
  if ($Module -ne [IntPtr]::Zero) { [XshBundledRdpProbe]::FreeLibrary($Module) | Out-Null }
  # The resolved absolute directory was checked against the temporary root
  # before creation and is owned only by this invocation.
  Remove-Item -LiteralPath $ProbeDirectory -Recurse -Force
}
