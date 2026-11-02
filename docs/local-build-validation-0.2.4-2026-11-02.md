# XSH 0.2.4 本地构建与覆盖安装验证

日期：2026-11-02，Asia/Shanghai。环境：Windows x64、Rust 1.99.1、Node.js 24.22.0、pnpm 11.10.0。

## 修复范围

- 下载确认窗口的本地保存路径改为可点击的原生选择控件。目录下载选择文件夹，单文件下载选择完整保存位置；从当前路径开始，取消保留原路径，选择期间禁止重复打开和提前提交。
- 空文件下载此前在创建临时文件之前进入完成分支，安装本地文件时因临时文件不存在而报 `os error 2`。现先创建临时文件，并在最终落盘前关闭文件句柄。
- 根包、桌面包、Tauri 配置、Rust 工作区及锁文件中的七个工作区包统一为 `0.2.4`；第三方依赖版本未变。

## 自动检查

| 检查 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过，锁文件一致 |
| `pnpm build` | TypeScript 与生产构建通过，保留已有的 TerminalPane chunk 大小提示 |
| `pnpm test` | 156 项通过 |
| `cargo fmt --all --check` | 通过 |
| `cargo clippy --workspace --all-targets --features xsh-rdp/test-peer -- -D warnings` | 通过 |
| `cargo test --workspace --features xsh-rdp/test-peer` | 210 项通过，1 项联网安装包下载测试按默认配置跳过 |
| `cargo check -p desktop --features xsh-rdp/test-peer` | 通过 |
| `git diff --check` | 通过 |

空文件回归测试先复现了与用户截图相同的 Windows `os error 2`，修复后通过。新增协议测试覆盖嵌套目录中的空文件、允许及禁止覆盖已有文件、仅残留续传元数据、空的完整续传文件，以及非空的完整续传文件落盘。测试使用真实 SFTP 客户端与进程内协议服务端。

此前对实际 React 下载弹窗的浏览器检查覆盖目录选择、选择取消、重试、单文件另存为、中文和空格路径、键盘操作、忙碌状态、上传路径及长路径显示；该组检查模拟系统选择框 IPC。

## Windows 安装与实际下载

使用 `scripts/build-windows.ps1 -SkipInstall` 生成 NSIS 和 MSI 包。内置 RDP 使用仓库固定来源及此前由该来源构建的静态 OpenSSL 安装目录；发布 DLL 未启用 `test-peer`。

安装前关闭旧客户端，将旧安装目录及应用数据备份至被 Git 忽略的 `output/release-0.2.4/before-upgrade/`。NSIS 使用 `/S /UPDATE` 覆盖本机 `0.2.1`，退出码为 0。

| 检查 | 结果 |
| --- | --- |
| NSIS 版本、程序 ProductVersion、MSI ProductVersion、卸载注册表版本 | 均为 `0.2.4` |
| 安装后首次启动前的数据核对 | 数据库、凭据密钥和 AI 配置的 SHA-256 均与安装前一致 |
| 安装后的实际界面 | 显示 `v0.2.4`，原有 8 个会话可见，保存的 SSH 会话连接成功 |
| 下载保存目录按钮 | 打开真实 Windows 文件夹选择框，初始目录为当前保存目录 |
| 实际目录下载 | 35 个文件落盘，包含此前失败的空 `FETCH_HEAD`；该文件为 0 字节，目录中没有遗留 `.xsh-part` 检查点 |
| 内置 RDP 独立加载 | 仅使用自身目录及系统依赖完成加载和初始化，无测试 peer 入口 |
| 安装后的 RDP DLL | 与本轮构建产物 SHA-256 一致，实际客户端进程已加载该库 |

本次没有重新进行真实远程 RDP 会话测试；相关回归覆盖来自本轮 `test-peer` 工作区测试。macOS 安装包由 GitHub Actions 在对应平台构建和验证。

## 本地产物

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| `target/release/bundle/nsis/XSH_0.2.4_x64-setup.exe` | 9681642 | `3372e51f9f81ba9e20cf811e45d020cc1743e6f6721e5b6cbd87f269b06d75ec` |
| `target/release/bundle/msi/XSH_0.2.4_x64_en-US.msi` | 13418496 | `b1d770972197b7a1be14aa30192cacc3d6f425e9954e1ff6969c7b7811945d5f` |
| `target/release/xsh-rdp-native.dll` | 12107776 | `2d414ed0ae00fe4984f6eca52678d2f8aa187d6d5b98be935fe2db9577137854` |

检查日志、安装结果与真实下载证明保存在被 Git 忽略的 `output/release-0.2.4/`。本地安装包与 GitHub Actions 重新构建的发布包分别生成，不能据此假设二者摘要相同。
