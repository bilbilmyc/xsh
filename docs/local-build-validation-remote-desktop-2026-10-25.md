# 内置远程桌面本机构建验证

日期：2026-10-25，Asia/Shanghai。环境：Windows x64，MSVC 14.44，CMake 3.31.8，Rust stable。版本：XSH 0.1.24。

## 交付内容

VNC 和 RDP 在应用内显示与操作，支持直接连接和可选 SSH 隧道。RDP 使用固定版本 FreeRDP / WinPR 的同进程库；OpenSSL、provider 与 uriparser 静态链接到同一 DLL。远程桌面路径没有外部查看器启动命令，也没有配套网关进程。

新增 RDP 的 Rust 会话所有权、取消、二进制画面与绘制确认、扫描码 / Unicode / 鼠标输入、证书确认、文本剪贴板和分辨率请求。本轮继续补齐原生鼠标形状、热点 / 隐藏 / 默认 / 缓存状态、通道能力回传、分辨率预设 / 服务器像素限制和可选操作失败提示。VNC 桥增加连接 token 与应用来源检查。终端命令、广播和批量命令目标排除远程桌面标签。

保留此前的终端字体 / 字重 / xterm256 配色，以及 SFTP 下载管线和连接任务清理修改。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| `cargo fmt --all --check` | 通过 |
| `cargo test --workspace --features xsh-rdp/test-peer` | 197 项测试通过 |
| `cargo clippy --workspace --all-targets --features xsh-rdp/test-peer -- -D warnings` | 通过 |
| `pnpm test` | 150 项测试通过 |
| `pnpm --filter desktop exec tauri build --bundles 'nsis,msi'` | 前端与 release 后端构建成功，生成两个安装包 |
| `git diff --check` | 通过 |

另外运行了默认来源的 OpenSSL / 原生 RDP 构建及原生测试。之后的增量验证复用该次固定来源构建产生的静态 OpenSSL 安装目录，没有采用系统动态 OpenSSL。Vite 保留既有 TerminalPane chunk 大于 500 kB 的提示，构建成功。

### 原生协议

可选 `test-peer` 在测试进程中生成临时证书，建立 loopback TCP / TLS RDP 服务端，并驱动生产客户端代码。九项原生模块测试覆盖：

- 正确的 TPKT 初始握手，以及连接阶段卡住时关闭与 socket 回收。
- TLS 自签名证书确认；名称匹配不会被误报为不匹配，信任本次连接不写入持久信任文件。
- 拒绝真实 TLS 证书时不能进入激活态或绘制桌面。
- 等待证书确认期间关闭，客户端和服务端均及时退出。
- 服务端发送的真实 bitmap 被客户端解码为正确 RGBA 像素。
- 服务端收到键盘 down/up、中文 Unicode、鼠标和完整顺序的 Ctrl+Alt+Delete。
- 帧确认、跳过刷新后的完整快照、脏矩形行打包及 4K 像素预算。
- 真实 CLIPRDR 通道双向传输中文、emoji 和换行文本。
- 真实 DISP 能力协商、单显示器布局请求、320×240 → 640×480 的实际桌面改尺寸与后续 bitmap。
- 真实指针 RGBA、热点、自定义 / 隐藏 / 默认 / 缓存指针切换。
- 隔离的 NLA / CredSSP 测试：正确密码、带域名用户名、错误密码。服务端只接受 NLA，断言实际 NTLM 哈希回调次数与激活状态，失败认证不能绘制桌面。

测试只使用 loopback fixture，没有打开系统远程桌面服务、创建系统账号或修改防火墙。NLA 用独立测试进程在 SSPI 初始化前设置 `WINPR_NATIVE_SSPI=0`，使用临时认证回调；生产默认仍使用 Windows 原生 SSPI。测试 peer 及服务端通道不包含在默认发布 DLL 中。

### 真实 Windows 虚拟机

2026-10-25 20:54–20:55（Asia/Shanghai），使用用户指定的 Windows 虚拟机和账号完成一次真实登录。测试程序调用生产 `RdpManager`，加载从最终 MSI 中解出的 `xsh-rdp-native.dll`；DLL 的 SHA-256 与安装包验证记录一致，为 `47b77eaebc3e92975cef8f4001c2ad95feefe6b5d8c1eb5cac833ca268333df3`。没有启用 `test-peer`，没有启动 mstsc 或其他远程桌面查看器。

| 检查 | 真实服务器结果 |
| --- | --- |
| 身份认证 | 默认 Windows 原生 SSPI / NLA 登录成功，约 699 ms 进入连接状态 |
| 证书 | SHA-256 与本机 mstsc 为该服务器保存的指纹一致，确认仅信任本次连接；测试配置目录没有写入持久信任文件 |
| 桌面解码 | 约 701 ms 收到首个非空画面；截图确认已进入真实 Windows 桌面 |
| 图像与指针事件 | 约 11 秒内收到 34 个桌面帧、37 个指针事件，其中 33 个为 RGBA 图案 |
| 输入发送 | 发送鼠标移动与一次 Shift 按下 / 释放，未点击、输入文本或操作远端应用；会话继续正常运行 |
| CLIPRDR | 文本剪贴板通道协商成功；没有改写远端剪贴板，本次未验证文本双向传输 |
| DISP | 服务器公布 8,847,360 像素上限；实际画面完成 1280×720 → 1024×768 → 1280×720 往返切换 |
| 关闭 | 主动关闭约 8 ms 返回，测试进程正常退出 |

