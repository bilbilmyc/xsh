import assert from "node:assert/strict";
import test from "node:test";
import {
  BoundedSessionLogBuffer,
  SESSION_LOG_TRUNCATION_MARKER,
} from "../apps/desktop/src/session-log-buffer.ts";

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

test("appends output without a truncation marker while under the byte limit", () => {
  const header = "HEADER\n";
  const buffer = new BoundedSessionLogBuffer(256);

  buffer.reset(header);
  buffer.append("hello");
  buffer.append(" world");

  assert.equal(buffer.toString(), `${header}hello world`);
  assert.equal(buffer.byteLength, bytes(buffer.toString()));
  assert.equal(buffer.wasTrimmed, false);
});

test("trims the oldest output and retains exactly one marker", () => {
  const header = "HEADER\n";
  const outputCapacity = 4;
  const limit = bytes(header) + bytes(SESSION_LOG_TRUNCATION_MARKER) + outputCapacity;
  const buffer = new BoundedSessionLogBuffer(limit);

  buffer.reset(header);
  buffer.append(`${"x".repeat(bytes(SESSION_LOG_TRUNCATION_MARKER))}abcdef`);
  buffer.append("gh");

  assert.equal(buffer.toString(), `${header}${SESSION_LOG_TRUNCATION_MARKER}efgh`);
  assert.equal(buffer.byteLength, limit);
  assert.equal(buffer.toString().split(SESSION_LOG_TRUNCATION_MARKER).length - 1, 1);
  assert.equal(buffer.wasTrimmed, true);
});

test("does not split a surrogate pair when retaining the newest UTF-8 output", () => {
  const header = "HEADER\n";
  const outputCapacity = bytes("😀BC");
  const limit = bytes(header) + bytes(SESSION_LOG_TRUNCATION_MARKER) + outputCapacity;
  const buffer = new BoundedSessionLogBuffer(limit);

  buffer.reset(header);
  buffer.append(`${"x".repeat(bytes(SESSION_LOG_TRUNCATION_MARKER))}A😀BC`);

  assert.equal(buffer.toString(), `${header}${SESSION_LOG_TRUNCATION_MARKER}😀BC`);
  assert.equal(buffer.byteLength, limit);
  assert.equal(buffer.toString().includes("�"), false);
});

test("reset clears retained output and the truncation state", () => {
  const firstHeader = "FIRST\n";
  const secondHeader = "SECOND\n";
  const limit = bytes(firstHeader) + bytes(SESSION_LOG_TRUNCATION_MARKER) + 3;
  const buffer = new BoundedSessionLogBuffer(limit);

  buffer.reset(firstHeader);
  buffer.append(`${"x".repeat(bytes(SESSION_LOG_TRUNCATION_MARKER))}overflow`);
  assert.equal(buffer.wasTrimmed, true);

  buffer.reset(secondHeader);
  buffer.append("ok");

  assert.equal(buffer.toString(), `${secondHeader}ok`);
  assert.equal(buffer.wasTrimmed, false);
  assert.equal(buffer.byteLength, bytes(`${secondHeader}ok`));
});
