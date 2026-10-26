import { Channel, invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  available: boolean;
  releaseNotes: string;
  publishedAt: string | null;
  downloadName: string | null;
  downloadSize: number | null;
  downloadUnavailableReason: string | null;
}

interface DownloadProgress {
  downloaded: number;
  total: number;
}

type UpdatePhase = "idle" | "checking" | "available" | "current" | "downloading" | "ready" | "installing" | "error";

interface UpdateSnapshot {
  phase: UpdatePhase;
  info: UpdateInfo | null;
  progress: DownloadProgress | null;
  error: string | null;
}

// Keep downloads and their progress alive when the settings window is closed.
let snapshot: UpdateSnapshot = { phase: "idle", info: null, progress: null, error: null };
const listeners = new Set<() => void>();
const getSnapshot = () => snapshot;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

function update(patch: Partial<UpdateSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

export function useAppUpdate() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export async function checkForUpdates({ force = false }: { force?: boolean } = {}) {
  if (["checking", "downloading", "installing"].includes(snapshot.phase)) return;
  if (snapshot.phase === "ready" && !force) return;
  update({ phase: "checking", info: null, progress: null, error: null });
  try {
    const info = await invoke<UpdateInfo>("check_for_updates");
    update({ phase: info.available ? "available" : "current", info });
  } catch (caught) {
    update({ phase: "error", error: String(caught) });
  }
}

export async function downloadUpdate() {
  if (snapshot.phase !== "available" || !snapshot.info?.downloadName) return;
  update({ phase: "downloading", progress: null, error: null });
  const onProgress = new Channel<DownloadProgress>();
  onProgress.onmessage = (progress) => {
    if (snapshot.phase === "downloading") update({ progress });
  };
  try {
    await invoke<void>("download_update", { onProgress });
    update({ phase: "ready" });
  } catch (caught) {
    update({ phase: "available", progress: null, error: String(caught) });
  }
}

export async function installUpdate() {
  if (snapshot.phase !== "ready") return;
  update({ phase: "installing", error: null });
  try {
    await invoke<void>("install_update");
  } catch (caught) {
    update({ phase: "ready", error: String(caught) });
  }
}
