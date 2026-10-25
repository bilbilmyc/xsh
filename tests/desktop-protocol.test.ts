import assert from "node:assert/strict";
import test from "node:test";
import { decodeDesktopFrame, decodeDesktopPacket, desktopKey, desktopPoint, desktopSize, desktopWheel } from "../apps/desktop/src/desktop-protocol.ts";

function packet(values: number[] = [0x44485358, 1, 200, 200, 2, 3, 2, 1], offset = 0) {
  const bytes = new Uint8Array(32 + values[6] * values[7] * 4 + offset);
  const header = new DataView(bytes.buffer, offset);
  values.forEach((value, index) => header.setUint32(index * 4, value, true));
  bytes.set([10, 20, 30, 255, 40, 50, 60, 255], offset + 32);
  return bytes.subarray(offset);
}

test("native desktop packets preserve dirty rectangles, pixel order and typed-array offsets", () => {
  const frame = decodeDesktopFrame(packet(undefined, 13));
  assert.equal(frame.sequence, 1);
  assert.deepEqual([frame.width, frame.height, frame.x, frame.y, frame.dirtyWidth, frame.dirtyHeight], [200, 200, 2, 3, 2, 1]);
  assert.deepEqual([...frame.pixels], [10, 20, 30, 255, 40, 50, 60, 255]);
});

test("native desktop packet validation rejects truncated, out-of-surface and unbounded frames", () => {
  const valid = packet();
  assert.throws(() => decodeDesktopFrame(valid.subarray(0, valid.length - 1)));
  for (const [index, value] of [[0, 0], [1, 0], [2, 8193], [3, 8193], [4, 199], [6, 0]]) {
    const invalid = valid.slice();
    new DataView(invalid.buffer).setUint32(index * 4, value, true);
    assert.throws(() => decodeDesktopFrame(invalid));
  }
});

test("shared buffers are copied safely without retaining their original offset", () => {
  const original = packet(undefined, 7);
  const buffer = new SharedArrayBuffer(original.length + 9);
  const bytes = new Uint8Array(buffer, 9, original.length);
  bytes.set(original);
  const frame = decodeDesktopFrame(bytes);
  assert.ok(frame.pixels.buffer instanceof ArrayBuffer);
  assert.deepEqual([...frame.pixels], [10, 20, 30, 255, 40, 50, 60, 255]);
});

test("requested desktop sizes stay within the native memory budget and use even widths", () => {
  assert.deepEqual(desktopSize(1921, 1080), { width: 1920, height: 1080 });
  assert.deepEqual(desktopSize(NaN, Infinity), { width: 1280, height: 720 });
  for (const size of [desktopSize(10000, 10000), desktopSize(1, 1), desktopSize(3840, 2160)]) {
    assert.ok(size.width >= 200 && size.height >= 200);
    assert.equal(size.width % 2, 0);
    assert.ok(size.width * size.height <= 4096 * 2160);
  }
});

test("requested desktop sizes also respect smaller server monitor areas at extreme aspect ratios", () => {
  for (const limit of [40000, 40001, 131072, 1280 * 720]) {
    for (const [w, h] of [[8192, 200], [200, 8192], [3840, 2160], [400, 400]]) {
      const size = desktopSize(w, h, limit);
      assert.ok(size.width >= 200 && size.height >= 200, JSON.stringify(size));
      assert.equal(size.width % 2, 0);
      assert.ok(size.width * size.height <= limit, JSON.stringify({ size, limit }));
    }
  }
});

function cursorPacket(values = [2, 2, 1, 1, 0], offset = 0) {
  const size = values[0] === 2 ? values[1] * values[2] * 4 : 0;
  const bytes = new Uint8Array(offset + 24 + size);
  const header = new DataView(bytes.buffer, offset);
  [0x43485358, ...values].forEach((value, index) => header.setUint32(index * 4, value, true));
  if (size) bytes.set([10, 20, 30, 255, 40, 50, 60, 0], offset + 24);
  return bytes.subarray(offset);
}

test("cursor packets carry RGBA transparency and hotspot coordinates separately from frame credits", () => {
  const decoded = decodeDesktopPacket(cursorPacket(undefined, 7));
  assert.equal(decoded.type, "cursor");
  if (decoded.type !== "cursor" || decoded.cursor.kind !== "shape") assert.fail("expected cursor shape");
  assert.deepEqual([decoded.cursor.width, decoded.cursor.height, decoded.cursor.hotspotX, decoded.cursor.hotspotY], [2, 1, 1, 0]);
  assert.deepEqual([...decoded.cursor.pixels], [10, 20, 30, 255, 40, 50, 60, 0]);
  assert.deepEqual(decodeDesktopPacket(cursorPacket([0, 0, 0, 0, 0])), { type: "cursor", cursor: { kind: "default" } });
  assert.deepEqual(decodeDesktopPacket(cursorPacket([1, 0, 0, 0, 0])), { type: "cursor", cursor: { kind: "hidden" } });
  assert.equal(decodeDesktopPacket(packet()).type, "frame");
});

test("cursor packet validation rejects incomplete pixels, invalid hotspots and oversized shapes", () => {
  const valid = cursorPacket();
  for (const [index, value] of [[1, 3], [2, 385], [3, 0], [4, 2], [5, 1]]) {
    const invalid = valid.slice();
    new DataView(invalid.buffer).setUint32(index * 4, value, true);
    assert.throws(() => decodeDesktopPacket(invalid));
  }
  assert.throws(() => decodeDesktopPacket(valid.subarray(0, 23)));
  assert.throws(() => decodeDesktopPacket(valid.subarray(0, valid.length - 1)));
  assert.throws(() => decodeDesktopPacket(cursorPacket([1, 1, 0, 0, 0])));
  const shared = new Uint8Array(new SharedArrayBuffer(valid.length + 3), 3, valid.length);
  shared.set(valid);
  const decoded = decodeDesktopPacket(shared);
  if (decoded.type !== "cursor" || decoded.cursor.kind !== "shape") assert.fail("expected cursor shape");
  assert.ok(decoded.cursor.pixels.buffer instanceof ArrayBuffer);
  assert.deepEqual([...decoded.cursor.pixels], [...valid.subarray(24)]);
});

test("scaled pointer coordinates map to remote pixels and clamp outside the viewport", () => {
  const rect = { left: 100, top: 50, width: 500, height: 300 };
  assert.deepEqual(desktopPoint(350, 200, rect, 1000, 600), { x: 500, y: 300 });
  assert.deepEqual(desktopPoint(-1, 900, rect, 1000, 600), { x: 0, y: 599 });
});

test("RDP physical keys distinguish extended controls and keypad keys", () => {
  assert.deepEqual(desktopKey("ControlLeft"), { scan: 0x1d, extended: false });
  assert.deepEqual(desktopKey("ControlRight"), { scan: 0x1d, extended: true });
  assert.deepEqual(desktopKey("NumpadEnter"), { scan: 0x1c, extended: true });
  assert.deepEqual(desktopKey("Enter"), { scan: 0x1c, extended: false });
  assert.equal(desktopKey("Unidentified"), null);
});

test("wheel input encodes signed nine-bit RDP rotation on each axis", () => {
  assert.equal(desktopWheel(1), 0x388);
  assert.equal(desktopWheel(-1), 0x278);
  assert.equal(desktopWheel(1, true), 0x588);
});
