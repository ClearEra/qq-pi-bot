import { setTimeout as sleep } from "node:timers/promises";
import type { Conversation, Harness as PiHarness, Submission } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ensureAppFiles, readConfig, KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE, EVENT_DATABASE_PATH, DURABLE_DATABASE_PATH, type BotConfig } from "./config.js";
import { loadPiModels, type PiModelRuntime } from "./models.js";
import { characterExtension } from "./character.js";
import { decisionExtension, makeInboundPrompt, readDecision } from "./decision.js";
import { startControlServer } from "./web.js";
import { QQClient, type QQMessageEvent } from "./qq.js";
import { EventStore, type InboundRow } from "./store.js";
import { deliverPendingReplies } from "./outbox.js";

const MAX_REPLY_CHARS = 1500;

interface Runtime {
  config: BotConfig;
  harness: PiHarness;
  models: PiModelRuntime;
  store: EventStore;
  client: QQClient;
  chatQueues: Map<string, Promise<void>>;
  outboxRun: Promise<void> | undefined;
  shutdown: AbortController;
}

let runtime: Runtime | undefined;

async function main(): Promise<void> {
  await ensureAppFiles();
  // Reserve the fixed loopback control port before opening either SQLite database.
  // This is the process-lifetime single-instance guard for this local service.
  const controlServer = await startControlServer({
    async getStatus() {
      if (!runtime) return { gateway: "starting", harness: "starting", counts: { queued: 0, chats: 0 } };
      return {
        gateway: runtime.client.status,
        harness: "ready",
        commit: process.env.PI_QQ_BOT_COMMIT ?? "development",
        model: `${runtime.models.providerId}/${runtime.models.modelId}`,
        counts: runtime.store.counts(),
      };
    },
  });
  try {
    await runBot();
  } finally {
    await new Promise<void>((resolve) => controlServer.close(() => resolve()));
  }
}

