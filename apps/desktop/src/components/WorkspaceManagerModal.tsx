import { useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Download, FolderOpen, RefreshCw, Save, Trash2, Upload, X } from "lucide-react";
import { api } from "../api";
import {
  createNamedWorkspace,
  loadNamedWorkspaces,
  parseNamedWorkspaces,
  saveNamedWorkspaces,
  serializeNamedWorkspaces,
  updateNamedWorkspace,
  type NamedWorkspace,
  type WorkspaceSnapshot,
} from "../workspace-state";

interface WorkspaceManagerModalProps {
  currentSnapshot: Omit<WorkspaceSnapshot, "version">;
  onOpen: (workspace: NamedWorkspace) => void;
  onClose: () => void;
  onToast: (message: string) => void;
}

export function WorkspaceManagerModal({ currentSnapshot, onOpen, onClose, onToast }: WorkspaceManagerModalProps) {
  const [workspaces, setWorkspaces] = useState<NamedWorkspace[]>(() => loadNamedWorkspaces());
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const persist = (next: NamedWorkspace[]) => {
    const sorted = [...next]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 24);
    setWorkspaces(sorted);
    saveNamedWorkspaces(sorted);
  };

  const saveCurrent = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("请输入工作区名称。");
      return;
    }
    if (workspaces.some((workspace) => workspace.name.toLowerCase() === trimmed.toLowerCase())) {
      setError("已经存在同名工作区，请直接更新现有工作区。");
      return;
    }
    const workspace = createNamedWorkspace(trimmed, currentSnapshot);
    persist([workspace, ...workspaces]);
    setName("");
    setError(null);
    onToast(`已保存工作区：${workspace.name}`);
  };

  const overwrite = (workspace: NamedWorkspace) => {
    if (!window.confirm(`使用当前标签和分屏布局覆盖工作区“${workspace.name}”？`)) return;
    persist(workspaces.map((candidate) => candidate.id === workspace.id
      ? updateNamedWorkspace(candidate, { snapshot: currentSnapshot })
      : candidate));
    onToast(`已更新工作区：${workspace.name}`);
  };

  const rename = (workspace: NamedWorkspace) => {
    const nextName = window.prompt("重命名工作区", workspace.name)?.trim();
    if (!nextName || nextName === workspace.name) return;
    if (workspaces.some((candidate) => candidate.id !== workspace.id && candidate.name.toLowerCase() === nextName.toLowerCase())) {
      setError("已经存在同名工作区。");
      return;
    }
    persist(workspaces.map((candidate) => candidate.id === workspace.id
      ? updateNamedWorkspace(candidate, { name: nextName })
      : candidate));
  };

  const remove = (workspace: NamedWorkspace) => {
    if (!window.confirm(`确定删除工作区“${workspace.name}”？会话本身不会被删除。`)) return;
    persist(workspaces.filter((candidate) => candidate.id !== workspace.id));
    onToast(`已删除工作区：${workspace.name}`);
  };

  const exportWorkspaces = async () => {
    if (workspaces.length === 0) {
      setError("当前没有可导出的命名工作区。");
      return;
    }
    const targetPath = await save({
      title: "导出 XSH 工作区",
      defaultPath: `xsh-workspaces-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "XSH 工作区", extensions: ["json"] }],
    });
    if (!targetPath) return;
    try {
      await api.writeTextFile(targetPath, serializeNamedWorkspaces(workspaces));
      setError(null);
      onToast(`已导出 ${workspaces.length} 个工作区；文件不包含凭据或终端内容。`);
    } catch (caught) {
      setError(`导出失败：${String(caught)}`);
    }
  };

  const importWorkspaces = async () => {
    const sourcePath = await open({
      title: "导入 XSH 工作区",
      multiple: false,
      directory: false,
      filters: [{ name: "XSH 工作区", extensions: ["json"] }],
    });
    if (typeof sourcePath !== "string") return;
    try {
      const imported = parseNamedWorkspaces(await api.readTextFile(sourcePath));
      if (imported.length === 0) {
        setError("文件中没有命名工作区。");
        return;
      }
      const usedIds = new Set(workspaces.map((workspace) => workspace.id));
      const usedNames = new Set(workspaces.map((workspace) => workspace.name.toLowerCase()));
      const additions = imported.map((workspace) => {
        const id = usedIds.has(workspace.id) ? crypto.randomUUID() : workspace.id;
        usedIds.add(id);
        const name = uniqueWorkspaceName(workspace.name, usedNames);
        usedNames.add(name.toLowerCase());
        return { ...workspace, id, name };
      });
      const availableSlots = Math.max(0, 24 - workspaces.length);
      const accepted = additions.slice(0, availableSlots);
      if (accepted.length === 0) {
        setError("命名工作区已达到 24 个上限，请先删除不再使用的工作区。");
        return;
      }
      persist([...workspaces, ...accepted]);
      setError(null);
      onToast(accepted.length < additions.length
        ? `已导入 ${accepted.length} 个工作区；其余因 24 个上限未保留。`
        : `已导入 ${accepted.length} 个工作区。缺失的会话请先导入会话配置。`);
    } catch (caught) {
      setError(`导入失败：${String(caught)}`);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal workspace-manager-modal" role="dialog" aria-modal="true" aria-label="工作区管理">
        <header className="modal-header">
          <div><strong>工作区管理</strong><span>保存并快速恢复不同项目的标签与分屏布局</span></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </header>

        <div className="workspace-manager-body">
          <div className="workspace-save-row">
            <input
              value={name}
              onChange={(event) => { setName(event.target.value); setError(null); }}
              onKeyDown={(event) => { if (event.key === "Enter") saveCurrent(); }}
              placeholder="例如：生产环境巡检"
              maxLength={64}
              autoFocus
            />
            <button className="primary-button" onClick={saveCurrent}><Save size={14} />保存当前</button>
          </div>
          <p className="workspace-security-note">只保存会话 ID、标签顺序、锁定/颜色状态和分屏布局，不保存密码、终端输出或命令。跨机器使用时请同时导入会话配置。</p>
          <div className="workspace-file-actions">
            <button className="secondary-button" onClick={() => void importWorkspaces()}><Upload size={13} />导入工作区</button>
            <button className="secondary-button" onClick={() => void exportWorkspaces()} disabled={workspaces.length === 0}><Download size={13} />导出全部</button>
          </div>
          {error && <div className="form-error">{error}</div>}

          <div className="workspace-list">
            {workspaces.length === 0 && <div className="panel-message">还没有命名工作区。</div>}
            {workspaces.map((workspace) => (
              <article className="workspace-row" key={workspace.id}>
                <div className="workspace-row-copy">
                  <strong>{workspace.name}</strong>
                  <small>
                    {workspace.snapshot.tabs.length} 个标签 · {layoutLabel(workspace.snapshot.paneLayout)} · {new Date(workspace.updatedAt).toLocaleString()}
                  </small>
                </div>
                <div className="workspace-row-actions">
                  <button className="primary-button" onClick={() => onOpen(workspace)}><FolderOpen size={13} />打开</button>
                  <button className="secondary-button" onClick={() => overwrite(workspace)} title="使用当前工作区覆盖"><RefreshCw size={13} /></button>
                  <button className="secondary-button" onClick={() => rename(workspace)}>重命名</button>
                  <button className="danger-button" onClick={() => remove(workspace)} title="删除工作区"><Trash2 size={13} /></button>
                </div>
              </article>
            ))}
          </div>
        </div>

        <footer className="modal-footer">
          <span />
          <button className="secondary-button" onClick={onClose}>关闭</button>
        </footer>
      </section>
    </div>
  );
}

function layoutLabel(layout: WorkspaceSnapshot["paneLayout"]): string {
  if (layout === "vertical") return "左右分屏";
  if (layout === "horizontal") return "上下分屏";
  return "单终端";
}

function uniqueWorkspaceName(name: string, usedNames: Set<string>): string {
  const base = name.trim().slice(0, 64) || "导入的工作区";
  if (!usedNames.has(base.toLowerCase())) return base;
  for (let index = 2; index <= 999; index += 1) {
    const suffix = `（导入 ${index}）`;
    const candidate = `${base.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
    if (!usedNames.has(candidate.toLowerCase())) return candidate;
  }
  return `${base.slice(0, 55)}-${crypto.randomUUID().slice(0, 8)}`;
}
