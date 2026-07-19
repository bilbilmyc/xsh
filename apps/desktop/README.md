# XSH Desktop

这是 XSH 的 Tauri 2 桌面壳和 React/TypeScript 前端。

## 开发

从仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm --filter desktop run dev
```

前端只构建不启动 Tauri：

```bash
pnpm --filter desktop run build
```

后端位于 `src-tauri`，跨 crate 的 SSH、SFTP、存储和安全能力位于仓库根目录的 `crates/` 中。

## 约定

- 使用 pnpm，不提交 `package-lock.json` 或 `npm-shrinkwrap.json`。
- 终端和凭据相关改动必须同时检查 macOS 与 Windows 行为，避免抢占远端 Shell 的 Ctrl 控制键。
- 不在前端 localStorage、导出 JSON、日志或命令片段中保存密码、Key Passphrase、Token 或私钥内容。
