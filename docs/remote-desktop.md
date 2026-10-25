# 内置远程桌面

XSH 在自己的标签和 SSH 会话面板内连接、显示与操作 VNC 和 RDP。远程桌面功能不会启动 mstsc、VNC Viewer、Remmina、FreeRDP 命令行客户端或外部网关服务。

## 连接与操作

创建 VNC / RDP 会话，选择直接连接目标，或通过 SSH 隧道访问目标。SSH 主机密钥与远程桌面服务器证书是不同的信任步骤。未通过验证的 RDP 证书需要核对后确认，确认只适用于本次连接。

查看区域提供键盘、鼠标、Ctrl+Alt+Delete、适应窗口、100% 显示、全屏、重新连接和文本剪贴板操作。收到远端剪贴板时，点击复制按钮后才写入本地剪贴板。RDP 支持 IME 提交 Unicode 文本，也可用“发送文本”输入内容。

RDP 会回传远端鼠标形状、热点、隐藏和默认指针状态。指针随画面缩放，较大的图案缩至浏览器支持的 128 像素内；服务端重复设置同一缓存图案不会重复传输像素。浏览器无法强行移动本机系统鼠标，远端的指针定位消息不会改变本机位置。

剪贴板和动态分辨率控件按 RDP 通道的实际协商结果启用；服务器尚未开放时，控件禁用并显示说明。分辨率可以随窗口调整，也可选择 720p、900p、1080p、1440p 或 4K 预设；预设受服务器通报的像素面积限制。底部只显示实际收到的桌面尺寸，发送请求后等待服务器确认。分辨率或剪贴板请求被拒绝时给出提示，会话继续运行。读取本地剪贴板或填写发送文本期间发生重连，会作废该操作，避免发到新的桌面连接。

直接连接不创建 SSH 会话。SSH 隧道由 XSH 的 SSH 会话拥有；关闭桌面会释放协议连接及 VNC 的临时 WebSocket 桥，停止隧道或断开 SSH 则会关闭其承载的连接。

## 内置组件

| 组件 | 版本 / 固定点 | 用途 |
| --- | --- | --- |
| noVNC | 1.7.0，pnpm-lock.yaml | WebView 内的 VNC / RFB 客户端 |
| FreeRDP / WinPR | 3.32.2，commit `97eff6ddfbbfaa8e42a126d362686bd001ff8bdc` | RDP 协议、NLA、图形解码、输入和虚拟通道 |
| OpenSSL | 3.6.3，Cargo.lock 的 openssl-src | 原生 RDP 库内静态链接的 TLS 与加密实现 |
| uriparser | 1.0.2，commit `9b2bed92f5deecf740819f9bf27724bee2fe9c12` | WinPR 使用的 URI / 证书名称解析，静态内置 |

FreeRDP 源码归档随仓库保存，并在构建时校验 SHA-256：`e1b0bc1c1302f065d512525598da92c269f773bf5f1640439e2f1be6fff035d6`。XSH 的适配代码位于 `crates/xsh-rdp/native`；上游源码未修改。

FreeRDP、WinPR、OpenSSL、OpenSSL provider 和 uriparser 静态链接为一个 XSH 原生库。配置仅启用 cliprdr、drdynvc、disp、rdpgfx 客户端通道，并验证这些通道已编译进库。Windows 将 `xsh-rdp-native.dll` 安装在应用程序旁，macOS 将 `libxsh-rdp-native.dylib` 安装在应用包的 `Contents/Frameworks`。许可证与来源说明随包放在 `licenses` 目录。

## 开发与打包

开发机需要 Rust stable、Node.js 22+、pnpm、CMake 3.18+ 和 C/C++ 编译工具链。构建 OpenSSL 还需要 Perl；Windows 使用 Strawberry Perl 的 MSWin32 版本，不能使用 Git Bash 自带的 Unix Perl。macOS 使用 Xcode Command Line Tools。首次构建会编译完整原生依赖，后续由 Cargo / CMake 增量缓存。

```powershell
# Windows：先确保 Visual Studio C++、CMake 和 Strawberry Perl 可用。
pnpm install --frozen-lockfile
pnpm run build:windows
```

```bash
# macOS
pnpm install --frozen-lockfile
pnpm run build:macos:personal
```

`xsh-rdp/build.rs` 通过 Cargo links metadata 提供实际原生库路径，桌面 build.rs 将其放入被 Git 忽略的 `native-runtime` 暂存目录。平台 Tauri 配置负责将相同库放入安装包；开发运行与 Rust 单元测试使用 Cargo 输出目录内的副本。

