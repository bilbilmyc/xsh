const MAX_PIXELS = 4096 * 2160;
const FRAME_MAGIC = 0x44485358;
const CURSOR_MAGIC = 0x43485358;

export type DesktopCursor =
  | { kind: "default" | "hidden" }
  | { kind: "shape"; width: number; height: number; hotspotX: number; hotspotY: number; pixels: Uint8ClampedArray<ArrayBuffer> };

export function decodeDesktopPacket(input: ArrayBuffer | Uint8Array): { type: "frame"; frame: DesktopFrame } | { type: "cursor"; cursor: DesktopCursor } {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 4 || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) !== CURSOR_MAGIC) {
    return { type: "frame", frame: decodeDesktopFrame(input) };
  }
  if (bytes.byteLength < 24) throw new Error("远程鼠标指针数据不完整。");
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const [kind, width, height, hotspotX, hotspotY] = Array.from({ length: 5 }, (_, index) => header.getUint32(4 + index * 4, true));
  if (kind <= 1 && width === 0 && height === 0 && hotspotX === 0 && hotspotY === 0 && bytes.byteLength === 24) {
    return { type: "cursor", cursor: { kind: kind === 0 ? "default" : "hidden" } };
  }
  if (kind !== 2 || !width || !height || width > 384 || height > 384 || hotspotX >= width || hotspotY >= height || bytes.byteLength !== 24 + width * height * 4) {
    throw new Error("远程鼠标指针尺寸或格式无效。");
  }
  const original = bytes.buffer instanceof ArrayBuffer;
  const buffer = original ? bytes.buffer : bytes.slice().buffer;
  return {
    type: "cursor",
    cursor: { kind: "shape", width, height, hotspotX, hotspotY, pixels: new Uint8ClampedArray(buffer as ArrayBuffer, (original ? bytes.byteOffset : 0) + 24, width * height * 4) },
  };
}

export interface DesktopFrame {
  sequence: number;
  width: number;
  height: number;
  x: number;
  y: number;
  dirtyWidth: number;
  dirtyHeight: number;
  pixels: Uint8ClampedArray<ArrayBuffer>;
}

/** Validate the native RGBA packet before allocating or touching the canvas. */
export function decodeDesktopFrame(input: ArrayBuffer | Uint8Array): DesktopFrame {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 32) throw new Error("远程桌面画面数据不完整。");
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = Array.from({ length: 8 }, (_, index) => header.getUint32(index * 4, true));
  const [magic, sequence, width, height, x, y, dirtyWidth, dirtyHeight] = values;
  if (magic !== FRAME_MAGIC || !sequence || width < 200 || height < 200 ||
      width > 8192 || height > 8192 || width * height > MAX_PIXELS ||
      !dirtyWidth || !dirtyHeight || x + dirtyWidth > width || y + dirtyHeight > height ||
      bytes.byteLength !== 32 + dirtyWidth * dirtyHeight * 4) {
    throw new Error("远程桌面画面尺寸或格式无效。");
  }
  const originalBuffer = bytes.buffer instanceof ArrayBuffer;
  const buffer = originalBuffer ? bytes.buffer : bytes.slice().buffer;
  return {
    sequence, width, height, x, y, dirtyWidth, dirtyHeight,
    pixels: new Uint8ClampedArray(buffer as ArrayBuffer, (originalBuffer ? bytes.byteOffset : 0) + 32, dirtyWidth * dirtyHeight * 4),
  };
}

export function desktopSize(width: number, height: number, maxPixels = MAX_PIXELS): { width: number; height: number } {
  const limit = Math.max(200 * 200, Math.min(MAX_PIXELS, Number.isFinite(maxPixels) ? maxPixels : MAX_PIXELS));
  let w = Math.max(200, Math.min(8192, Math.floor(Number.isFinite(width) ? width : 1280)));
  let h = Math.max(200, Math.min(8192, Math.floor(Number.isFinite(height) ? height : 720)));
  if (w * h > limit) {
    const factor = Math.sqrt(limit / (w * h));
    w = Math.max(200, Math.floor(w * factor));
    h = Math.max(200, Math.floor(h * factor));
    if (w * h > limit) {
      if (w > h) w = Math.floor(limit / h);
      else h = Math.floor(limit / w);
    }
  }
  return { width: w & ~1, height: h };
}

export function desktopPoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, width: number, height: number) {
  return {
    x: Math.max(0, Math.min(width - 1, Math.floor((clientX - rect.left) * width / Math.max(rect.width, 1)))),
    y: Math.max(0, Math.min(height - 1, Math.floor((clientY - rect.top) * height / Math.max(rect.height, 1)))),
  };
}

const SCANS: Record<string, number> = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05,
  Digit5: 0x06, Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b,
  Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f,
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15,
  KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19, BracketLeft: 0x1a,
  BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d,
  KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23,
  KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27, Quote: 0x28,
  Backquote: 0x29, ShiftLeft: 0x2a, Backslash: 0x2b, KeyZ: 0x2c, KeyX: 0x2d,
  KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32, Comma: 0x33,
  Period: 0x34, Slash: 0x35, ShiftRight: 0x36, NumpadMultiply: 0x37,
  AltLeft: 0x38, Space: 0x39, CapsLock: 0x3a, F1: 0x3b, F2: 0x3c,
  F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43,
  F10: 0x44, NumLock: 0x45, ScrollLock: 0x46, Numpad7: 0x47, Numpad8: 0x48,
  Numpad9: 0x49, NumpadSubtract: 0x4a, Numpad4: 0x4b, Numpad5: 0x4c,
  Numpad6: 0x4d, NumpadAdd: 0x4e, Numpad1: 0x4f, Numpad2: 0x50,
  Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53, IntlBackslash: 0x56,
  F11: 0x57, F12: 0x58,
  NumpadEnter: 0x11c, ControlRight: 0x11d, NumpadDivide: 0x135,
  PrintScreen: 0x137, AltRight: 0x138, Home: 0x147, ArrowUp: 0x148,
  PageUp: 0x149, ArrowLeft: 0x14b, ArrowRight: 0x14d, End: 0x14f,
  ArrowDown: 0x150, PageDown: 0x151, Insert: 0x152, Delete: 0x153,
  MetaLeft: 0x15b, MetaRight: 0x15c, ContextMenu: 0x15d,
};

export function desktopKey(code: string) {
  const scan = SCANS[code];
  return scan === undefined ? null : { scan: scan & 0xff, extended: scan > 0xff };
}

export function desktopWheel(delta: number, horizontal = false): number {
  const rotation = delta > 0 ? -120 : 120;
  return (horizontal ? 0x0400 : 0x0200) | (rotation & 0x01ff);
}
