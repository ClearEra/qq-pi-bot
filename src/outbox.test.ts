import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventStore } from "./store.js";
import { deliverPendingReplies } from "./outbox.js";

test("failed peer yields to other chats, preserving retry backoff across reopen", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-qq-outbox-"));
  const file = path.join(directory, "events.sqlite");
  let store = new EventStore(file);
  const now = Date.now();
  const sent: string[] = [];
  try {
    for (const [id, peer] of [["a", "failing"], ["b", "healthy"], ["c", "failing"]]) {
      const row = store.ingest("C2C_MESSAGE_CREATE", { id: id!, author: { user_openid: peer! } }, 1, "s");
      assert.ok(row);
      store.enqueueReply(row, "reply");
    }
    await deliverPendingReplies({ store, deadlineMs: 210000, now: () => now,
      send: async (_type, peer, id) => { sent.push(id); if (peer === "failing") throw new Error("QQ send 429"); }, report() {},
    });
    assert.deepEqual(sent, ["a", "b"]);
    assert.equal(store.pendingOutbox().length, 2);
    store.close();
    store = new EventStore(file);
    assert.equal(store.pendingOutbox()[0]?.attempts, 1);
    assert.equal(store.pendingOutbox()[0]?.nextAttemptAt, now + 1000);
    await deliverPendingReplies({ store, deadlineMs: 210000, now: () => now + 500, send: async () => { assert.fail("backoff/order must be respected"); }, report() {} });
    await deliverPendingReplies({ store, deadlineMs: 210000, now: () => now + 2000, send: async () => {}, report() {} });
    assert.equal(store.pendingOutbox().length, 0);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
