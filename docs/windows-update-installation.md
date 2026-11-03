# Windows 更新安装

本文的首轮验证使用未发版的 v0.2.4 修复构建；后续正式发版与真实更新接口发现的栈溢出修复见 [v0.2.6 更新安装复测](windows-update-stack-overflow-2026-11-03.md)。

## Context Map

| 文件 | 职责与本次修改 |
| --- | --- |
| `apps/desktop/src-tauri/src/updates.rs` | 校验下载后启动安装器，委托 Windows 参数构造 |
| `apps/desktop/src-tauri/src/windows_installer.rs` | Windows 安装命令及回归测试，覆盖模式、可见进度、重启与安装目录 |
| `apps/desktop/src-tauri/windows/installer.nsi` | 固定版本 Tauri NSIS 模板；普通升级直接覆盖，显示明确的完成页 |
| `apps/desktop/src-tauri/tauri.windows.conf.json` | 接入模板和中文界面 |
| `apps/desktop/src/components/AppUpdateSettings.tsx` | 安装提示与实际行为一致 |
| `apps/desktop/src/update-result.ts` / `tests/update-result.test.ts` | 重启后按实际运行版本确认安装结果，只提示一次 |

依赖：Tauri CLI 2.11.4 的 NSIS 模板、系统 NSIS 插件、现有 SHA-256 校验及更新互斥锁。
参考：上游 NSIS 的 `/P`（显示安装进度）、`/UPDATE`（跳过旧 NSIS 卸载）、`/R`（成功重启）。
风险审阅：不改数据库、凭据、下载来源或校验机制；MSI 迁移及降级分支仍交由上游处理；模板需要随 Tauri CLI 升级复核。

## 原因

原应用内安装直接执行 EXE，没有传入更新参数，因此进入普通安装向导。上游升级页面默认选中先卸载；卸载时隐藏安装窗口并同步等待旧卸载器，造成缺少进度反馈。原模板安装完仍停在进度页，需要再次点击下一步。

## 验证

日期：2026-11-03，Windows x64。源代码从 `13aa071` 快进至官方主线 `ec4df39`（v0.2.4），在其上完成本地修复；没有更改发布版本号或发布 GitHub Release。

| 场景 | 实际结果 |
| --- | --- |
| 原始启动参数回归测试 | 缺少 `/UPDATE /P /R` 的测试先失败，修复后通过；MSI 保留完整向导，并使用 `/norestart` |
| 官方包 v0.2.3 → v0.2.4，带更新参数 | 5.96 秒，退出码 0，未观察到旧卸载器，自动启动新版 |
| 官方包同版本覆盖，仅 `/P` | 3.13 秒，确实观察到旧 `uninstall.exe` 进程，复现冗余卸载 |
| 修复包同版本覆盖，仅 `/P` | 2.83 秒，退出码 0，没有旧卸载器；与上行使用相同参数 |
| 修复包由生产 `windows_installer::command` 启动 | 2.06 秒，退出码 0，自动重新打开已安装的 XSH |
| 本机启动验收 | 原生可访问性界面显示 `v0.2.4`、8 个会话；进程响应正常，注册表版本为 0.2.4 |
| 数据保留 | 最终关闭程序后核对数据库、凭据密钥、AI 配置 SHA-256，均与安装前逐字节一致；数据库完整性检查为 `ok`，8 个会话、5 个分组均保留 |
| 原生组件 | RDP DLL 独立加载与初始化通过；已安装程序实际加载该 DLL，与本轮构建的 DLL 摘要相同 |
| 自动检查 | 159 项 JavaScript 测试、206 项 Rust 工作区 release 测试通过；1 项联网安装包测试按默认配置跳过；`cargo clippy --workspace --release --all-targets -- -D warnings`、格式检查与生产前端构建通过 |
| 安装包 | NSIS EXE 和 MSI 均构建成功；本机实际安装验证使用 NSIS |

这些耗时是本机多次测试的结果，包含不同缓存状态，不能据此推算所有机器的提速比例。官方包 SHA-256 已与 GitHub Release 元数据核对；联网测试的默认跳过不代表没有验证官方下载安装包。

窗口截图及鼠标自动化遇到 `coordinate input geometry is unavailable` / `FrameArrived timed out`。实装使用可见进度模式及进程退出结果，启动界面通过原生可访问性树确认。完整手工向导的逐页点击未完成；新完成页已通过 NSIS 编译和生成脚本检查。重启结果提示的成功、未完成及存储异常分支由回归测试覆盖，没有把模拟提示当作本次真实升级提示。

本轮安装备份在本机 `%LOCALAPPDATA%/XSH-backups/20261103-111606-before-upgrade-fix/`，包含旧程序及关闭程序后备份的原数据。`local-webview-after-validation` 是验收后的补充备份。恢复旧程序前先退出 XSH；数据库、凭据密钥和配置应作为同一份备份一起恢复。原始日志、安装结果、摘要与测试数据位于 Git 忽略的 `output/upgrade-fix/`。

本地修复包（与官方重新构建产物不同）：

| 产物 | SHA-256 |
| --- | --- |
| `output/upgrade-fix/validated-XSH_0.2.4_x64-setup.exe` | `e71bc29a1e8a9441481849e6bdfbe08e4e12fd41ca68941b5d9f69b00e22c7fa` |
| `output/upgrade-fix/validated-XSH_0.2.4_x64_en-US.msi` | `ad496326c6ce60cb222cc2a2faec1ae4786696c6fb46fa5042df5b4bebd03c0c` |

保留的回归入口：

```powershell
rustc --edition 2024 --test apps/desktop/src-tauri/src/windows_installer.rs -o target/windows-installer-tests.exe
target/windows-installer-tests.exe
pnpm test
cargo test --workspace --release
```

## 模板维护

上游来源：[Tauri CLI 2.11.4 的 NSIS 模板](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)。模板保留上游主体，只修改带 `XSH:` 标记的覆盖与显示行为；构建成功不能替代实际覆盖安装验证。升级 CLI 时须复核模板差异、旧版迁移、路径恢复及完成行为。