async function runBot(): Promise<void> {
  const config = await readConfig();
  const clientSecret = await readKeychainSecret();
  const models = await loadPiModels(config);
  const store = new EventStore(EVENT_DATABASE_PATH);
  const registry = createRegistry();
  registry.install(characterExtension);
  registry.install(decisionExtension);
  const storage = await openNodeSqliteStorage(DURABLE_DATABASE_PATH);
  const harness = await Harness.open(storage, {
    models: models.models,
    registry,
    settings: {
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 1500, maxAgentDelayMs: 15_000 },
      compaction: { enabled: true, reserveTokens: 6000, keepRecentTokens: 12_000, backgroundTokens: 2000 },
      contextRetentionMs: 10 * 60_000,
      documentRetentionMs: 10 * 60_000,
      afterFailedRun: "continue",
      restartLimit: 8,
    },
    onReport(error, info) {
      console.error(JSON.stringify({ at: new Date().toISOString(), type: info.type, error: safeMessage(error) }));
    },
  }, BACKGROUND_CONTEXT);
  const bot = {} as Runtime;
  Object.assign(bot, {
    config,
    harness,
    models,
    store,
    chatQueues: new Map<string, Promise<void>>(),
    outboxRun: undefined,
    shutdown: new AbortController(),
  });
  const state = store.gatewayState();
  const client = new QQClient({
    appId: config.appId,
    clientSecret,
    ...(config.websocketUrl ? { websocketUrl: config.websocketUrl } : {}),
    ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    ...(state.sequence !== null ? { sequence: state.sequence } : {}),
    async onMessage(eventType: string, event: QQMessageEvent, sequence: number | undefined, sessionId: string | undefined) {
      const ignored = event.author?.bot === true
        || Boolean(bot.client.botId && event.author?.member_openid === bot.client.botId)
        || eventType === "C2C_MESSAGE_CREATE" && !config.privateChats
        || (eventType === "GROUP_AT_MESSAGE_CREATE" || eventType === "GROUP_MESSAGE_CREATE") && !config.groups
        || eventType === "GROUP_MESSAGE_CREATE" && config.groupMode !== "all";
      if (ignored) {
        if (sequence !== undefined) store.saveGatewayState(sessionId ?? null, sequence);
        return;
      }
      const inserted = store.ingest(eventType, event, sequence, sessionId);
      if (!inserted) return;
      void queueChat(bot, inserted.chatKey, () => processChat(bot, inserted.chatKey));
    },
    onSequence(sessionId, sequence) {
      store.saveGatewayState(sessionId ?? null, sequence);
    },
    onStatus(status, details) {
      console.log(JSON.stringify({
        at: new Date().toISOString(),
        status,
        details,
        model: `${models.providerId}/${models.modelId}`,
        counts: store.counts(),
      }));
    },
  });
  bot.client = client;
  runtime = bot;
  // Retry stranded queued work/outbox snapshots even when no new QQ message arrives.
  const recoveryTimer = setInterval(() => {
    for (const chatKey of store.queuedChats()) {
      if (!bot.chatQueues.has(chatKey)) void queueChat(bot, chatKey, () => processChat(bot, chatKey));
    }
    void drainOutbox(bot).catch((error) => console.error(safeMessage(error)));
  }, 5_000);

  const shuttingDown = new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      bot.shutdown.abort();
      clearInterval(recoveryTimer);
      console.log("Pi QQ Bot 正在停止");
      client.stop();
      void harness.close(BACKGROUND_CONTEXT).catch(() => undefined).then(async () => {
        await Promise.allSettled([...bot.chatQueues.values(), bot.outboxRun]);
        store.close();
        runtime = undefined;
        resolve();
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    void harness.closed.then((end) => {
      if (end.reason === "failed") {
        process.exitCode = 1;
        runtime = undefined;
        stop();
      }
    });
  });

  // Expire/abort obsolete recovered work before starting regular scheduling.
  // abort() also safely completes cleanup when a task was interrupted mid-tool.
  for (const chatKey of store.queuedChats()) {
    const row = store.nextInbound(chatKey);
    if (row && Date.now() - row.receivedAt > config.replyDeadlineSeconds * 1_000) {
      const id = store.getChat(chatKey);
      if (id !== undefined) await (await harness.conversation(id as never, BACKGROUND_CONTEXT))?.abort(BACKGROUND_CONTEXT);
    }
  }
  harness.resume();
  await client.start();
  void drainOutbox(bot);
  for (const chatKey of store.queuedChats()) void queueChat(bot, chatKey, () => processChat(bot, chatKey));
  await shuttingDown;
}

function queueChat(bot: Runtime, chatKey: string, operation: () => Promise<void>): Promise<void> {
  const previous = bot.chatQueues.get(chatKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation).catch((error) => {
    console.error(JSON.stringify({ at: new Date().toISOString(), chatKey, error: safeMessage(error) }));
  });
  bot.chatQueues.set(chatKey, current);
  void current.finally(() => {
    if (bot.chatQueues.get(chatKey) === current) bot.chatQueues.delete(chatKey);
  });
  return current;
}