凭据只通过测试进程的标准输入传入，未写入源码、配置、凭据库或结果日志。主机地址、用户名和桌面截图未加入此文档。测试代码、不含密码的事件日志及三组截图位于被 Git 忽略的 `output/rdp-deps/live-vm-probe/`。

这次验证覆盖正式后端与真实服务器之间的连接和协议行为，未通过应用 UI 操作完整连接流程；浏览器侧的既有验证方式见下节。耗时来自单次短连接，不能作为吞吐量、帧率或长时间稳定性的性能结论。

### 浏览器

Playwright 操作真实浏览器及 XSH 前端。本地 RFB fixture 验证 noVNC 的真实原始像素解码、键鼠、Ctrl+Alt+Delete、双向文本剪贴板和断开。另一个 RFB 3.8 认证 fixture 实际校验 VNC Authentication 的 DES 挑战响应，分别拒绝错误密码、接受正确密码并解码画面；认证重试的两个 socket 均已关闭。

RDP 前端使用受控 Tauri IPC fixture 验证证书同意 / 拒绝、连接状态、二进制完整帧 / 脏矩形、绘制 ACK、扩展扫描码、焦点变化释放按键、鼠标 / 滚轮、Ctrl+Alt+Delete、分辨率回传、文本剪贴板、全屏、畸形帧关闭、旧连接事件隔离与关闭。新增验证真实浏览器鼠标 PNG / 热点 / 隐藏 / 默认状态，384×384 图案缩至 128×128、服务器能力禁用提示、服务器像素预算约束、手动分辨率切换、重连后作废旧剪贴板读取，以及可选操作队列拒绝后会话继续连接。VNC / RDP 连接后，终端快捷命令栏均要求切换到 SSH 会话。

浏览器脚本与截图保存在被 Git 忽略的 `output/playwright/`。测试结束后关闭了本次创建的浏览器、Vite 预览和 RFB fixture。

## 安装包

最终产物：

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| `target/release/bundle/nsis/XSH_0.1.24_x64-setup.exe` | 9600426 | `36001ff643acca6f0db9e7c36179b9093298f9b3b525042dba955dd765b48e4a` |
| `target/release/bundle/msi/XSH_0.1.24_x64_en-US.msi` | 13299712 | `b25918689cf2790412674034a9310ed816f76b80eaf0f610eae00e684813a1e5` |

首次打包前移走生成的 `native-runtime`，确认构建过程能自动产生并暂存原生库。NSIS 生成脚本包含安装至根目录的 `xsh-rdp-native.dll` 和许可证文件。最终 MSI 通过行政解包验证，主程序、同目录原生库和 `licenses/` 均存在；此步骤仅解包检查。

2026-10-25 21:04（Asia/Shanghai），按用户要求运行已验证的 NSIS 安装包，以更新模式覆盖本机现有安装，退出码为 0。安装后、首次启动前逐一比较现有应用数据文件，内容均未被安装器改动。随后启动安装目录中的 XSH，窗口标题为 `XSH`、进程响应正常，并确认实际加载同目录的 `xsh-rdp-native.dll`，其 SHA-256 与安装包验证记录一致。此处验证启动与原生库加载，后续应用界面的交互验收由用户进行。

包内 DLL 的 SHA-256 与 release DLL 一致：

```text
47b77eaebc3e92975cef8f4001c2ad95feefe6b5d8c1eb5cac833ca268333df3
```

`scripts/verify-bundled-rdp.ps1` 将该 DLL 单独复制到空临时目录，只允许本目录和 Windows 系统目录解析依赖，成功加载并调用原生初始化入口，同时确认不存在测试 peer 入口。`dumpbin /DEPENDENTS` 显示只有 Windows 系统 DLL，没有 FreeRDP、WinPR、OpenSSL、uriparser 或编解码器的外部 DLL。

## 尚未覆盖的范围

已补充一台真实 Windows 虚拟机的原生 SSPI / NLA 账号登录、桌面解码、指针、输入发送和 DISP 实测。尚未覆盖真实 Active Directory、xrdp、不同服务器的 RDPGFX / 剪贴板 / 动态分辨率兼容性、长时间高刷新桌面，以及各类 VNC 服务端扩展。本次真实 Windows 服务器仅确认 CLIPRDR 协商，文本双向传输仍只有原生夹具验证。浏览器中的 RDP IPC 测试不替代这些协议场景。

当前机器未执行 macOS 编译或运行；仓库已补充 dylib 的 Frameworks 打包、rpath、签名检查和 CI 配置，实际结果仍需对应平台验证。

音频、麦克风、磁盘 / USB / 打印机 / 智能卡重定向、文件 / 图片剪贴板、RemoteApp、多显示器、RD Gateway 和额外 H.264 编解码器尚未接入。具体实现与构建说明见 [remote-desktop.md](remote-desktop.md)。
