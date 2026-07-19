#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "此脚本只能在 macOS 上运行。" >&2
  exit 1
fi

if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "检测到 APPLE_SIGNING_IDENTITY=${APPLE_SIGNING_IDENTITY}" >&2
  echo "个人免费构建不会使用付费 Developer ID 证书；请取消该环境变量后重试。" >&2
  exit 1
fi

# Do not pass a signing identity. Tauri/codesign will produce an ad-hoc
# locally usable app, which is sufficient for personal use on this Mac.
if ! command -v pnpm >/dev/null 2>&1; then
  echo "未找到 pnpm。请先执行：corepack enable && corepack prepare pnpm@11.10.0 --activate" >&2
  exit 1
fi
pnpm --filter desktop exec tauri build --bundles app

APP_PATH="$ROOT_DIR/target/release/bundle/macos/XSH.app"
if [[ ! -d "$APP_PATH" ]]; then
  echo "构建完成，但没有找到应用：$APP_PATH" >&2
  exit 1
fi

SIGNING_INFO="$(codesign -dv --verbose=4 "$APP_PATH" 2>&1 || true)"
if ! grep -q 'Signature=adhoc' <<<"$SIGNING_INFO"; then
  echo "应用不是预期的 ad-hoc 签名，已停止。" >&2
  printf '%s\n' "$SIGNING_INFO" >&2
  exit 1
fi

ARCHIVE_PATH="$ROOT_DIR/target/release/bundle/macos/XSH-personal-macos.zip"
rm -f "$ARCHIVE_PATH"
ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$ARCHIVE_PATH"

echo
echo "个人免费构建完成："
echo "  $APP_PATH"
echo "  $ARCHIVE_PATH"
echo
echo "签名状态：ad-hoc（仅用于本机个人使用，不需要 Apple Developer Program）"
echo "首次打开：Finder 中右键 XSH.app → 打开 → 再点一次“打开”。"
echo "不要删除/移动应用后再从未知来源重复运行，否则 macOS 可能再次显示安全提示。"
