# XSH

[![CI](https://github.com/bilbilmyc/xsh/actions/workflows/ci.yml/badge.svg)](https://github.com/bilbilmyc/xsh/actions/workflows/ci.yml)
[![Build desktop artifacts](https://github.com/bilbilmyc/xsh/actions/workflows/build-artifacts.yml/badge.svg)](https://github.com/bilbilmyc/xsh/actions/workflows/build-artifacts.yml)
[![License](https://img.shields.io/badge/license-MIT%20%2F%20Apache--2.0-blue.svg)](LICENSE)

**一个本地优先、跨平台的 SSH / SFTP 桌面客户端。**

XSH 面向需要长期管理多台服务器的开发者和运维人员：用会话树整理连接，用多标签和分屏保持工作上下文，用内置 SFTP 和命令工具完成日常操作。

> 当前项目仍在快速迭代中，适合个人使用和体验。用于生产环境前，请先在测试服务器上验证 SSH、SFTP、端口转发和凭据恢复流程。

## 特性

### 终端与工作区

- 多标签 SSH 终端：切换标签不会主动断开 SSH 或丢失远程 PTY 状态
- 左右 / 上下分屏、命令广播、标签锁定、复制、重命名、排序和自定义颜色
- 命名工作区：保存、恢复、更新、重命名、删除，以及无凭据 JSON 导入 / 导出
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
- 本地、远程和动态端口转发
- 支持 UTF-8 / CJK、256 色和 True Color

### SFTP

- 目录浏览、远程编辑、新建目录、重命名和递归删除
- 文件与目录递归上传 / 下载、拖拽上传和批量操作
- 覆盖、跳过、重命名等冲突处理策略
- 进度、取消、取消全部、失败重试和任务清理
- 下载断点续传，使用 `.xsh-part` 临时文件和校验元数据
- 有界内存流式传输，不将完整文件载入前端状态

### 命令工具

- 命令中心：分类、标签、搜索、收藏、复制和发送到当前终端
- 类 Xshell 的快捷命令栏：分组、搜索、拖拽排序和快捷键
- 支持 `\r`、`\n`、`\t` 转义
- 高置信度拦截明文密码、Token、私钥和 `sshpass -p` 等敏感内容

## 安全设计

XSH 按“本地优先、默认不泄露”设计：

- 密码和 Key Passphrase 只进入 XSH 自建的本地加密凭据库
- SQLite 只保存 opaque Credential Ref，不保存明文秘密
- 普通会话导出、工作区恢复、工作区 JSON 和日志不包含凭据
- Host Key 首次出现需要用户确认，发生变化时默认阻断连接
- 命令中心和快捷命令栏拒绝保存高置信度敏感内容
- SFTP 使用流式传输和断点元数据，避免一次性读取完整文件

完整边界请参阅 [SECURITY.md](SECURITY.md) 和 [产品规格](docs/product-spec.md)。

## 安装与使用

### 下载构建产物

推送 `v*` 格式的 Git tag 后，GitHub Actions 会构建并创建 GitHub Release。也可以手动运行 **Build desktop artifacts** 工作流，在 Actions 页面下载：

| 平台 | 构建产物 | 说明 |
| --- | --- | --- |
| macOS Apple Silicon | `xsh-macos-personal` | `XSH-personal-macos.zip`，ad-hoc 签名，适合个人使用 |
| Windows x64 | `xsh-windows-installers` | NSIS `.exe` 和 MSI `.msi`，当前未签名 |

未签名构建可能触发 macOS Gatekeeper 或 Windows SmartScreen。请确认构建来源后再允许运行。

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
target/release/bundle/macos/XSH-personal-macos.zip
```

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

暂不计划支持 SSH1、Telnet、Rlogin、RDP、X11 forwarding、ZMODEM、Kerberos、PKCS#11、云同步和团队共享凭据。

## 参与贡献

欢迎提交可复现的 bug、跨平台兼容性反馈和小范围改进。提交 issue、PR 或测试反馈前，请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

请勿在 issue、PR、日志、截图或提交历史中写入真实的主机、用户名、密码、Token、私钥或 Key Passphrase。安全问题请按照 [SECURITY.md](SECURITY.md) 的方式私密报告。

## 许可证

XSH 采用双许可证：

- [MIT](LICENSE)
- [Apache License 2.0](LICENSE)
