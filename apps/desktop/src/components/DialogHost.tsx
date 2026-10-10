import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, Fingerprint, ShieldAlert } from "lucide-react";
import { writeClipboardText } from "../clipboard";
import type { HostKeyApproval } from "../types";

// In-app replacements for window.confirm / window.prompt. Requests stack and
// only the topmost one renders; every call resolves exactly once.

interface BaseRequest {
  id: number;
  title: string;
  message?: React.ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
}

interface ConfirmRequest extends BaseRequest {
  kind: "confirm";
  resolve: (value: boolean) => void;
}

interface PromptRequest extends BaseRequest {
  kind: "prompt";
  initialValue: string;
  placeholder: string;
  validate?: (value: string) => string | null;
  resolve: (value: string | null) => void;
}

interface HostKeyRequest {
  id: number;
  kind: "hostKey";
  approval: HostKeyApproval;
  protocol: "SSH" | "SFTP";
  resolve: (value: boolean) => void;
}

interface ColorRequest {
  id: number;
  kind: "color";
  title: string;
  message?: React.ReactNode;
  initialColor: string;
  resolve: (value: string | null) => void;
}

type DialogRequest = ConfirmRequest | PromptRequest | HostKeyRequest | ColorRequest;

let nextDialogId = 1;
const pending: DialogRequest[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function finish(request: DialogRequest) {
  const index = pending.indexOf(request);
  if (index >= 0) pending.splice(index, 1);
  emit();
}

export function isDialogOpen(): boolean {
  return pending.length > 0;
}

export function confirmDialog(options: {
  title: string;
  message?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    pending.push({
      id: nextDialogId++,
      kind: "confirm",
      title: options.title,
      message: options.message,
      confirmLabel: options.confirmLabel ?? "确定",
      cancelLabel: options.cancelLabel ?? "取消",
      danger: options.danger,
      resolve,
    });
    emit();
  });
}

export function promptDialog(options: {
  title: string;
  message?: React.ReactNode;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  validate?: (value: string) => string | null;
}): Promise<string | null> {
  return new Promise((resolve) => {
    pending.push({
      id: nextDialogId++,
      kind: "prompt",
      title: options.title,
      message: options.message,
      initialValue: options.initialValue ?? "",
      placeholder: options.placeholder ?? "",
      confirmLabel: options.confirmLabel ?? "确定",
      cancelLabel: options.cancelLabel ?? "取消",
      validate: options.validate,
      resolve,
    });
    emit();
  });
}

export function hostKeyDialog(
  approval: HostKeyApproval,
  protocol: "SSH" | "SFTP",
): Promise<boolean> {
  return new Promise((resolve) => {
    pending.push({
      id: nextDialogId++,
      kind: "hostKey",
      approval,
      protocol,
      resolve,
    });
    emit();
  });
}

export const DIALOG_COLORS = ["#39b8d6", "#58a6ff", "#56d364", "#e3b341", "#ff8a65", "#bc8cff"];

export function colorDialog(options: {
  title: string;
  message?: React.ReactNode;
  initialColor?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    pending.push({
      id: nextDialogId++,
      kind: "color",
      title: options.title,
      message: options.message,
      initialColor: options.initialColor ?? "",
      resolve,
    });
    emit();
  });
}

function useTopDialog(): DialogRequest | null {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((current) => current + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return pending.length > 0 ? pending[pending.length - 1] : null;
}

function ConfirmDialog({ request }: { request: ConfirmRequest }) {
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopImmediatePropagation();
      finish(request);
      request.resolve(false);
    } else if (event.key === "Enter") {
      event.stopImmediatePropagation();
      finish(request);
      request.resolve(true);
    }
  };
  useEffect(() => {
    window.addEventListener("keydown", onKeydown, true);
    return () => window.removeEventListener("keydown", onKeydown, true);
  });
  return (
    <div className="modal-backdrop dialog-backdrop" onMouseDown={() => {
      finish(request);
      request.resolve(false);
    }}>
      <section
        className="dialog-card"
        role="alertdialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h3>{request.danger ? <ShieldAlert size={16} /> : null}{request.title}</h3>
        {request.message && <div className="dialog-message">{request.message}</div>}
        <footer className="dialog-actions">
          <button className="secondary-button" onClick={() => {
            finish(request);
            request.resolve(false);
          }}>{request.cancelLabel}</button>
          <button className={request.danger ? "danger-button" : "primary-button"} onClick={() => {
            finish(request);
            request.resolve(true);
          }}>{request.confirmLabel}</button>
        </footer>
      </section>
    </div>
  );
}

