import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { decisionExtension, readDecision } from "./decision.js";

test("Pi Durable executes a decision and deduplicates the submission after SQLite reopen", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-qq-durable-"));
  const file = path.join(directory, "durable.sqlite");
  const faux = fauxProvider();
  const model = faux.getModel();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage(fauxToolCall("reply_decision", { action: "reply", content: "你好！" }), { stopReason: "toolUse" })]);
  const registry = createRegistry();
  registry.install(decisionExtension);
  const open = async () => Harness.open(await openNodeSqliteStorage(file), { models, registry }, context);
  let harness = await open();
  try {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: {
      model: { provider: model.provider, modelId: model.id }, extensions: [decisionExtension],
    } }, context);
    const agent = await conversation.agent(context);
    assert.deepEqual(agent.tools.map((tool) => tool.name), ["reply_decision"]);
    const submission = await conversation.submit({ type: "input", content: "你好", requestId: "qq:unique-message" }, context);
    const settled = await submission.wait(context);
    assert.equal(settled.status, "done");
    assert.equal(settled.type, "input");
    if (settled.status !== "done" || settled.type !== "input") throw new Error("decision did not settle");
    assert.deepEqual(await readDecision(conversation, settled.answer), { action: "reply", content: "你好！" });
    await harness.close(context);

    harness = await open();
    const recovered = await harness.conversation(conversation.id, context);
    assert.ok(recovered);
    const duplicate = await recovered.submit({ type: "input", content: "你好", requestId: "qq:unique-message" }, context);
    assert.equal(duplicate.id, submission.id);
    assert.deepEqual(await duplicate.wait(context), settled);
    assert.deepEqual(await readDecision(recovered, settled.answer), { action: "reply", content: "你好！" });
    assert.equal(faux.state.callCount, 1, "replaying an admitted request must not call the model again");
  } finally {
    await harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});
