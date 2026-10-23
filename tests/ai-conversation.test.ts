import assert from "node:assert/strict";
import test from "node:test";
import { AI_ARCHIVE_BYTES, AI_ARCHIVE_LIMIT, archiveAiConversation, formatAiArchive, AI_HISTORY_BYTES, AI_HISTORY_MESSAGES, AI_HISTORY_MESSAGE_BYTES, AI_TRANSCRIPT_BYTES, AI_TRANSCRIPT_TURNS, buildAiHistory, formatAiUserMessage, limitAiConversation, type AiConversationArchive, type AiHistoryTurn } from "../apps/desktop/src/ai-conversation.ts";
import { byteLength } from "../apps/desktop/src/ai-context.ts";

function turn(prompt: string, status: AiHistoryTurn["status"] = "complete"): AiHistoryTurn {
  return { mode: "diagnose", prompt, context: "curl: (7) Connection refused", text: `reply ${prompt}`, status };
}

test("new-conversation archives keep readable stopped output without reusing it as new history", () => {
  const turns = [turn("old"), turn("partial", "streaming")];
  const before = structuredClone(turns);
  const archives = archiveAiConversation([], turns, "unsent question", "new-conversation");
  assert.equal(archives.length, 1);
  assert.equal(archives[0].turns[1].status, "stopped");
  assert.match(formatAiArchive(archives[0]), /reply partial/);
  assert.match(formatAiArchive(archives[0]), /未发送的问题：\nunsent question/);
  assert.deepEqual(buildAiHistory([]).history, []);
  assert.deepEqual(turns, before);
});

test("archive retention evicts oldest conversations and does not create empty entries on repeated saves", () => {
  let archives: AiConversationArchive[] = [];
  for (let index = 0; index < 6; index++) archives = archiveAiConversation(archives, [turn(`task-${index}`)], "", "service-change");
  assert.equal(archives.length, AI_ARCHIVE_LIMIT);
  assert.equal(archives[0].turns[0].prompt, "task-5");
  assert.equal(archives[2].turns[0].prompt, "task-3");
  assert.deepEqual(archiveAiConversation(archives, [], " ", "service-change"), archives);
});

test("large archives preserve the latest task within the aggregate UTF-8 byte budget", () => {
  const large = { ...turn("latest"), text: "中文".repeat(AI_ARCHIVE_BYTES) };
  const archives = archiveAiConversation([], [large], "draft", "service-change");
  assert.equal(archives.length, 1);
  assert.equal(archives[0].turns[0].prompt, "latest");
  const bytes = archives.reduce((total, archive) => total + byteLength(archive.draftPrompt) + archive.turns.reduce((sum, item) => sum + byteLength(item.prompt) + byteLength(item.context) + byteLength(item.text), 0), 0);
  assert.ok(bytes <= AI_ARCHIVE_BYTES);
  assert.ok(!archives[0].turns[0].text.includes("\ufffd"));
  assert.match(archives[0].turns[0].text, /已截短/);
});

test("follow-up history retains ordered user/assistant pairs and the previous terminal data", () => {
  const first = turn("first");
  const second = turn("second");
  const result = buildAiHistory([first, second]);
  assert.deepEqual(result.history.map((message) => message.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(result.history[0].content, formatAiUserMessage(first));
  assert.ok(result.history[0].content.includes("Connection refused"));
  assert.equal(result.history[3].content, "reply second");
  assert.equal(result.includedTurns, 2);
  assert.equal(result.omittedTurns, 0);
  assert.equal(result.bytes, result.history.reduce((total, message) => total + byteLength(message.content), 0));
});

test("streaming, cancelled, errored and empty replies never become follow-up history", () => {
  const result = buildAiHistory([turn("good"), turn("unfinished", "streaming"), turn("cancelled", "stopped"), turn("failed", "error"), { ...turn("empty"), text: "  " }]);
  assert.equal(result.includedTurns, 1);
  assert.equal(result.history.length, 2);
  assert.ok(!JSON.stringify(result.history).includes("unfinished"));
  assert.ok(!JSON.stringify(result.history).includes("cancelled"));
  assert.ok(!JSON.stringify(result.history).includes("failed"));
});

test("history keeps the latest six complete rounds, never splitting a pair", () => {
  const result = buildAiHistory(Array.from({ length: 10 }, (_, index) => turn(`round-${index}`)));
  assert.equal(result.history.length, AI_HISTORY_MESSAGES);
  assert.equal(result.includedTurns, 6);
  assert.equal(result.omittedTurns, 4);
  assert.ok(result.history[0].content.includes("round-4"));
  assert.equal(result.history.at(-1)?.content, "reply round-9");
});

test("history redacts both roles before UTF-8 clipping and marks clipped messages", () => {
  const source = { ...turn("TOKEN='private-user-value'"), context: "你好".repeat(7000), text: "password=private-assistant-value\n" + "😊".repeat(10000) };
  const result = buildAiHistory([source]);
  assert.equal(result.history.length, 2);
  assert.ok(result.bytes <= AI_HISTORY_BYTES);
  assert.equal(result.truncatedMessages, 2);
  for (const message of result.history) {
    assert.ok(byteLength(message.content) <= AI_HISTORY_MESSAGE_BYTES);
    assert.ok(message.content.endsWith("[历史内容已截短]"));
    assert.ok(!message.content.includes("private-user-value"));
    assert.ok(!message.content.includes("private-assistant-value"));
    assert.ok(!message.content.includes("�"));
  }
});

test("byte budget keeps a contiguous latest suffix instead of silently skipping a large middle turn", () => {
  const turns = [turn("old"), { ...turn("middle"), text: "x".repeat(AI_HISTORY_MESSAGE_BYTES) }, { ...turn("latest"), context: "y".repeat(AI_HISTORY_MESSAGE_BYTES), text: "z".repeat(AI_HISTORY_MESSAGE_BYTES) }];
  const result = buildAiHistory(turns);
  assert.equal(result.includedTurns, 1);
  assert.equal(result.omittedTurns, 2);
  assert.ok(result.history[0].content.includes("latest"));
  assert.ok(!JSON.stringify(result.history).includes("old"));
});

test("history input is not mutated and separately supplied terminal conversations cannot mix", () => {
  const terminalA = [turn("terminal-a")];
  const terminalB = [turn("terminal-b")];
  const before = structuredClone(terminalA);
  assert.ok(!JSON.stringify(buildAiHistory(terminalA)).includes("terminal-b"));
  assert.ok(!JSON.stringify(buildAiHistory(terminalB)).includes("terminal-a"));
  assert.deepEqual(terminalA, before);
});

test("local transcript memory evicts old whole turns without losing the latest turn", () => {
  const rounds = Array.from({ length: AI_TRANSCRIPT_TURNS + 10 }, (_, index) => ({ ...turn(`round-${index}`), id: index }));
  const bounded = limitAiConversation(rounds);
  assert.equal(bounded.length, AI_TRANSCRIPT_TURNS);
  assert.equal(bounded.at(-1)?.id, rounds.at(-1)?.id);
  const large = limitAiConversation([turn("old"), { ...turn("middle"), text: "x".repeat(AI_TRANSCRIPT_BYTES / 2) }, { ...turn("latest", "streaming"), text: "y".repeat(AI_TRANSCRIPT_BYTES / 2) }]);
  assert.equal(large.length, 1);
  assert.equal(large[0].prompt, "latest");
  assert.equal(rounds.length, AI_TRANSCRIPT_TURNS + 10);
});
