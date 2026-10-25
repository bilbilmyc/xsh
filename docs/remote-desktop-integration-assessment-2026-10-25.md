# VNC / RDP 独立客户端集成评估

实施状态：已采用本报告的 FreeRDP 同进程库方向，完成内置查看区域和 Windows 打包；当前实现与验证范围见 [remote-desktop.md](remote-desktop.md)。下文保留选型时的评估，不作为当前功能清单。

评估日期：2026-10-25。对象为当前 XSH 工作区，目标平台以现有构建流程中的 Windows x64、macOS Apple Silicon 为准。

## 产品目标

用户只安装 XSH，即可在应用标签页中连接、显示和控制 VNC / RDP 桌面。连接、认证、输入、显示和断开均由应用内置实现完成。

- 远程桌面路径不启动 `mstsc`、VNC Viewer、Remmina 等外部客户端，也不启动随包附带的查看器可执行文件。
- 直连不要求 SSH；SSH 隧道是可选连接方式。
- 不要求用户部署额外的协议转换网关、Guacamole 或 websockify。
- 可以把协议库及其必需资源随应用分发。应用内部的本地 WebSocket、线程和 Rust 异步任务属于内部通信与执行机制。
- 远端主机仍需提供相应的 VNC / RDP 服务。现有 Tauri 系统运行时要求不在本次改造范围内。

结论：这个产品目标可行。建议 VNC 沿用现有内嵌方案完善，RDP 优先验证 FreeRDP 链接库集成，IronRDP 作为备选。RDP 需要新增应用内协议引擎，属于有独立验证和维护成本的后端功能。

## 当前代码距离目标还有多远

| 范围 | 当前证据 | 集成工作 |
| --- | --- | --- |
| 独立桌面会话、直连与隧道 | `RemoteDesktopKind`、`RemoteDesktopTransport` 已定义；会话编辑器已有对应选项 | 沿用保存的协议、地址、凭据与传输模式 |
| VNC 内嵌 | `RemoteDesktopPane` 导入 noVNC，经 Rust 本地 WebSocket / TCP 桥接连接 | 保留协议实现，完善认证提示、输入、剪贴板、分辨率和连接状态 |
| RDP | `open_remote_desktop_viewer` 最终调用 `mstsc` 或 `open rdp://…` | 使用内置协议库替换外部启动路径 |
| 自定义查看器 | 保存的 `viewerCommand` 可以使 VNC 退出内嵌模式，后端可以执行命令模板 | 从使用路径中移除；迁移旧配置时保留地址和凭据，但不再执行旧命令 |
| 自动启动 | `start_remote_desktop_automatically` 可以启动外部查看器 | 改为打开并连接应用内桌面 |
| 桌面生命周期 | 直连打开时即报告 `connected`；noVNC 的连接状态另存于 `inAppViewer` | 以实际协议连接事件为准，统一连接、认证、断开和错误状态 |
| 输入焦点 | 应用全局快捷键的远端优先判断目前识别 `.terminal-pane` | 将桌面焦点和快捷键归属纳入设计，并验证协议实现的事件处理不会与应用快捷键冲突 |
| SSH 隧道 | 桌面面板复用 `connectTerminal`；SSH 实现申请 PTY 和 Shell | 逐步提供只负责转发的 SSH 连接，避免桌面隧道要求远端允许 Shell |
| 桥接回收 | Rust 桥接已拥有监听器和连接任务，关闭时取消子任务 | 复用既有所有权和取消机制，新增 RDP 会话也遵循相同原则 |

代码依据：

- [桌面面板](../apps/desktop/src/components/RemoteDesktopPane.tsx)：`isDirect`、`supportsInAppViewer`、`reportState("connected")`、`new RFB`、`openViewer`。
- [桌面配置](../crates/xsh-domain/src/lib.rs)：`RemoteDesktopProfile`、`viewer_command`、`credential_ref`。
- [应用快捷键](../apps/desktop/src/App.tsx)：`onKeyDown`、`terminalHasFocus`。
- [Tauri 桌面入口](../apps/desktop/src-tauri/src/lib.rs)：`start_remote_desktop`、`open_remote_desktop_viewer`、`start_remote_desktop_automatically`、`launch_remote_desktop_viewer`。
- [桥接生命周期](../apps/desktop/src-tauri/src/remote_desktop_bridge.rs)。
- [SSH 会话建立](../crates/xsh-ssh/src/lib.rs)：`request_pty`、`request_shell`。

