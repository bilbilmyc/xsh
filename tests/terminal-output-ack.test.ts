import assert from "node:assert/strict";
import test from "node:test";
import { CumulativeTerminalOutputAcknowledger } from "../apps/desktop/src/terminal-output-ack.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("holds cumulative terminal output ACKs until the connection id is available", async () => {
  const sent: number[] = [];
  const acknowledger = new CumulativeTerminalOutputAcknowledger(0);
  acknowledger.consume(3);
  assert.deepEqual(sent, []);

  acknowledger.setSender(async (consumedBytes) => {
    sent.push(consumedBytes);
  });
  await settle();
  assert.deepEqual(sent, [3]);
});

test("coalesces bytes consumed while an ACK is in flight", async () => {
  const sent: number[] = [];
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const acknowledger = new CumulativeTerminalOutputAcknowledger(0);
  acknowledger.setSender(async (consumedBytes) => {
    sent.push(consumedBytes);
    if (sent.length === 1) await first;
  });

  acknowledger.consume(2);
  await settle();
  acknowledger.consume(3);
  releaseFirst();
  await settle();
  await settle();
  assert.deepEqual(sent, [2, 5]);
});

test("retries the same cumulative ACK after a transient failure", async () => {
  const sent: number[] = [];
  const acknowledger = new CumulativeTerminalOutputAcknowledger(0);
  acknowledger.setSender(async (consumedBytes) => {
    sent.push(consumedBytes);
    if (sent.length === 1) throw new Error("transient IPC failure");
  });
  acknowledger.consume(4);

  await settle();
  await settle();
  await settle();
  assert.deepEqual(sent, [4, 4]);
});

test("stopping suppresses pending and future ACKs", async () => {
  const sent: number[] = [];
  const acknowledger = new CumulativeTerminalOutputAcknowledger(0);
  acknowledger.consume(2);
  acknowledger.stop();
  acknowledger.setSender(async (consumedBytes) => {
    sent.push(consumedBytes);
  });
  acknowledger.consume(2);

  await settle();
  assert.deepEqual(sent, []);
});