async function processChat(bot: Runtime, chatKey: string): Promise<void> {
  for (;;) {
    if (bot.shutdown.signal.aborted) return;
    const row = bot.store.nextInbound(chatKey);
    if (!row) return;
    if (Date.now() - row.receivedAt > bot.config.replyDeadlineSeconds * 1_000) {
      const existingId = bot.store.getChat(row.chatKey);
      if (existingId !== undefined) {
        const existing = await bot.harness.conversation(existingId as never, BACKGROUND_CONTEXT);
        await existing?.abort(BACKGROUND_CONTEXT);
      }
      bot.store.finishInbound(row.eventKey, true);
      continue;
    }

    const conversation = await conversationFor(bot, row);
    let submission: Submission | undefined;
    if (row.status === "submitted" && row.submissionId !== null) {
      submission = await bot.harness.submission(row.submissionId as never, BACKGROUND_CONTEXT);
      if (!submission) {
        bot.store.finishInbound(row.eventKey, true);
        continue;
      }
    } else {
      const recentMessages = bot.store.recentMessages(chatKey, row.receivedAt);
      const prompt = makeInboundPrompt(row, recentMessages, bot.client.botId, bot.config.maxMessageChars);
      submission = await conversation.submit({
        type: "input",
        content: prompt,
        requestId: row.eventKey,
        whenBusy: "followUp",
        entry: { kind: "qq.message", data: { eventKey: row.eventKey, chatType: row.chatType, peerOpenId: row.peerOpenId } },
      }, BACKGROUND_CONTEXT);
      bot.store.markSubmitted(row.eventKey, submission.id);
    }

    const decisionPromise = submission.wait(BACKGROUND_CONTEXT).then(async (settled) => {
      if (settled.status !== "done" || settled.type !== "input") return undefined;
      return readDecision(conversation, settled.answer);
    });
    const remaining = Math.max(0, bot.config.replyDeadlineSeconds * 1_000 - (Date.now() - row.receivedAt));
    let timedOut = false;
    const deadlineController = new AbortController();
    let decision;
    let onShutdown!: () => void;
    const shutdown = new Promise<undefined>((resolve) => {
      onShutdown = () => resolve(undefined);
      bot.shutdown.signal.addEventListener("abort", onShutdown, { once: true });
      if (bot.shutdown.signal.aborted) resolve(undefined);
    });
    try {
      decision = await Promise.race([
        shutdown,
        decisionPromise,
        sleep(remaining, undefined, { signal: deadlineController.signal }).then(() => {
          timedOut = true;
          return undefined;
        }),
      ]);
    } finally {
      deadlineController.abort();
      bot.shutdown.signal.removeEventListener("abort", onShutdown);
    }
    if (bot.shutdown.signal.aborted) return; // Leave admitted work pending for recovery.
    if (timedOut) {
      // Keep the inbox row recoverable until Durable cancellation is committed.
      // A crash/close during abort must leave startup able to find obsolete work.
      await conversation.abort(BACKGROUND_CONTEXT);
      bot.store.finishInbound(row.eventKey, true);
      continue;
    }
    if (!decision || decision.action !== "reply" || !decision.content.trim()) {
      bot.store.finishInbound(row.eventKey);
      continue;
    }
    bot.store.enqueueReply(row, decision.content.slice(0, MAX_REPLY_CHARS));
    void drainOutbox(bot);
  }
}

async function conversationFor(bot: Runtime, row: InboundRow): Promise<Conversation> {
  let id = bot.store.getChat(row.chatKey);
  if (id === undefined) {
    const conversation = await bot.harness.createConversation({
      ownership: { kind: "ownerless" },
      agent: {
        model: { provider: bot.models.providerId, modelId: bot.models.modelId },
        thinkingLevel: bot.models.thinkingLevel,
        extensions: [characterExtension, decisionExtension],
        instructions: "For each input, make one reply_decision tool call. Do not send ordinary assistant prose.",
      },
    }, BACKGROUND_CONTEXT);
    id = conversation.id;
    bot.store.setChat(row.chatKey, id);
  }
  const conversation = await bot.harness.conversation(id as never, BACKGROUND_CONTEXT);
  if (!conversation) throw new Error(`找不到持久会话 ${row.chatKey}`);
  return conversation;
}

async function drainOutbox(bot: Runtime): Promise<void> {
  if (bot.outboxRun) return bot.outboxRun;
  bot.outboxRun = deliverPendingReplies({
    store: bot.store,
    deadlineMs: bot.config.replyDeadlineSeconds * 1_000,
    signal: bot.shutdown.signal,
    send: (type, peer, messageId, content) => bot.client.sendMessage(type, peer, messageId, content),
    report: (error) => console.error(JSON.stringify({ at: new Date().toISOString(), sendError: safeMessage(error) })),
  }).finally(() => { bot.outboxRun = undefined; });
  return bot.outboxRun;
}

async function readKeychainSecret(): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("security", [
    "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w",
  ]);
  const secret = stdout.trim();
  if (!secret) throw new Error("macOS Keychain 中没有 QQ AppSecret；请运行 npm run setup");
  return secret;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ at: new Date().toISOString(), fatal: safeMessage(error) }));
  // Startup may have partially initialized the Harness. Terminate so no scheduler
  // survives a failed startup; committed work resumes in the next process.
  process.exit(1);
});
