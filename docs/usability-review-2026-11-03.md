# 使用流程与配色检查

## 修改前的上下文图

| 文件 | 用途与检查点 |
| --- | --- |
| `RemoteDesktopPane.tsx` | 直连 / SSH 远程桌面的排队、主动断开、异常重连 |
| `SettingsModal.tsx` | 指纹列表失败恢复、界面和终端配色入口 |
| `themes.ts`、`themes.css` | 界面语义色与 ANSI 终端色板，保持旧主题 ID |
| `preferences.ts`、`SessionEditor.tsx` | 主题持久化及单个会话覆盖全局配色 |
| `tests/themes.test.ts` | 色板完整性、对比度、优先级、256 色兼容 |
| `apps/desktop/tests/workflow-fixture.*`、`tests/ui-workflows.py` | 实际 React 组件的浏览器回归，IPC 使用隔离夹具 |

检查沿用现有六路连接名额、会话配色优先级和主题令牌，不改数据库或凭据格式。原安装更新修复与本次经验证的改动一并提交。

## 已复现并修复

1. 直连远程桌面挂载时无条件报告 `connecting`，会覆盖父级的 `queued` 状态；SSH 桌面的排队 effect 则把存活判断写反。现在排队期间保持 `queued`，连接按钮不可绕过名额，分配名额后才启动。
2. SSH 桌面的主动断开只调用后端 disconnect，随后被 state 事件当成网络掉线，5 秒后又自动连接。现在主动断开关闭重连开关、取消定时器、废弃晚到回调并清理查看器；意外断线仍按设置重连。
3. 建立 SSH 通道期间原按钮被禁用，没有取消入口。现在可取消连接，晚到的连接 ID 会立即释放，不再打开查看器。
4. 服务器指纹列表第一次读取失败后被标记为已加载，缺少原地重试。现在错误旁提供「重新读取信任记录」，无需关闭设置。
5. SSH 桌面的输出消费确认定时器没有核对连接代次，快速断开再连接时，旧输出字节可能确认给新连接。现在废弃旧代次的延迟确认；回归同时确认新连接的正常输出仍被正确确认。

浏览器测试先得到排队、主动断开、错误恢复的失败结果，修复后全部通过。检查范围是上述连接生命周期、设置失败恢复和配色，不代表对所有协议及平台做了完整人工验收。

## 配色

- 新增「纯黑」「纯白」界面主题，保留已有 8 个主题和用户已保存的主题 ID。
- 新增「黑底白字」「白底黑字」「柔灰黑」「纸白」终端配色。只改变默认色和 ANSI 0–15 色，16–255 色继续使用标准 xterm 色立方和灰阶。
- 所有终端配色明确设置选区前景色，所选文本对比度至少 4.5:1；默认正文至少 7:1。新界面的正文、次级文字和强调色在常见表面通过 4.5:1 检查。
- 参考 [iTerm2 的颜色配置方式](https://iterm2.com/documentation-preferences-profiles-colors.html)，采用独立终端背景、光标、选区和 ANSI 色；本次是 XSH 配色设计，没有导入或宣称逐色复制 iTerm2 官方预设。

## 验证入口与结果

```powershell
pnpm test
pnpm build
# 另开终端运行 Vite，再执行真实组件回归。
pnpm --filter desktop exec vite --host 127.0.0.1 --port 1420 --strictPort
python -m pip install playwright
python -m playwright install chromium --only-shell
python -X utf8 tests/ui-workflows.py
```

159 项 JavaScript 测试通过，TypeScript 与生产构建通过。8 组浏览器回归通过：直连排队、SSH 排队、主动断开及再次连接、掉线自动重连、旧输出确认隔离、连接中取消及晚到结果释放、指纹读取重试、主题保存恢复与预览。主题验证包含键盘选择及 980/1050/1360 像素宽度下无横向溢出、保存按钮可见。已查看黑白主题的实际组件截图。

浏览器测试使用实际 React 组件和隔离的 IPC / 连接事件夹具，不访问真实服务器或用户凭据。当前未重新连接真实远程 RDP 主机；原安装修复阶段的 Rust 工作区测试为 206 项通过、1 项联网测试默认跳过，Clippy 通过。本轮没有进一步改动 Rust 协议代码。

截图与回归结果保存在 Git 忽略的 `output/ux-review/`。最终 NSIS、MSI 包构建成功，本机覆盖安装耗时 1.61 秒、退出码 0；程序已重新打开。数据库、凭据密钥、AI 设置与本次覆盖前的摘要完全一致。安装前额外备份旧程序、Roaming 数据和 Local WebView 数据至 `%LOCALAPPDATA%/XSH-backups/20261103-120318-before-ux-themes/`。

本轮仍使用 v0.2.4 版本号，本地构建包含这次修复与配色；提交代码不会自动发布新的正式版本标签。

| 最终本地产物 | SHA-256 |
| --- | --- |
| `target/release/bundle/nsis/XSH_0.2.4_x64-setup.exe` | `08299c61a1d08f331ac8d9cc0d2848eaf553a9a19926e2c809e6fbd2b72de185` |
| `target/release/bundle/msi/XSH_0.2.4_x64_en-US.msi` | `f1e57ba7ad9afb03298d507c00ce3ec277921806950b3ce065e87b32497f3ab5` |