这些是源码检查结果，不代表当前 VNC 已完成各类服务器的兼容性验证，也不代表 RDP 已经接入。

## VNC 的选择

保留当前 noVNC + 应用内 Rust 桥接。noVNC 随前端构建分发，Rust 桥接在 XSH 进程内运行；这条路径可以满足产品独立性，不需要为此把 VNC 协议重新用 Rust 编写。

noVNC 官方支持浏览器内桌面显示、剪贴板、远程分辨率调整，以及通过 WebSocket / TCP 转发连接原生 VNC 服务。当前 XSH 已经实现了转发部分，但接入的界面能力比库提供的能力少。

当前面板只将保存的密码传给 `RFB`，监听了连接、断开和认证失败，并打开了视口缩放。需要继续接入凭据补充事件、文本剪贴板、特殊组合键，以及服务端支持时的桌面尺寸调整；视口缩放与改变远端桌面分辨率应有不同的用户含义。中文输入、键盘布局和 macOS 修饰键需要实机验证。

桥接应与具体桌面会话绑定，限制会话外的接入，并在断开、取消连接和关闭标签时统一回收。已有连接任务回收与超时机制可以复用。

官方依据：[noVNC 功能与连接方式](https://novnc.com/info.html)、[RFB 接口与事件](https://novnc.com/noVNC/docs/API.html)。许可证与第三方声明应随包处理，具体许可文本见 noVNC 官方仓库。

## RDP 引擎的选择

协议库的原生连接能力、功能成熟度和构建要求见配套的[协议库调研](remote-desktop-standalone-assessment-2026-10-25.md)。

**优先验证 FreeRDP 作为应用内链接库。** FreeRDP 官方 Sample 直接链接 `freerdp-client`、`freerdp`、`winpr`，其发布版图形实现中可以定位到 RDPGFX 及多种解码路径。由 XSH 承担显示、输入和平台交互，可以不运行 FreeRDP 的客户端可执行文件。代价是维护 C / Rust 适配层、原生构建依赖和两平台的随包分发。

**IronRDP 保留为备选。** 它提供可复用的 Rust 原生客户端，架构上适合现有后端，也有原生 TCP / TLS / NLA 路径。不过，本次核查的已发布高层客户端在图形能力接线、证书策略和 macOS 原生剪贴板方面需要额外处理；开发分支已经推进了图形能力，不能把开发提交与已发布版本混为一谈。

这项优先级是基于目标功能覆盖和集成成本的工程判断，不代表 FreeRDP 已在 XSH 中通过兼容性、性能或打包验收。若实际验证表明其 FFI 或分发成本不可接受，或者选定 IronRDP 提交补齐必需能力并通过同一验收集，可以调整选择。

一手依据：[FreeRDP Sample 的链接库](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/client/Sample/CMakeLists.txt)、[FreeRDP 图形解码实现](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/libfreerdp/gdi/gfx.c)、[IronRDP 发布版客户端运行时](https://github.com/Devolutions/IronRDP/blob/11a0810cfbbabd8b8023875a05e3041216d4b01b/crates/ironrdp-client/src/rdp.rs)。更细的版本与功能证据见配套调研。

选型必须满足以下条件：

1. 在 XSH 进程内作为库使用，并能在本地完成原生 RDP 连接。
2. 无需用户安装 RDP 查看器或部署网关。
3. Windows、macOS 都能构建和打包必需依赖。
4. 基础登录、画面、输入、文本剪贴板和尺寸调整能通过目标服务器的实际验证。
5. 引擎的错误、取消、证书与认证交互能够纳入 XSH 的会话生命周期。

不能仅因某个库提供浏览器演示，就推断该演示可以独立直连远程 RDP 端口；需要区分浏览器传输限制、网关协议与库的原生 TCP / TLS 路径。

## 集成结构

建议新增专门的远程桌面模块，收拢会话身份、传输选择、凭据引用、连接状态和资源回收。Tauri 命令只负责把界面动作交给该模块。

VNC 继续由 noVNC 在前端处理协议与显示，Rust 管理会话关联的转发；RDP 由 Rust 后端调用内置协议库处理网络、认证和解码，再把画面更新传给前端。FreeRDP 的 FFI 和依赖细节收拢在专门的适配实现中。两者向桌面面板提供一致的连接、断开、尺寸与剪贴板操作，协议细节留在各自的实现中。

输入和状态使用较小的控制消息，画面使用独立的二进制数据路径。凭据继续从现有加密库按会话读取；RDP 密码不需要经过外部命令行或临时 `.rdp` 文件。证书校验、信任确认和认证提示是内置客户端需要负责的功能，不能直接沿用演示程序中可能存在的跳过校验设置。

旧配置迁移时保留协议、目标主机、端口、用户名、凭据引用及直连 / 隧道选择。外部命令模板和“打开查看器”路径退出运行流程，自动启动行为转为连接应用内桌面。

## 性能评估

RDP 的主要集成风险之一是 Rust 解码与 WebView 显示之间的数据传输。以下是理论量级，不是 XSH 的实测性能：

- 1080p RGBA 全屏：`1920 × 1080 × 4 = 8,294,400` 字节，约 `7.91 MiB`。
- 每秒传递 30 个完整画面：约 `237 MiB/s`，尚未计入内存复制、序列化和绘制。

因此不能把逐帧完整像素转成 JSON / Base64，再交给 React 状态更新来驱动画面。应验证二进制通道、增量区域更新、缓冲复用和有上限的展示队列；Canvas 绘制与 React 的界面状态更新分开。

协议接收和解码必须保持完整顺序。可以合并过时的展示刷新，但需要保留累计变更，不能丢弃会影响后续解码或最终画面一致性的协议数据。

Tauri 官方将 Channels 定位为适合流式数据的有序通道，并明确不建议用事件系统传递低延迟、高吞吐数据。二进制 Channel 与应用内部二进制 WebSocket 都可以纳入验证，最终依据目标 WebView 上的端到端延迟、复制成本和内存占用选择。仅有库级解码速度不足以判断整机体验。

官方依据：[Tauri：Calling the Frontend](https://v2.tauri.app/develop/calling-frontend/)。本节的通道、队列与绘制安排属于本项目的设计建议。

## 实施顺序和验收

1. **原生 RDP 可行性验证。** 用内置库在 Windows、macOS 验证真实连接、认证、首屏、键鼠和尺寸调整；确认无需外部进程或额外网关。此阶段决定引擎，避免先大规模修改界面。
2. **完成基础桌面体验。** 接入统一会话生命周期、凭据、证书交互、文本剪贴板和重连；补齐 VNC；迁移旧配置，移除外部查看器入口和执行路径。
3. **性能与兼容性验证。** 覆盖 Windows 10 / 11、Windows Server、计划支持的 xrdp 版本及 VNC 服务端；记录目标系统版本与配置。检查多标签、网络中断、反复连接、窗口缩放和睡眠唤醒。
4. **扩展能力。** 根据实际需求再加入多显示器、声音、磁盘映射、文件剪贴板和外设重定向。基础桌面可用不等于这些能力已经完成。

首个独立版本的建议范围：直连、可选 SSH 隧道、账号认证、桌面显示、键鼠、特殊组合键、分辨率 / 缩放、文本剪贴板、明确的断开与错误状态。

验收必须使用实际安装包：在没有额外 VNC / RDP 客户端的环境中完成连接，检查桌面操作不启动查看器进程；分别测试 Windows、macOS，不能用伪装平台的浏览器测试代替 macOS 实机。关闭标签后应释放网络连接、缓冲和后台任务，连接失败与认证失败应能恢复操作。

## 评估边界

本次完成的是当前源码与官方一手资料的集成评估，没有接入新的 RDP 引擎、构建新安装包或运行远程桌面的实机性能测试。现有 SFTP 和桥接回收的回归测试不能替代新 RDP 客户端的协议、性能与跨平台验证。

不应在引擎验证前承诺与系统 RDP 客户端相同的功能覆盖、视频性能或固定交付日期。VNC 属于现有实现的完善；RDP 是这次产品独立化的主要新增工作。
