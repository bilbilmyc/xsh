const UPDATE_TARGET_KEY = "xsh.update-target-version";
type UpdateStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function rememberUpdateTarget(storage: UpdateStorage, version: string | null) {
  try {
    if (version) storage.setItem(UPDATE_TARGET_KEY, version);
    else storage.removeItem(UPDATE_TARGET_KEY);
  } catch {
    // 无法保存提示状态不应阻止已校验的更新安装。
  }
}

export function consumeUpdateResult(storage: UpdateStorage, currentVersion: string): string | null {
  try {
    const target = storage.getItem(UPDATE_TARGET_KEY);
    if (!target) return null;
    storage.removeItem(UPDATE_TARGET_KEY);
    return target === currentVersion
      ? `XSH 已更新至 v${currentVersion}。`
      : `上次更新未确认完成，当前运行 v${currentVersion}。可在设置 → 应用更新中检查。`;
  } catch {
    return null;
  }
}
