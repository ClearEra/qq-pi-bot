import type { EventStore } from "./store.js";

export async function deliverPendingReplies(options: {
  store: EventStore;
  deadlineMs: number;
  send: (chatType: "c2c" | "group", peer: string, messageId: string, content: string) => Promise<void>;
  report: (error: unknown) => void;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<void> {
  const { store } = options;
  const now = options.now ?? Date.now;
  const blockedChats = new Set<string>();
  // One attempt per row per pass. A failed peer never monopolizes unrelated conversations.
  for (const row of store.pendingOutbox()) {
    if (options.signal?.aborted) return;
    const chat = `${row.chatType}:${row.peerOpenId}`;
    const inbound = store.getInbound(row.eventKey);
    if (!inbound || now() - inbound.receivedAt >= options.deadlineMs) {
      store.expireOutbox(row.eventKey);
      continue;
    }
    if (blockedChats.has(chat)) continue;
    blockedChats.add(chat);
    if (row.nextAttemptAt > now()) continue;
    try {
      await options.send(row.chatType, row.peerOpenId, row.messageId, row.content);
      store.markOutboxSent(row.eventKey);
      blockedChats.delete(chat);
    } catch (error) {
      options.report(error);
      if (error instanceof Error && /QQ send (400|403|404|410)\b/.test(error.message)) {
        store.expireOutbox(row.eventKey);
        blockedChats.delete(chat);
      } else {
        const delay = Math.min(20_000, 1_000 * 2 ** Math.min(row.attempts, 5));
        store.recordOutboxAttempt(row.eventKey, now() + delay);
      }
    }
  }
}