`XSH_OPENSSL_ROOT` 可指定开发机预先编译的静态 OpenSSL 安装目录，`XSH_FREERDP_SOURCE` 可用于调试本机 FreeRDP 源码。发布应使用默认的固定来源；覆盖环境变量会改变开发者实际采用的依赖。这些构建工具与源码覆盖变量不是终端用户的运行要求。

## 资源与生命周期

- 同时最多八个 RDP 会话；每个会话的输入队列最多六十四项，鼠标移动按显示帧合并。
- 桌面每轴 200–8192 像素，总像素数不超过 4096×2160。
- RDP 一次仅允许一帧等待绘制确认。跳过的刷新会触发下一次完整快照，避免只保留最后一块脏区域。
- 文本剪贴板最多 1 MiB，单次 Unicode 输入最多 64 KiB。
- RDP 指针图案每轴最多 384 像素，以独立、有边界检查的二进制包发送，不占用画面绘制确认额度。
- 每个 VNC 桥最多十六个连接；TCP 连接与 WebSocket 握手各有十秒超时。随机 token 与来源检查发生在连接目标之前。
- 取消会中止尚在连接的 RDP 引擎、证书等待、VNC 握手与代理连接；关闭操作会等待已拥有的后端任务退出。

## 当前功能边界

这一版覆盖单桌面显示和常用交互。尚未接入 RDP 音频、麦克风、打印机、磁盘 / USB / 智能卡重定向、RemoteApp、多显示器或 RD Gateway。剪贴板支持文本，不支持文件或图片。RDP 未启用额外 H.264 / FFmpeg 编解码器；图形兼容性及高刷新桌面性能需在实际目标环境继续验证。

SSH 隧道目前复用已有 SSH 生命周期及隐藏 PTY。后续可以增加仅转发的 SSH 连接模式，减少服务器不允许 shell 时的限制；VNC / RDP 的直接连接不依赖该路径。

## 验证

后端包含真实原生 RDP 初始握手与取消测试、二进制帧打包与流控测试、VNC 桥的双向代理与任务关闭测试，以及 token / 来源拒绝测试。前端包含帧格式、边界、坐标、扫描码与滚轮编码测试。

可选 `test-peer` feature 在测试进程内建立原生 RDP 服务端。它已在 Windows 验证 TLS、同意 / 拒绝自签名证书、实际像素解码、键盘扫描码 / Unicode、鼠标与 Ctrl+Alt+Delete 的收发、连接关闭，以及原生 CLIPRDR 中文 / emoji 双向文本、DISP 协商 / 单显示器布局 / 桌面实际改尺寸、自定义 / 隐藏 / 默认 / 缓存指针。

NLA 夹具要求服务端仅接受 NLA，并在独立测试进程中使用 WinPR SSPI 与临时 NTLM 哈希回调。正确密码、`域名\用户名` 和错误密码均验证实际认证回调被调用。这个进程仅用于隔离测试库的全局 SSPI 初始化状态，不是产品运行所需的辅助程序；默认发布库不包含测试服务端。测试不创建系统账号、不启用操作系统 RDP 服务，也不代替真实 Windows / xrdp、Windows 原生 SSPI / 域认证或 RDPGFX 兼容性验证。

2026-10-25 补充了一台真实 Windows 虚拟机测试：生产 `RdpManager` 与最终安装包中的 DLL 完成原生 SSPI / NLA 登录、真实桌面解码、指针更新、鼠标 / Shift 输入发送，以及 1280×720 → 1024×768 → 1280×720 的实际分辨率往返切换。证书与本机 mstsc 保存的 SHA-256 一致。剪贴板通道协商成功，未改写远端剪贴板；真实文本双向传输、AD / xrdp 和长时间稳定性尚未验证。详见 [本机构建验证](local-build-validation-remote-desktop-2026-10-25.md)。

```bash
cargo test -p xsh-rdp --features test-peer
```

浏览器验证使用本地 RFB 服务器实际测试 noVNC 的像素解码、键盘 / 鼠标、Ctrl+Alt+Delete 与双向文本剪贴板，以及 RFB 3.8 VNC Authentication 的 DES 挑战响应、正确 / 错误密码和认证重试；RDP 的浏览器验证使用受控 IPC 事件检查证书确认、Canvas 完整帧与脏矩形、绘制 ACK、输入释放、指针图案 / 缩放 / 隐藏、分辨率回传、服务器能力 / 像素预算、重连时作废旧剪贴板操作、可选操作失败后会话保留与关闭。受控 IPC 测试不能替代真实 RDP 服务端兼容性验证。

Windows 与 macOS 的 CI 均构建并检查内置库；是否实际在某个平台通过构建，以该次 CI 结果为准。发布前仍需对实际使用的 Windows RDP、xrdp 和 VNC 服务端进行实机验证。
