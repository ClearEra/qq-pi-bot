import assert from "node:assert/strict";
import test from "node:test";
import { makeInboundPrompt, validateDecision } from "./decision.js";
import type { InboundRow } from "./store.js";

const inbound: InboundRow = {
  eventKey: "c2c:user:message:1",
  chatKey: "c2c:user",
  chatType: "c2c",
  peerOpenId: "user-openid",
  messageId: "message-id",
  authorOpenId: "user-openid",
  authorName: "Alice",
  content: "你好",
  mentionedBot: 0,
  receivedAt: 1_800_000_000_000,
  status: "queued",
  submissionId: null,
};

test("Pi receives separate chat metadata and a bounded chronological message context", () => {
  const prompt = makeInboundPrompt(inbound, [inbound], "bot-openid");
  const json = prompt.slice(prompt.indexOf("{"));
  const payload = JSON.parse(json) as {
    conversation: string;
    message: { text: string };
    recentMessages: Array<{ text: string }>;
    mentionBot: boolean;
  };
  assert.equal(payload.conversation, "private");
  assert.equal(payload.message.text, "你好");
  assert.equal(payload.recentMessages[0]?.text, "你好");
  assert.equal(payload.mentionBot, false);
});

test("group @ event metadata identifies mentions even when QQ strips the textual mention", () => {
  const prompt = makeInboundPrompt({ ...inbound, chatType: "group", mentionedBot: 1 }, [], "");
  assert.equal(JSON.parse(prompt.slice(prompt.indexOf("{"))).mentionBot, true);
});

test("message input is bounded with explicit truncation metadata", () => {
  const prompt = makeInboundPrompt({ ...inbound, content: "x".repeat(50) }, [], "", 10);
  const payload = JSON.parse(prompt.slice(prompt.indexOf("{")));
  assert.equal(payload.message.text.length, 10);
  assert.equal(payload.message.truncated, true);
});

test("the reply decision accepts only an explicit reply or silence", () => {
  assert.equal(validateDecision({ action: "tool", content: "x" }), undefined);
  assert.equal(validateDecision({ action: "reply", content: "  hello " })?.content, "hello");
  assert.equal(validateDecision({ action: "reply", content: "x".repeat(2000) })?.content.length, 1500);
});
