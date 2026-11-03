// 仅由浏览器回归测试加载；使用实际组件，IPC 替换为确定性的本地夹具。
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../src/api";
import { RemoteDesktopPane } from "../src/components/RemoteDesktopPane";
import { SettingsModal } from "../src/components/SettingsModal";
import { DialogHost } from "../src/components/DialogHost";
import { ModalFocusManager } from "../src/components/ModalFocusManager";
import { applyPreferences, defaultPreferences, loadPreferences, savePreferences } from "../src/preferences";
import { defaultTerminalProfile, type SavedSession } from "../src/types";
import "../src/App.css";

const scenario = new URLSearchParams(location.search).get("case") ?? "appearance";
const qa = { connections: 0, disconnects: 0, desktops: 0, reads: 0, states: [] as string[], acknowledgements: [] as Array<{ id: string; bytes: number }>, drop: () => {}, output: () => {}, finishConnect: () => {} };
Object.assign(window, { __qa: qa, __TAURI_INTERNALS__: { transformCallback: () => 1, unregisterCallback() {}, invoke: async () => null } });
const session: SavedSession = {
  id: "fixture", name: "回归测试桌面", kind: "remoteDesktop", groupId: null,
  host: "127.0.0.1", port: 22, username: "fixture", proxyJump: null,
  proxyJumpUsername: null, proxyJumpAuthentication: null, authentication: { type: "agent", identityFingerprint: null },
  terminal: defaultTerminalProfile(), initialDirectory: null, startupCommand: null,
  keepaliveSeconds: 30, autoReconnect: true, environment: null, color: null, notes: null,
  tags: [], favorite: false, forwardProfiles: [], createdAt: "", updatedAt: "",
  remoteDesktop: { kind: "rdp", transport: scenario.includes("direct") ? "direct" : "sshTunnel",
    targetHost: "127.0.0.1", targetPort: 3389, autoStart: true, launchViewer: true,
    viewerCommand: null, username: "fixture", credentialRef: "fixture-only", forwardProfileId: null },
};
api.connectTerminal = async (_sessionId, _columns, _rows, channel) => {
  const id = `ssh-${++qa.connections}`;
  qa.drop = () => channel.onmessage({ type: "stateChanged", payload: "disconnected" });
  qa.output = () => channel.onmessage(new ArrayBuffer(1024));
  api.disconnectTerminal = async () => { qa.disconnects++; qa.drop(); };
  if (scenario === "cancel-connecting") await new Promise<void>((resolve) => { qa.finishConnect = resolve; });
  setTimeout(() => channel.onmessage({ type: "stateChanged", payload: "connected" }), 0);
  return id;
};
api.startRemoteDesktop = async () => ({ forward: { forwardId: "forward", bindHost: "127.0.0.1", bindPort: 3389 } } as Awaited<ReturnType<typeof api.startRemoteDesktop>>);
api.startRdpDesktop = async () => `rdp-${++qa.desktops}`;
api.closeRdpDesktop = async () => {};
api.rdpDesktopInput = async () => {};
api.terminalAcknowledgeOutput = async (id, bytes) => { qa.acknowledgements.push({ id, bytes }); };
api.listForwards = async () => [];
api.listKnownHosts = async () => {
  if (++qa.reads === 1) throw new Error("模拟暂时读取失败");
  return [];
};

function Fixture() {
  const [enabled, setEnabled] = useState(!scenario.startsWith("queued"));
  const [preferences, setPreferences] = useState(loadPreferences);
  const [settings, setSettings] = useState(true);
  const [notice, setNotice] = useState("");
  applyPreferences(preferences);
  if (scenario === "security" || scenario === "appearance") return <>
    <button onClick={() => setSettings(true)}>重新打开设置</button><p role="status">{notice}</p>
    {settings && <SettingsModal preferences={preferences} initialSection={scenario} onToast={setNotice} onClose={() => setSettings(false)} onSave={(value) => { savePreferences(value); setPreferences(loadPreferences()); }} />}
    <ModalFocusManager /><DialogHost />
  </>;
  return <><button style={{ position: "fixed", bottom: 8, right: 8, zIndex: 9999 }} onClick={() => setEnabled(true)}>分配连接名额</button>
    <RemoteDesktopPane session={session} visible focused connectionEnabled={enabled}
      onStateChange={(value) => { qa.states.push(value); }} onConnectionChange={() => {}} onFocus={() => {}} onEditSession={() => {}} />
    <DialogHost />
  </>;
}
applyPreferences(defaultPreferences);
createRoot(document.getElementById("root")!).render(<Fixture />);
