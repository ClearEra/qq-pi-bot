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

test("an interrupted Pi model request resumes from SQLite after harness reopen", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-qq-interrupted-"));
  const file = path.join(directory, "durable.sqlite");
  const faux = fauxProvider();
  const model = faux.getModel();
  const models = createModels();
  models.setProvider(faux.provider);
  let started!: () => void;
  const inFlight = new Promise<void>((resolve) => { started = resolve; });
  faux.setResponses([
    async (_input, options) => {
      started();
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return fauxAssistantMessage("interrupted", { stopReason: "aborted" });
    },
    fauxAssistantMessage(fauxToolCall("reply_decision", { action: "silent", content: "" }), { stopReason: "toolUse" }),
  ]);
  const registry = createRegistry();
  registry.install(decisionExtension);
  const open = async () => Harness.open(await openNodeSqliteStorage(file), { models, registry }, context);
  let harness = await open();
  try {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: {
      model: { provider: model.provider, modelId: model.id }, extensions: [decisionExtension],
    } }, context);
    const submitted = await conversation.submit({ type: "input", content: "QQ message", requestId: "interrupted-message" }, context);
    await inFlight;
    await harness.close(context);
    harness = await open();
    const recovered = await harness.submission(submitted.id, context);
    assert.ok(recovered);
    harness.resume();
    const settled = await recovered.wait(context);
    assert.equal(settled.status, "done");
    if (settled.status !== "done" || settled.type !== "input") throw new Error("resume did not complete");
    const reopened = await harness.conversation(conversation.id, context);
    assert.ok(reopened);
    assert.deepEqual(await readDecision(reopened, settled.answer), { action: "silent", content: "" });
    assert.equal(faux.state.callCount, 2);
  } finally {
    await harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});
