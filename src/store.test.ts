import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventStore } from "./store.js";
import { validateDecision } from "./decision.js";

async function withStore(run: (store: EventStore) => void): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-qq-store-"));
  const file = path.join(directory, "state.sqlite");
  try {
    const store = new EventStore(file);
    run(store);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function message(id: string, content: string, chatType: "c2c" | "group" = "c2c") {
  return chatType === "c2c"
    ? { id, content, author: { user_openid: "user-openid", username: "alice" } }
    : { id, content, group_openid: "group-openid", author: { member_openid: "member-openid", username: "alice" } };
}

test("inbound events are durably deduplicated by chat and message despite sequence changes", async () => {
  await withStore((store) => {
    const first = store.ingest("C2C_MESSAGE_CREATE", { ...message("m1", "hello"), msg_seq: 1 }, 10, "session-1");
    assert.ok(first);
    assert.equal(first.status, "queued");
    assert.equal(store.ingest("C2C_MESSAGE_CREATE", { ...message("m1", "hello"), msg_seq: 1 }, 10, "session-1"), undefined);
    assert.equal(store.ingest("C2C_MESSAGE_CREATE", { ...message("m1", "duplicate"), msg_seq: 2 }, 11, "session-1"), undefined);
    assert.equal(store.gatewayState().sessionId, "session-1");
    assert.equal(store.gatewayState().sequence, 11);
  });
});

test("group all-message and @ variants deduplicate while retaining mention metadata", async () => {
  await withStore((store) => {
    const first = store.ingest("GROUP_MESSAGE_CREATE", message("m", "hello", "group"), 1, "s");
    assert.ok(first);
    assert.equal(first.mentionedBot, 0);
    assert.equal(store.ingest("GROUP_AT_MESSAGE_CREATE", message("m", "hello", "group"), 2, "s"), undefined);
    assert.equal(store.getInbound(first.eventKey)?.mentionedBot, 1);
    assert.equal(store.counts().queued, 1);
    const mentioned = store.ingest("GROUP_MESSAGE_CREATE", { ...message("m2", "hello", "group"), mentions: [{ is_you: true }] }, 3, "s");
    assert.equal(mentioned?.mentionedBot, 1);
  });
});

test("group and private identifiers do not collide and queued messages retain context", async () => {
  await withStore((store) => {
    const direct = store.ingest("C2C_MESSAGE_CREATE", message("same", "private"), 1, "s");
    const group = store.ingest("GROUP_MESSAGE_CREATE", message("same", "group", "group"), 2, "s");
    assert.ok(direct);
    assert.ok(group);
    assert.notEqual(direct.chatKey, group.chatKey);
    assert.equal(store.nextInbound(direct.chatKey)?.content, "private");
    assert.equal(store.nextInbound(group.chatKey)?.content, "group");
  });
});

test("submission and pending reply survive database reopen", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-qq-restart-"));
  const file = path.join(directory, "state.sqlite");
  try {
    let store = new EventStore(file);
    const inbound = store.ingest("C2C_MESSAGE_CREATE", message("recover", "reply to me"), 4, "s");
    assert.ok(inbound);
    store.markSubmitted(inbound.eventKey, 42);
    store.close();

    store = new EventStore(file);
    const recovered = store.nextInbound(inbound.chatKey);
    assert.equal(recovered?.status, "submitted");
    assert.equal(recovered?.submissionId, 42);
    assert.ok(recovered);
    store.enqueueReply(recovered, "durable reply");
    assert.equal(store.pendingOutbox()[0]?.content, "durable reply");
    store.close();

    store = new EventStore(file);
    assert.equal(store.pendingOutbox()[0]?.eventKey, inbound.eventKey);
    store.markOutboxSent(inbound.eventKey);
    assert.equal(store.pendingOutbox().length, 0);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid, empty and silent model decisions never become replies", () => {
  assert.equal(validateDecision(undefined), undefined);
  assert.deepEqual(validateDecision({ action: "silent", content: "" }), { action: "silent", content: "" });
  assert.deepEqual(validateDecision({ action: "reply", content: "   " }), { action: "silent", content: "" });
  assert.equal(validateDecision({ action: "reply", content: 4 }), undefined);
  assert.equal(validateDecision({ action: "ignore", content: "x" }), undefined);
});

test("message ingestion rejects events without a sender or target", async () => {
  await withStore((store) => {
    assert.equal(store.ingest("C2C_MESSAGE_CREATE", { id: "x", content: "missing sender" }, 1, "s"), undefined);
    assert.equal(store.ingest("GROUP_MESSAGE_CREATE", { id: "x", author: { member_openid: "member" } }, 2, "s"), undefined);
    assert.equal(store.counts().queued, 0);
  });
});