function PromptDialog({ request }: { request: PromptRequest }) {
  const [value, setValue] = useState(request.initialValue);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const submit = () => {
    const validation = request.validate?.(value) ?? null;
    if (validation) {
      setError(validation);
      return;
    }
    finish(request);
    request.resolve(value);
  };
  const cancel = () => {
    finish(request);
    request.resolve(null);
  };
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopImmediatePropagation();
      cancel();
    } else if (event.key === "Enter") {
      event.stopImmediatePropagation();
      submit();
    }
  };
  useEffect(() => {
    window.addEventListener("keydown", onKeydown, true);
    return () => window.removeEventListener("keydown", onKeydown, true);
  });
  return (
    <div className="modal-backdrop dialog-backdrop" onMouseDown={cancel}>
      <section
        className="dialog-card"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h3>{request.title}</h3>
        {request.message && <div className="dialog-message">{request.message}</div>}
        <input
          ref={inputRef}
          className="dialog-input"
          value={value}
          placeholder={request.placeholder}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
          spellCheck={false}
        />
        {error && <div className="form-error">{error}</div>}
        <footer className="dialog-actions">
          <button className="secondary-button" onClick={cancel}>{request.cancelLabel}</button>
          <button className="primary-button" onClick={submit}>{request.confirmLabel}</button>
        </footer>
      </section>
    </div>
  );
}

function HostKeyDialog({ request }: { request: HostKeyRequest }) {
  const [copied, setCopied] = useState(false);
  const { approval, protocol } = request;
  const endpoint = approval.role === "proxyJump" ? "ProxyJump" : "目标服务器";
  const prefix = protocol === "SFTP" ? "SFTP " : "";
  const copyFingerprint = async () => {
    try {
      await writeClipboardText(approval.fingerprint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopImmediatePropagation();
      finish(request);
      request.resolve(false);
    } else if (event.key === "Enter") {
      event.stopImmediatePropagation();
      finish(request);
      request.resolve(true);
    }
  };
  useEffect(() => {
    window.addEventListener("keydown", onKeydown, true);
    return () => window.removeEventListener("keydown", onKeydown, true);
  });
  return (
    <div className="modal-backdrop dialog-backdrop" role="presentation" onMouseDown={() => {
      finish(request);
      request.resolve(false);
    }}>
      <section
        className="dialog-card host-key-dialog"
        role="alertdialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h3><Fingerprint size={16} />首次连接 {prefix}{endpoint}</h3>
        <div className="dialog-message">
          <p>{approval.host}:{approval.port} 的服务器公钥尚未信任。请核对以下指纹与服务器管理员提供的值一致后，再保存并继续连接。</p>
          <div className="host-key-fingerprint">
            <div className="host-key-fingerprint-row">
              <span className="host-key-algorithm">{approval.keyType}</span>
              <button type="button" className="host-key-copy" onClick={() => void copyFingerprint()} title="复制指纹">
                <Copy size={13} />{copied ? "已复制" : "复制"}
              </button>
            </div>
            <code>{approval.fingerprint}</code>
          </div>
          <p className="host-key-warning">指纹不匹配说明连接可能被劫持，请勿继续。</p>
        </div>
        <footer className="dialog-actions">
          <button className="secondary-button" onClick={() => {
            finish(request);
            request.resolve(false);
          }}>取消连接</button>
          <button className="primary-button" onClick={() => {
            finish(request);
            request.resolve(true);
          }}>信任并保存</button>
        </footer>
      </section>
    </div>
  );
}

function ColorDialog({ request }: { request: ColorRequest }) {
  const [color, setColor] = useState(request.initialColor);
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopImmediatePropagation();
      finish(request);
      request.resolve(null);
    }
  };
  useEffect(() => {
    window.addEventListener("keydown", onKeydown, true);
    return () => window.removeEventListener("keydown", onKeydown, true);
  });
  return (
    <div className="modal-backdrop dialog-backdrop" onMouseDown={() => {
      finish(request);
      request.resolve(null);
    }}>
      <section
        className="dialog-card"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h3>{request.title}</h3>
        {request.message && <div className="dialog-message">{request.message}</div>}
        <div className="color-picker-row">
          {DIALOG_COLORS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              className={`color-swatch ${color === candidate ? "selected" : ""}`}
              style={{ backgroundColor: candidate }}
              onClick={() => setColor(candidate)}
              aria-label={`选择颜色 ${candidate}`}
            />
          ))}
          <button type="button" className="color-clear" onClick={() => setColor("")}>无颜色</button>
        </div>
        <footer className="dialog-actions">
          <button className="secondary-button" onClick={() => {
            finish(request);
            request.resolve(null);
          }}>取消</button>
          <button className="primary-button" onClick={() => {
            finish(request);
            request.resolve(color);
          }}>确定</button>
        </footer>
      </section>
    </div>
  );
}

export function DialogHost() {
  const top = useTopDialog();
  if (!top) return null;
  return createPortal(
    top.kind === "confirm"
      ? <ConfirmDialog key={top.id} request={top} />
      : top.kind === "prompt"
        ? <PromptDialog key={top.id} request={top} />
        : top.kind === "hostKey"
          ? <HostKeyDialog key={top.id} request={top} />
          : <ColorDialog key={top.id} request={top} />,
    document.body,
  );
}
