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
launcher_pid=""
mounted=0

cleanup() {
  if [[ -n "$application_pid" ]]; then
    kill -TERM "$application_pid" 2>/dev/null || true
    wait "$application_pid" 2>/dev/null || true
  fi
  if [[ -n "$launcher_pid" ]]; then
    kill -TERM "$launcher_pid" 2>/dev/null || true
    wait "$launcher_pid" 2>/dev/null || true
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
kill -TERM "$application_pid"
wait "$application_pid" 2>/dev/null || true
application_pid=""

# Finder launches applications through LaunchServices. Check that route too;
# a direct executable launch alone did not catch macOS 15's signing rejection.
executable_path="$app_path/Contents/MacOS/$executable"
executable_pattern="$(node -e 'console.log("^" + process.argv[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$")' "$executable_path")"
env -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH \
  open -n -W "$app_path" >"$verification_dir/launch-services.log" 2>&1 &
launcher_pid=$!
for ((attempt = 0; attempt < 10; attempt++)); do
  sleep 1
  application_pid="$(pgrep -f "$executable_pattern" | head -n 1 || true)"
  if [[ -n "$application_pid" ]]; then
    break
  fi
  if ! kill -0 "$launcher_pid" 2>/dev/null; then
    cat "$verification_dir/launch-services.log"
    echo "FAIL: LaunchServices could not start the installed macOS app." >&2
    exit 1
  fi
done
if [[ -z "$application_pid" ]]; then
  cat "$verification_dir/launch-services.log"
  echo "FAIL: timed out waiting for the installed macOS app to launch." >&2
  exit 1
fi
for ((attempt = 0; attempt < 10; attempt++)); do
  sleep 1
  if ! kill -0 "$application_pid" 2>/dev/null; then
    cat "$verification_dir/launch-services.log"
    echo "FAIL: installed macOS app exited after starting through LaunchServices." >&2
    exit 1
  fi
done
echo "PASS: application installed from the DMG stayed running through LaunchServices for 10 seconds."
