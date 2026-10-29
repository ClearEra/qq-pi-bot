import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { QQClient } from "./qq.js";

test("official token and REST routes use cached auth and stable passive-reply sequence", async () => {
  const requests: Array<{ url: string; options?: RequestInit }> = [];
  const client = new QQClient({
    appId: "123456", clientSecret: "fake-test-secret", onMessage: async () => {}, onSequence() {}, onStatus() {},
    fetch: async (url, options) => {
      requests.push({ url: String(url), ...(options ? { options } : {}) });
      return Response.json(String(url).includes("getAppAccessToken") ? { access_token: "fake-test-token", expires_in: 7200 } : { id: "receipt" });
    },
  });
  await client.sendMessage("group", "g/1", "m1", "hello");
  await client.sendMessage("group", "g/1", "m1", "hello");
  await client.sendMessage("c2c", "u1", "m2", "private");
  assert.equal(requests[0]?.url, "https://bots.qq.com/app/getAppAccessToken");
  assert.equal(requests.filter((request) => request.url.includes("getAppAccessToken")).length, 1);
  assert.equal(requests[1]?.url, "https://api.sgroup.qq.com/v2/groups/g%2F1/messages");
  assert.deepEqual(JSON.parse(String(requests[1]?.options?.body)), { content: "hello", msg_type: 0, msg_id: "m1", msg_seq: 1 });
  assert.equal(requests[1]?.options?.body, requests[2]?.options?.body);
  assert.equal(requests[3]?.url, "https://api.sgroup.qq.com/v2/users/u1/messages");
  assert.equal(new Headers(requests[1]?.options?.headers).get("Authorization"), "QQBot fake-test-token");
});

test("Gateway checkpoints are serialized and stop after failed ingestion", { timeout: 10_000 }, async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const sequences: number[] = [];
  const messages: string[] = [];
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const ingesting = new Promise<void>((resolve) => { started = resolve; });
  let failed!: () => void;
  const failure = new Promise<void>((resolve) => { failed = resolve; });
  const client = new QQClient({ appId: "123456", clientSecret: "fake-test-secret", websocketUrl: `ws://127.0.0.1:${address.port}`,
    fetch: async () => Response.json({ access_token: "fake-test-token", expires_in: 7200 }),
    async onMessage(_type, event) {
      messages.push(event.id!);
      if (event.id === "first") { started(); await paused; }
      else throw new Error("simulated ingest failure");
    },
    onSequence(_session, sequence) { sequences.push(sequence); },
    onStatus(status, details) { if (status === "error" && details === "simulated ingest failure") failed(); },
  });
  try {
    const connected = once(server, "connection");
    await client.start();
    const [socket] = await connected;
    const identified = once(socket, "message");
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
    await identified;
    socket.send(JSON.stringify({ op: 0, t: "READY", s: 1, d: { session_id: "s" } }));
    for (const [id, sequence] of [["first", 2], ["fails", 3], ["must-not-run", 4]]) {
      socket.send(JSON.stringify({ op: 0, t: "C2C_MESSAGE_CREATE", s: sequence, d: { id } }));
    }
    await ingesting;
    assert.deepEqual(messages, ["first"]);
    assert.ok(!sequences.includes(2));
    release();
    await failure;
    assert.deepEqual(messages, ["first", "fails"]);
    assert.equal(Math.max(...sequences), 2);
  } finally {
    release();
    client.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

for (const resume of [false, true]) {
  test(`Gateway ${resume ? "RESUME" : "IDENTIFY"}, dispatch, and server heartbeat`, { timeout: 10_000 }, async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const sequences: number[] = [];
    let messageReceived!: () => void;
    const received = new Promise<void>((resolve) => { messageReceived = resolve; });
    const client = new QQClient({
      appId: "123456", clientSecret: "fake-test-secret", websocketUrl: `ws://127.0.0.1:${address.port}`,
      ...(resume ? { sessionId: "saved-session", sequence: 41 } : {}),
      fetch: async () => Response.json({ access_token: "fake-test-token", expires_in: 7200 }),
      async onMessage(type, event, sequence, session) {
        assert.equal(type, "GROUP_AT_MESSAGE_CREATE");
        assert.equal(event.id, "msg");
        assert.equal(sequence, 43);
        assert.equal(session, resume ? "saved-session" : "new-session");
        messageReceived();
      },
      onSequence(_session, sequence) { sequences.push(sequence); }, onStatus() {},
    });
    try {
      const connected = once(server, "connection");
      await client.start();
      const [socket] = await connected;
      const identify = once(socket, "message");
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
      const [raw] = await identify;
      const auth = JSON.parse(raw.toString());
      assert.equal(auth.op, resume ? 6 : 2);
      assert.equal(auth.d.token, "QQBot fake-test-token");
      if (resume) {
        assert.equal(auth.d.session_id, "saved-session");
        assert.equal(auth.d.seq, 41);
      } else {
        assert.equal(auth.d.intents, 1 << 25);
      }
      socket.send(JSON.stringify(resume
        ? { op: 0, t: "RESUMED", s: 42, d: {} }
        : { op: 0, t: "READY", s: 42, d: { session_id: "new-session", user: { id: "bot-id" } } }));
      socket.send(JSON.stringify({ op: 0, t: "GROUP_AT_MESSAGE_CREATE", s: 43, d: { id: "msg" } }));
      await received;
      assert.equal(client.status, "online");
      if (!resume) assert.equal(client.botId, "bot-id");
      const heartbeat = once(socket, "message");
      socket.send(JSON.stringify({ op: 1 }));
      const [beat] = await heartbeat;
      assert.deepEqual(JSON.parse(beat.toString()), { op: 1, d: 43 });
      assert.ok(sequences.includes(43));
      socket.send(JSON.stringify({ op: 11 }));
    } finally {
      client.stop();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
