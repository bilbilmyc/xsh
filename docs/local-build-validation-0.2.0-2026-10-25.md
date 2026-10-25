# XSH v0.2 正式版本地构建与覆盖安装

日期：2026-10-25，Asia/Shanghai。环境：Windows x64、MSVC 14.44、Rust stable。正式版本号为 `0.2.0`，对外称 v0.2。

## 版本与构建

根包、桌面包、Tauri 配置、Rust 工作区及 Cargo 锁文件中的七个工作区包均已统一为 `0.2.0`。界面状态栏从桌面包读取版本，无需单独维护显示字符串。历史验收文档保留当时的版本号。

通过 `cargo update --offline --workspace` 更新工作区锁文件，仅升级七个本地包的版本。使用固定来源构建产生的静态 OpenSSL 目录运行 `scripts/build-windows.ps1 -SkipInstall`，完成前端生产构建、release 后端编译和 NSIS / MSI 打包。

| 检查 | 结果 |
| --- | --- |
| JSON 清单与 Cargo metadata 版本一致性 | 全部为 `0.2.0` |
| `pnpm test` | 150 项通过，0 项失败 |
| TypeScript / Vite 生产构建 | 通过，保留已有的 TerminalPane chunk 大小提示 |
| Windows NSIS / MSI 构建 | 两种安装包均生成成功 |
| 程序文件版本 / MSI ProductVersion | 均为 `0.2.0` |
| 内置 RDP DLL 独立加载 | 成功加载并初始化，仅使用自身目录与 Windows 系统依赖，未包含测试 peer 入口 |
| `git diff --check` | 通过 |

本轮只调整版本信息和发行说明，没有修改运行逻辑。此前的 Rust、原生协议、浏览器和真实 Windows RDP 验证见 [远程桌面验收记录](local-build-validation-remote-desktop-2026-10-25.md)，这些检查没有在本轮全部重复执行。

## 覆盖安装与启动

21:18 使用新 NSIS 安装包，以 `/S /UPDATE` 覆盖 `%LOCALAPPDATA%\XSH`，安装器退出码为 0。安装后、首次启动前，已有应用数据目录顶层的数据库、凭据密钥和配置文件 SHA-256 与安装前一致。

已启动安装目录中的 XSH，确认进程正常响应并实际加载同目录的 `xsh-rdp-native.dll`，其 SHA-256 与本轮构建产物一致。Windows 卸载注册表版本为 `0.2.0`，通过真实窗口的可访问性信息确认状态栏显示 `v0.2.0`，原有八个保存会话可见。

旧安装目录的副本保存在被 Git 忽略的 `output/installed-xsh-before-0.2.0-20261025-211807/application/`。

## 最终产物

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| `target/release/bundle/nsis/XSH_0.2.0_x64-setup.exe` | 9596647 | `537cdad5dbec506a0f0d4508c5a8b6ccec01d802b3ef6e9da776461b7ba0724c` |
| `target/release/bundle/msi/XSH_0.2.0_x64_en-US.msi` | 13303808 | `1625e89296b9a0e76f05faf1dccde07917ed3257138d6fedacdef44e477bfa03` |
| `target/release/xsh-rdp-native.dll` | 12107776 | `4fc380b4d1496add811237a45ca690c2d020b487bf4c7efd22b31b878a23edc3` |
| 已安装 `desktop.exe` | 27529728 | `c6fae6ba28060e95e26a8bc6fd00cf1751f68cee8e6b7797ee0b3bcbdfbc8554` |

构建日志、前端测试结果、产物清单和安装结果位于被 Git 忽略的 `output/build-windows-0.2.0-2026-10-25.log` 与 `output/version-0.2.0-*`。
