# 参与开发 XSH

感谢你关注 XSH。项目目前以 macOS 日常使用和 Windows 实机验收为主，欢迎提交可复现的 bug、跨平台兼容性反馈和小范围改进。

## 开发环境

- Rust stable
- Node.js 22+
- pnpm 11.10+
- macOS 或 Windows 对应的 Tauri 2 原生依赖

```bash
corepack enable
corepack prepare pnpm@11.10.0 --activate
pnpm install --frozen-lockfile
```

## 提交前检查

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm run build
```

如果改动了打包脚本或 Tauri 配置，还应在对应平台执行：

```bash
pnpm run build:macos:personal   # macOS
pnpm run build:windows          # Windows
```

## 提交规范

提交信息建议使用 Conventional Commits：

- `feat:` 新功能
- `fix:` bug 修复
- `refactor:` 重构
- `test:` 测试
- `docs:` 文档
- `chore:` 工程配置

一个提交尽量只解决一个问题。涉及 UI 的改动请附截图或录屏，并说明测试平台、系统版本和复现步骤。

## 安全与凭据

不要在 issue、PR、日志、截图、测试代码或提交历史中写入真实的主机、用户名、密码、Token、私钥和 Key Passphrase。示例主机请使用 `example.com` 或 RFC 5737 文档地址，示例凭据使用明显的占位符。

安全漏洞请按照 [SECURITY.md](SECURITY.md) 的方式报告，不要公开创建 issue。
