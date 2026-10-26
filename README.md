# XSH

[![CI](https://github.com/bilbilmyc/xsh/actions/workflows/ci.yml/badge.svg)](https://github.com/bilbilmyc/xsh/actions/workflows/ci.yml)
[![Build desktop artifacts](https://github.com/bilbilmyc/xsh/actions/workflows/build-artifacts.yml/badge.svg)](https://github.com/bilbilmyc/xsh/actions/workflows/build-artifacts.yml)
[![License](https://img.shields.io/badge/license-MIT%20%2F%20Apache--2.0-blue.svg)](LICENSE)

**一个本地优先、跨平台的 SSH / SFTP / VNC / RDP 桌面客户端。**

XSH 面向需要长期管理多台服务器的开发者和运维人员：用会话树整理连接，用多标签和分屏保持工作上下文，用内置 SFTP 和命令工具完成日常操作。

当前正式版：**v0.2.1**。SSH、SFTP、VNC 和 RDP 集成在同一个应用中，远程桌面使用内置协议组件；支持在应用内检查、下载和安装更新。版本内容见 [更新记录](CHANGELOG.md)。

## 特性

### 终端与工作区

- 多标签 SSH 终端：切换标签不会主动断开 SSH 或丢失远程 PTY 状态
- 左右 / 上下分屏、命令广播、标签锁定、复制、重命名、排序和自定义颜色
- 命名工作区：保存、恢复、更新、重命名、删除，以及密码加密的 `.xshworkspace` 导入 / 导出
- Keepalive、断线指数退避重连、离线等待、网络恢复重连和 macOS 睡眠唤醒后的连接检查
- 终端日志、内容搜索、复制全部、清屏、滚动到底部、字体缩放和可配置回滚缓冲区

### 会话管理

- 会话目录树、收藏、搜索、最近连接和实时连接状态
- 会话与目录的创建、重命名、移动、批量收藏、批量删除和递归批量打开
- 支持批量编辑环境、自动重连、标签等终端配置
- 支持从 `~/.ssh/config` 导入连接配置，并提供可执行的连接诊断

### SSH 与网络

- 密码、OpenSSH 私钥、加密私钥、SSH Agent 和 keyboard-interactive 认证
- SHA-256 Host Key 指纹、TOFU 信任流程和 Host Key 变化阻断
- ProxyJump
- 本地、远程和动态端口转发；支持按会话保存隧道配置、自动启动和 SSH 重连恢复
- 支持 UTF-8 / CJK、256 色和 True Color

### 内置远程桌面

- VNC、RDP 会话可直接连接目标，也可通过 XSH 管理的 SSH 隧道连接
- 桌面在应用标签中显示；支持键盘、鼠标、Ctrl+Alt+Delete、适应窗口、100% 显示、全屏和重新连接
- 文本剪贴板可双向传递；RDP 支持中文输入、发送文本、远端鼠标形状和服务器支持时的自动 / 预设分辨率调整，控件根据通道能力启用
- RDP 协议、TLS 和 NLA 在 XSH 进程内处理，随安装包携带；用户无需安装外部查看器或部署桌面网关
- 登录密码沿用 XSH 凭据库；RDP 未验证证书需要确认，仅对本次连接信任

构建方式、验证范围与当前功能边界见 [内置远程桌面](docs/remote-desktop.md)。

### SFTP

- 目录浏览、远程编辑、新建目录、重命名和递归删除
- 文件与目录递归上传 / 下载、拖拽上传和批量操作
- 覆盖、跳过、重命名等冲突处理策略
- 进度、取消、取消全部、失败重试和任务清理
- 全局与单主机并发调度，暂停任务释放运行槽并在继续时重新排队
- 上传、下载独立的应用级聚合限速，可在设置中按 KiB/s 或 MiB/s 配置
- 全局传输管理器保留后台任务并显示目标主机；单个 SFTP 面板只操作自己的连接
- 上传与下载断点续传，使用 `.xsh-part` 临时文件和校验元数据
- 远端不支持覆盖式 rename 时使用可恢复 journal/backup，断链或进程退出后由下一次同目标上传自动收敛
- 有界内存流式传输，不将完整文件载入前端状态

### 命令工具

- 命令中心：分类、标签、搜索、收藏、复制和发送到当前终端
- 类 Xshell 的快捷命令栏：分组、搜索、拖拽排序和快捷键
- 支持 `\r`、`\n`、`\t` 转义
- 高置信度拦截明文密码、Token、私钥和 `sshpass -p` 等敏感内容

### AI 助手（可选）

- 右侧「文件 / AI 助手」共用可调整宽度的工具面板；每个终端标签有独立的本次对话，收起面板或切回标签可继续追问
- 解释终端选区、分析选中的报错、根据自然语言生成可编辑的命令草稿
- 在「选项 → 设置 → AI 服务」统一配置 Base URL、模型和可选 API Key；终端侧栏的「服务设置」可直达此处，支持兼容 Chat Completions 的文本服务，请求地址追加 `/chat/completions`
- 选中终端文字后，上方出现「解释 / 分析报错」；普通右键保留原粘贴习惯，按住 Shift 再右键可打开 AI 菜单
- 不方便选择时，可显式点击「附加最近50行输出」，仅提取最多 50 个屏幕缓冲行并限制为 16 KiB，预览后再发送；软换行先还原再脱敏，窗口边缘的不完整行和超长整行会跳过
- 默认关闭、不自动联网，不读取完整终端历史；每次请求都先预览并人工确认，问题最多 4 KiB、上下文最多 16 KiB
- 回复支持流式逐段显示，可随时停止生成；已停止、失败或尚未完整收到的回复不会变成可执行草稿，也不作为后续对话历史
- 追问会带入该标签最近最多 6 轮完整问答 / 32 KiB 历史，单条历史最多 16 KiB；过长内容会明确标注截短，发送前可展开核对实际历史。需要继续分析执行结果时，手动附加新选区或最近输出
- 对话仅保存在本次运行的内存中，不写入数据库或本地存储；「新对话」或重新保存 AI 服务设置后，每个标签保留最近 3 份、合计最多 512 KiB 的只读旧对话，可查看与复制，不自动加入新请求；关闭终端标签或退出程序会清除相应记录
- 自动隐藏常见凭据，但不能保证识别所有秘密；发送前仍需人工检查，数据会交给你配置的服务处理
- API Key 加密保存在本机凭据库，与 SSH 凭据隔离；远程服务必须使用 HTTPS，本机回环地址可使用 HTTP
- 命令不会自动执行：确认目标与完整草稿后，只发送到生成时关联的单个 SSH 连接，不参与广播；生成后重连则必须重新生成草稿
- 不支持自动工具调用或自主操作服务器；收起面板不是停止生成。流式服务必须兼容 Chat Completions SSE，若服务直接返回有效 JSON 则一次显示完整回复，不自动重发请求

### 配色与新手引导

- 保留浅色、午夜、石墨、暮色，新增北境、松林、暖砂、清瓷；在设置中用缩略预览选择，界面与默认终端共同切换，会话显式蓝 / 绿主题保持优先
- 首页按「第一次连接 / 传文件 / 用 AI 帮忙」给出入口；首次连接的高级设置默认折叠，并解释账号、认证和指纹确认
- 工具栏「使用指南」、帮助菜单或 `F1` 可打开六类任务教程；每页包含准备条件、步骤、下一步和真实功能入口
- Windows 使用 `Ctrl+Shift+I`、macOS 使用 `⌘⇧I` 打开 AI 侧栏；终端的远端优先模式保留原远端按键行为

## 安全设计

XSH 按“本地优先、默认不泄露”设计：

- 密码和 Key Passphrase 只进入 XSH 自建的本地加密凭据库
- SQLite 只保存 opaque Credential Ref，不保存明文秘密
- 会话配置与会话实际使用的登录密码 / Key Passphrase 一起使用同一个文件密码加密到 `.xshpack`；工作区使用密码加密的 `.xshworkspace` 导入 / 导出；凭据库仍可使用独立密码导出 `.xshbackup` 备份
- Host Key 首次出现需要用户确认，发生变化时默认阻断连接
- 命令中心和快捷命令栏拒绝保存高置信度敏感内容
- 导入前先解密并校验完整文件；凭据恢复使用事务写入，避免失败后留下半份数据
- `.xshpack` 会加密保存会话实际引用的密码和 Key Passphrase，导入另一台设备时只需输入导出时设置的文件密码；普通工作区文件不包含这些凭据，`.xshbackup` 仍用于全量凭据迁移
- SFTP 使用流式传输和断点元数据，避免一次性读取完整文件

完整边界请参阅 [SECURITY.md](SECURITY.md) 和 [产品规格](docs/product-spec.md)。

## 安装与使用

### 下载构建产物

推送 `v*` 格式的 Git tag 后，GitHub Actions 会构建并创建 GitHub Release。也可以手动运行 **Build desktop artifacts** 工作流，在 Actions 页面下载：

| 平台 | 构建产物 | 说明 |
| --- | --- | --- |
| macOS Apple Silicon | `xsh-macos-personal` | `.dmg` 安装包，ad-hoc 签名，适合个人使用 |
| Windows x64 | `xsh-windows-installers` | NSIS `.exe` 和 MSI `.msi`，当前未签名 |

未签名构建可能触发 macOS Gatekeeper 或 Windows SmartScreen。请确认构建来源后再允许运行。

### 应用内更新

在「帮助 → 检查更新」、底部版本号按钮或「设置 → 应用更新」中检查正式版。发现新版本后，可以查看更新说明并下载适用于当前系统和处理器架构的安装包；关闭设置窗口后下载仍会继续。下载会核对文件大小和 GitHub Release 提供的 SHA-256 摘要，校验通过后才允许安装。

Windows 点击「退出并安装」启动安装程序；macOS 点击「退出并打开安装包」后，将 XSH 拖入「应用程序」替换旧版本。安装前会提示退出并断开当前连接，请先保存远程编辑内容。更新只在主动检查时访问 GitHub。

### 从源码运行

要求：

- Rust stable
- Node.js 22+
- pnpm 11.10+
- Tauri 2 对应的平台依赖

```bash
corepack enable
corepack prepare pnpm@11.10.0 --activate
pnpm install --frozen-lockfile
pnpm run dev
```

## 构建

内置 RDP 从仓库中固定版本的 FreeRDP 源码和 `Cargo.lock` 固定的 OpenSSL 源码构建。开发机需要 CMake 3.18+、C/C++ 编译器和 Perl；Windows 请使用 Visual Studio C++ 工具与原生 Strawberry Perl，macOS 需要 Xcode Command Line Tools。CMake、Perl 和编译器仅用于构建，安装后的 XSH 不需要这些工具。首次构建会明显长于后续增量构建。

```bash
pnpm run build

# Tauri 标准构建
pnpm run tauri:build

# macOS 个人版
pnpm run build:macos:personal

# Windows（在 Windows 开发机执行）
pnpm run build:windows
```

macOS 个人版产物：

```text
target/release/bundle/macos/XSH.app
target/release/bundle/dmg/*.dmg
```

安装步骤：

1. 双击 `.dmg` 文件。
2. 在打开的窗口中把 `XSH` 拖到 `Applications`。
3. 从“应用程序”中启动 XSH。首次启动如果 macOS 提示来源无法验证，请在 Finder 中右键 XSH，选择“打开”，再确认一次。

Windows 安装包产物：

```text
target/release/bundle/nsis/*.exe
target/release/bundle/msi/*.msi
```

## 开发检查

提交前建议运行：

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm run build
```

## 技术栈

- **Desktop**：Tauri 2
- **Frontend**：React 19、TypeScript、Vite、xterm.js
- **Backend**：Rust、Tokio、russh、russh-sftp
- **Remote desktop**：内置 noVNC、FreeRDP / WinPR、静态 OpenSSL
- **Storage**：SQLite
- **Security**：Argon2、AES-256-GCM、`zeroize`

## 项目结构

```text
apps/desktop/src       React UI
apps/desktop/src-tauri Tauri IPC 与应用组装
crates/xsh-domain      领域模型与导入导出格式
crates/xsh-storage     SQLite 存储与迁移
crates/xsh-security    本地加密凭据库
crates/xsh-ssh         SSH、Host Key、PTY 与终端字节流
crates/xsh-sftp        SFTP 操作与流式传输
docs/                  架构、规格与路线图
```

## 快捷键

XSH 尽量不占用远端 Linux Shell、Vim、Emacs 和 tmux 常见的 `Ctrl` 组合：

- macOS：`⌘T` 新建标签、`⌘W` 关闭标签、`⌘B` 显示 / 隐藏侧栏
- Windows：使用 `Ctrl+Shift` 作为工作区快捷键前缀，例如 `Ctrl+Shift+T/W/B`
- 分屏：macOS 使用 `⌘⌥V` / `⌘⌥J`，Windows 使用 `Ctrl+Alt+V` / `Ctrl+Alt+J`
- 复制、粘贴、查找、命令中心和更多快捷键可在应用设置中查看

## 文档

- [产品规格](docs/product-spec.md)
- [系统架构](docs/architecture.md)
- [V2 实现计划](docs/v2-plan.md)
- [路线图](docs/roadmap.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)

## 当前状态

XSH 的 V2 核心能力已经实现，目前重点是：

- macOS 日常使用体验和长时间稳定性
- Windows 10 / 11 实机安装与回归验证
- 大文件传输、网络切换和睡眠唤醒场景的压力测试
- 可访问性、高 DPI、多显示器和发布工程完善

暂不计划支持 SSH1、Telnet、Rlogin、X11 forwarding、ZMODEM、Kerberos、PKCS#11、云同步和团队共享凭据。

## 参与贡献

欢迎提交可复现的 bug、跨平台兼容性反馈和小范围改进。提交 issue、PR 或测试反馈前，请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

请勿在 issue、PR、日志、截图或提交历史中写入真实的主机、用户名、密码、Token、私钥或 Key Passphrase。安全问题请按照 [SECURITY.md](SECURITY.md) 的方式私密报告。

## 许可证

XSH 采用双许可证：

- [MIT](LICENSE)
- [Apache License 2.0](LICENSE)
