# XSH

[![CI](https://github.com/bilbilmyc/xsh/actions/workflows/ci.yml/badge.svg)](https://github.com/bilbilmyc/xsh/actions/workflows/ci.yml)
[![Build desktop artifacts](https://github.com/bilbilmyc/xsh/actions/workflows/build-artifacts.yml/badge.svg)](https://github.com/bilbilmyc/xsh/actions/workflows/build-artifacts.yml)
[![License](https://img.shields.io/badge/license-MIT%20%2F%20Apache--2.0-blue.svg)](LICENSE)

XSH 是一个面向 macOS 和 Windows 的本地优先 SSH/SFTP 桌面客户端。网络、持久化、凭据和传输引擎使用 Rust；桌面壳使用 Tauri 2，界面使用 React、TypeScript 和 xterm.js。项目当前以个人使用、macOS 日常打磨和 Windows 实机验收为主。

> 当前版本仍在快速迭代中。请先在测试会话上验证 SSH、SFTP、端口转发和凭据恢复，再用于生产环境。

## 快速开始

### 直接使用构建产物

- 正式版本：从 GitHub Releases 下载对应版本的 macOS `.zip` 或 Windows `.exe` / `.msi` 安装包。
- macOS：从 GitHub Actions 的 `Build desktop artifacts` 下载 `xsh-macos-personal`，或在 macOS 本机执行个人构建脚本。
- Windows：从 GitHub Actions 下载 `xsh-windows-installers`，或在 Windows 开发机执行构建脚本。
- 未签名的个人构建可能触发 macOS Gatekeeper 或 Windows SmartScreen 提示；请确认构建来源后再允许运行。

推送形如 `v0.1.0` 的 Git tag 后，GitHub Actions 会自动构建并创建对应 Release；如果只是手动运行工作流，则构建包仍位于该次 Actions 运行的 Artifacts 中。

### 本地开发

```bash
corepack enable
corepack prepare pnpm@11.10.0 --activate
pnpm install --frozen-lockfile
pnpm run dev
```

完整检查命令见[本地开发与构建](#本地开发与构建)。

## 当前可用能力

- 嵌套会话目录、应用内新建/重命名目录、标签、收藏、搜索、右键菜单、Command/Ctrl 多选、Shift 连选、Command/Ctrl+A 全选、Esc 清除、批量移动/收藏/删除、目录递归批量打开，以及环境、自动重连和标签的批量编辑
- 深海/石墨/暮色主题与多种强调色，支持界面字体、界面字号、终端字体、终端字号、行高和回滚缓冲区持久化配置；回滚历史可在全局或会话级设置，最高 100 万行
- 命令中心：本地命令片段库、分类/标签/搜索/收藏、复制和向当前已连接终端安全发送；`⌘⇧P`（macOS）或 `Ctrl+Shift+P`（Windows）快速打开
- 最近连接区域：记录最近成功连接的会话并自动清理已删除的会话记录
- 类 Xshell 的底部快捷命令栏：双击空白区域添加，双击或右键已有命令编辑，单击发送；支持分组、搜索、拖拽排序、macOS `⌘1~9` / Windows `Ctrl+Shift+1~9` 快捷键以及 `\r`、`\n`、`\t` 转义
- 快捷命令和命令中心拒绝保存高置信度明文密码、Token、私钥、`sshpass -p` 等敏感内容，并自动清理旧本地存储中的敏感项
- SSH 密码、OpenSSH 私钥、加密私钥 Passphrase、SSH Agent 和 keyboard-interactive 认证
- 首次连接显示 SHA-256 Host Key 指纹；优先复用 `~/.ssh/known_hosts`（Windows 为 `%USERPROFILE%\.ssh\known_hosts`），Host Key 变化时默认阻断，并可在设置中管理本地信任记录
- `~/.ssh/config` 读取和导入、带错误分类/处理建议/脱敏摘要复制的连接诊断、ProxyJump，以及本地/远程/动态端口转发
- 多标签常驻远程 PTY；切换标签不会断开 SSH 或丢失远程程序状态，并支持复制/重命名/拖拽排序/标签锁定、自定义标签颜色和批量关闭保护
- 单终端、左右分屏、上下分屏和命令广播；分隔条支持拖拽调整到 15%～85%、双击恢复 50%，焦点终端有清晰边框；重启后安全恢复标签顺序、锁定状态、活动标签、第二分屏和布局，并支持命名工作区保存、更新、重命名、删除、切换及无凭据 JSON 导入/导出
- 终端自适应、Keepalive、断线指数退避重连、网络离线等待/恢复即重连、macOS 睡眠唤醒后的连接检查、日志保存、内容搜索、复制全部、UTF-8/CJK、256 色和 True Color；顶部活动连接管理器可定位、重连、关闭及批量处理失败/断开标签
- 会话树显示实时连接状态和同一会话的已打开标签数量，便于快速定位已连接、连接中、重连中、等待网络和失败的会话
- 可配置右键直接粘贴或操作菜单、可选选中自动复制、可选多行粘贴确认；macOS 使用 `⌘C`/`⌘V`/`⌘F`，Windows 使用 `Ctrl+Shift+C`/`Ctrl+Shift+V`/`Ctrl+Shift+F`，避免抢占远端 `Ctrl+C`/`Ctrl+V`/`Ctrl+F`
- 平台化工作区快捷键：macOS 使用 `⌘T`/`⌘W`/`⌘B`，Windows 使用 `Ctrl+Shift+T`/`Ctrl+Shift+W`/`Ctrl+Shift+B`，避免抢占远端 Linux Shell 的 `Ctrl+T`、`Ctrl+W`、`Ctrl+B`；标签定位、复制连接、重连和分屏快捷键可在设置中集中查看
- macOS 使用 `⌘+`/`⌘-`/`⌘0`、Windows 使用 `Ctrl+Shift++`/`Ctrl+Shift+-`/`Ctrl+Shift+0` 临时调整当前终端字号；全局终端字体和回滚行数默认覆盖全部会话，也可选择优先使用会话设置
- 集成 SFTP 浏览、文件与目录递归上传/下载、非空目录递归删除、新建目录、重命名、远程编辑、多选批量操作和文件拖拽上传
- SFTP 两任务上传队列、流式进度、下载断点续传、单项/全部取消、失败或取消后重试、任务清理，以及覆盖/全部覆盖/跳过/全部跳过/重命名冲突策略
- 会话安全导入/导出；默认不导出密码或私钥 Passphrase
- 独立密码加密的凭据备份/恢复；普通会话导出仍不包含任何秘密
- 密码和 Passphrase 存储在 XSH 自建的本地加密 SQLite 凭据表中
- 删除或替换会话认证信息时清理关联的 XSH 本地凭据；新建或编辑时对同名会话及相同主机/端口/用户目标进行保存前提示

## 平台与构建状态

| 平台 | 本地构建 | GitHub Actions | 发布形态 |
| --- | --- | --- | --- |
| macOS Apple Silicon | `pnpm run build:macos:personal` | `xsh-macos-personal` | ad-hoc 签名 `.app` + zip |
| Windows x64 | `pnpm run build:windows` | `xsh-windows-installers` | NSIS `.exe` + MSI `.msi` |

CI 会在 macOS 和 Windows runner 上执行 Rust 格式检查、Clippy、workspace 测试、Tauri 后端检查和前端构建。打包工作流在手动触发或推送 `v*` 标签时生成可下载构建产物。

## 工程结构

- `crates/xsh-domain`：领域类型和版本化导入/导出格式
- `crates/xsh-storage`：SQLite repository 与 migration
- `crates/xsh-security`：XSH 本地加密凭据库
- `crates/xsh-ssh`：SSH、Host Key 验证、PTY 与终端字节流
- `crates/xsh-sftp`：远程文件操作与流式传输
- `apps/desktop/src-tauri`：Tauri composition root 与 IPC
- `apps/desktop/src`：会话树、终端标签和 SFTP UI

## 本地开发与构建

要求：

- Rust stable
- Node.js 22+
- pnpm 11.10+（建议通过 Corepack 启用）
- Tauri 2 对应平台依赖

```bash
corepack enable
corepack prepare pnpm@11.10.0 --activate
pnpm install --frozen-lockfile
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm run build
pnpm run dev
```

## 打包

```bash
pnpm run tauri:build
```

macOS 构建产物：

- `target/release/bundle/macos/XSH.app`
- `target/release/bundle/macos/XSH-personal-macos.zip`（执行个人版构建脚本时生成）
- `target/release/bundle/dmg/XSH_0.1.0_aarch64.dmg`（标准 Tauri bundle）

Windows 的 MSI/NSIS 产物需要在 Windows runner 或 Windows 开发机上生成。仓库内的 `.github/workflows/ci.yml` 会在 macOS 和 Windows 上检查 Rust、Tauri 后端及前端构建。

## 快捷键约定

XSH 尽量不拦截远端 Linux Shell、Vim、Emacs 和 tmux 常用的 Ctrl 组合：

- macOS：`⌘T` 新建会话、`⌘W` 关闭标签、`⌘B` 显示/隐藏侧栏、`⌘⌥V` 左右分屏、`⌘⌥J` 上下分屏、`⌘⌥S` 恢复单终端。
- Windows：使用 `Ctrl+Shift` 作为工作区前缀，例如 `Ctrl+Shift+T/W/B`；左右分屏为 `Ctrl+Alt+V`，上下分屏为 `Ctrl+Alt+J`。
- macOS 的 `⌘H` 和 `⌘⌥H` 保留给系统隐藏应用功能，XSH 不再使用 `H` 作为分屏快捷键。
- 复制、粘贴、查找和快捷命令的完整列表可在设置中查看。

## 安全边界

- SQLite 仅保存 opaque Credential Ref，不保存明文密码和 Passphrase。
- 默认导出不含秘密。
- 未知 Host Key 必须经用户确认；发生变化的 Host Key 不会被静默信任。系统 `known_hosts` 仅复用精确的明文主机条目；哈希主机条目暂不自动匹配。
- SFTP 使用 64 KiB 流式块和 `.xsh-part` 临时文件，避免把完整文件载入内存；下载取消或失败时保留经远端路径、大小和修改时间校验的断点元数据，远端文件变化后自动放弃旧断点。
- 命令中心与快捷命令栏不属于凭据存储或导出格式；命令仅在用户主动发送时进入当前已连接终端，并拒绝保存高置信度明文凭据或私钥；不提供密码快捷项。
- 工作区恢复、命名工作区及其 JSON 导出仅保存标签 ID、会话 ID、锁定/颜色状态、活动/第二分屏标签和布局，不保存终端输出、命令内容或凭据。

详见 `docs/product-spec.md`、`docs/architecture.md`、`docs/v2-plan.md` 和 `CONTRIBUTING.md`。

## 贡献与安全报告

- 贡献流程：[CONTRIBUTING.md](CONTRIBUTING.md)
- 安全边界与漏洞报告：[SECURITY.md](SECURITY.md)
- 规划与已知限制：[docs/roadmap.md](docs/roadmap.md)

## 个人免费使用（macOS）

XSH 不上架、只在自己的 Mac 上使用时，不需要购买 Apple Developer Program，也不需要配置 `Developer ID Application` 证书。直接使用 ad-hoc 本机签名即可；它适合开发和个人本机运行，但不提供 Apple 公证，也不代表应用已获得 Apple 验证。

在 macOS 上构建个人版：

```bash
pnpm run build:macos:personal
```

产物：

```text
target/release/bundle/macos/XSH.app
target/release/bundle/macos/XSH-personal-macos.zip
```

首次打开如果 macOS 阻止启动：在 Finder 中右键 `XSH.app`，选择“打开”，然后再次确认“打开”。该方案不会产生签名费用。SSH 密码和 Key Passphrase 由 XSH 自己的本地加密凭据表管理，不读取、不写入 macOS 钥匙串或 Windows Credential Manager；密码不会出现在导出包、JSON 或 SQLite 明文中。

> 该个人构建方案只针对本机使用。若以后要把应用发给其他 Mac 用户并避免“无法验证开发者”提示，才需要 Developer ID 签名和公证；本项目当前不强制配置这些付费发布能力。

## 在另一台家用 Mac 上使用

个人版不需要安装 Rust、Node.js 或 Apple 开发证书。把下面的应用复制到家里的 Mac 即可：

```text
target/release/bundle/macos/XSH.app
```

推荐步骤：

1. 在当前电脑执行 `pnpm run build:macos:personal`，直接得到 `XSH-personal-macos.zip`。
2. 通过 AirDrop、U 盘、网盘等方式把 zip 传到家里的 Mac。
3. 解压后，将 `XSH.app` 拖到“应用程序”目录。
4. 第一次运行时，在 Finder 中右键应用，选择“打开”，再确认一次“打开”。
5. 在 XSH 里导入会话配置；为了安全，导出的会话文件不包含 SSH 密码，需要在家里的 Mac 上重新保存密码。

如果只复制应用本身，家里的 Mac 会以全新环境启动；会话、主题和快捷命令不会自动从另一台 Mac 出现。推荐使用 XSH 的“会话导出/导入”迁移非敏感配置；密码凭据不会进入导出包，需要在目标设备重新保存。

## Windows 构建

Windows 构建不需要 Apple 证书。请在 Windows 开发机上先准备：

- Node.js 22 或更高版本
- pnpm 11.10.0（可通过 Corepack 启用）
- Rust stable MSVC 工具链（`stable-x86_64-pc-windows-msvc`）
- Visual Studio Build Tools 的 C++ 桌面开发组件
- WebView2 Runtime

首次使用 PowerShell：

```powershell
corepack enable
corepack prepare pnpm@11.10.0 --activate
rustup default stable-x86_64-pc-windows-msvc
```

把项目目录带到家里的电脑后，可以直接双击：

```text
scripts\build-windows.cmd
```

也可以在项目根目录用 PowerShell 执行：

```powershell
.\scripts\build-windows.ps1
```

脚本会自动安装锁定版本依赖，然后构建 NSIS 和 MSI 两种安装包。依赖已经安装过时，可以跳过安装步骤：

```powershell
.\scripts\build-windows.ps1 -SkipInstall
```

产物位于：

```text
target\\release\\bundle\\nsis\\*.exe
target\\release\\bundle\\msi\\*.msi
```

如果没有 Windows 开发机，可以在 GitHub Actions 中手动运行 `Build desktop artifacts` 工作流。它会同时生成：

- `xsh-macos-personal`：macOS 本机个人使用版 `XSH.app`
- `xsh-windows-installers`：Windows NSIS 安装包和 MSI 安装包

工作流文件：`.github/workflows/build-artifacts.yml`。当前 Windows 构建为未签名安装包，只适合个人使用；Windows 可能显示 SmartScreen 提示，选择“更多信息 → 仍要运行”即可。后续如果需要给其他人正式分发，再单独增加 Windows 代码签名，不影响现在的免费个人使用方案。
