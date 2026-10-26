#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS bundle launch verification requires macOS." >&2
  exit 1
fi
if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo "Usage: bash scripts/verify-macos-bundle.sh <XSH.dmg>" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temporary_root="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
verification_dir="$(mktemp -d "$temporary_root/xsh-macos-verify.XXXXXX")"
[[ "$verification_dir" == "$temporary_root"/xsh-macos-verify.* ]] || exit 1
mount_dir="$verification_dir/mounted"
application_pid=""
mounted=0

cleanup() {
  if [[ -n "$application_pid" ]]; then
    kill -TERM "$application_pid" 2>/dev/null || true
    wait "$application_pid" 2>/dev/null || true
  fi
  if [[ "$mounted" == 1 ]]; then
    hdiutil detach "$mount_dir" -quiet || true
  fi
  rm -rf -- "$verification_dir"
}
trap cleanup EXIT

mkdir -p "$mount_dir" "$verification_dir/installed"
hdiutil attach "$1" -readonly -nobrowse -mountpoint "$mount_dir" -quiet
mounted=1
app_path="$verification_dir/installed/XSH.app"
ditto "$mount_dir/XSH.app" "$app_path"
hdiutil detach "$mount_dir" -quiet
mounted=0

node "$script_dir/verify-macos-bundle.mjs" "$app_path"
codesign --verify --deep --strict "$app_path"
executable=$(/usr/libexec/PlistBuddy -c "Print CFBundleExecutable" "$app_path/Contents/Info.plist")
# Launch the copy installed from the DMG, away from Cargo's build libraries.
env -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH \
  "$app_path/Contents/MacOS/$executable" >"$verification_dir/launch.log" 2>&1 &
application_pid=$!
for ((attempt = 0; attempt < 10; attempt++)); do
  sleep 1
  if ! kill -0 "$application_pid" 2>/dev/null; then
    status=0
    wait "$application_pid" || status=$?
    application_pid=""
    cat "$verification_dir/launch.log"
    echo "FAIL: installed macOS app exited during startup (status $status)." >&2
    exit 1
  fi
done
echo "PASS: application installed from the DMG stayed running for 10 seconds."
