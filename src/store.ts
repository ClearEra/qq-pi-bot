import { DatabaseSync } from "node:sqlite";
import { EVENT_DATABASE_PATH } from "./config.js";

export type InboundStatus = "queued" | "submitted" | "done" | "expired";

export interface InboundRow {
  eventKey: string;
  chatKey: string;
  chatType: "c2c" | "group";
  peerOpenId: string;
  messageId: string;
  authorOpenId: string;
  authorName: string;
  content: string;
  mentionedBot: number;
  receivedAt: number;
  status: InboundStatus;
  submissionId: number | null;
}

export interface OutboxRow {
  eventKey: string;
  chatType: "c2c" | "group";
  peerOpenId: string;
  messageId: string;
  content: string;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
}

export interface GatewayState {
  sessionId: string | null;
  sequence: number | null;
}

export interface ReplyDecision {
  action: "reply" | "silent";
  content: string;
}

export class EventStore {
  readonly #db: DatabaseSync;

  constructor(file = EVENT_DATABASE_PATH) {
    this.#db = new DatabaseSync(file);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        chat_key TEXT PRIMARY KEY,
        conversation_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inbound (
        event_key TEXT PRIMARY KEY,
        chat_key TEXT NOT NULL,
        chat_type TEXT NOT NULL,
        peer_openid TEXT NOT NULL,
        message_id TEXT NOT NULL,
        author_openid TEXT NOT NULL,
        author_name TEXT NOT NULL,
        content TEXT NOT NULL,
        mentioned_bot INTEGER NOT NULL DEFAULT 0,
        received_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        submission_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS inbound_status_received ON inbound(status, received_at);
      CREATE INDEX IF NOT EXISTS inbound_chat_received ON inbound(chat_key, received_at);
      CREATE TABLE IF NOT EXISTS outbox (
        event_key TEXT PRIMARY KEY REFERENCES inbound(event_key),
        chat_type TEXT NOT NULL,
        peer_openid TEXT NOT NULL,
        message_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS gateway_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        session_id TEXT,
        sequence INTEGER
      );
      INSERT OR IGNORE INTO gateway_state(id, session_id, sequence) VALUES(1, NULL, NULL);
    `);
  }

  ingest(
    eventType: string,
    event: {
      id?: string;
      content?: string;
      timestamp?: string;
      msg_seq?: number;
      group_openid?: string;
      mentions?: Array<{ is_you?: boolean }>;
      author?: { user_openid?: string; member_openid?: string; username?: string };
    },
    sequence: number | undefined,
    sessionId: string | undefined,
  ): InboundRow | undefined {
    const chatType = eventType === "C2C_MESSAGE_CREATE" ? "c2c" : "group";
    const peerOpenId = chatType === "c2c" ? event.author?.user_openid : event.group_openid;
    const authorOpenId = chatType === "c2c" ? event.author?.user_openid : event.author?.member_openid;
    if (!peerOpenId || !authorOpenId || !event.id) return undefined;

    const chatKey = `${chatType}:${peerOpenId}`;
    // The same message may arrive through both GROUP_MESSAGE_CREATE and GROUP_AT_MESSAGE_CREATE.
    const eventKey = `${chatKey}:${event.id}`;
    const mentionedBot = eventType === "GROUP_AT_MESSAGE_CREATE" || event.mentions?.some((mention) => mention.is_you === true);
    const parsedTimestamp = event.timestamp ? Date.parse(event.timestamp) : Date.now();
    const receivedAt = Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now();

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#db.prepare(`
        INSERT OR IGNORE INTO inbound(
          event_key, chat_key, chat_type, peer_openid, message_id, author_openid,
          author_name, content, mentioned_bot, received_at, status
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')
      `).run(
        eventKey,
        chatKey,
        chatType,
        peerOpenId,
        event.id,
        authorOpenId,
        event.author?.username ?? "QQ 用户",
        event.content ?? "",
        mentionedBot ? 1 : 0,
        receivedAt,
      );
      if (mentionedBot) {
        this.#db.prepare("UPDATE inbound SET mentioned_bot = 1 WHERE event_key = ?").run(eventKey);
      }
      if (sequence !== undefined) {
        this.#db.prepare("UPDATE gateway_state SET session_id = COALESCE(?, session_id), sequence = ? WHERE id = 1")
          .run(sessionId ?? null, sequence);
      }
      this.#db.exec("COMMIT");
      return Number(result.changes) > 0 ? this.getInbound(eventKey) : undefined;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  getInbound(eventKey: string): InboundRow | undefined {
    return this.#db.prepare(`
      SELECT event_key AS eventKey, chat_key AS chatKey, chat_type AS chatType,
        peer_openid AS peerOpenId, message_id AS messageId, author_openid AS authorOpenId,
        author_name AS authorName, content, mentioned_bot AS mentionedBot, received_at AS receivedAt, status,
        submission_id AS submissionId
      FROM inbound WHERE event_key = ?
    `).get(eventKey) as InboundRow | undefined;
  }

  saveGatewayState(sessionId: string | null, sequence: number | null): void {
    this.#db.prepare("UPDATE gateway_state SET session_id = ?, sequence = ? WHERE id = 1").run(sessionId, sequence);
  }

  gatewayState(): GatewayState {
    const row = this.#db.prepare("SELECT session_id AS sessionId, sequence FROM gateway_state WHERE id = 1")
      .get() as { sessionId: string | null; sequence: number | null } | undefined;
    return row ?? { sessionId: null, sequence: null };
  }

  getChat(chatKey: string): number | undefined {
    const row = this.#db.prepare("SELECT conversation_id AS conversationId FROM chats WHERE chat_key = ?")
      .get(chatKey) as { conversationId: number } | undefined;
    return row?.conversationId;
  }

  setChat(chatKey: string, conversationId: number): void {
    this.#db.prepare("INSERT OR IGNORE INTO chats(chat_key, conversation_id, created_at) VALUES(?, ?, ?)")
      .run(chatKey, conversationId, Date.now());
  }

  queuedChats(): string[] {
    return (this.#db.prepare("SELECT chat_key AS chatKey FROM inbound WHERE status IN ('queued','submitted') GROUP BY chat_key ORDER BY MIN(received_at)")
      .all() as Array<{ chatKey: string }>).map((row) => row.chatKey);
  }

  nextInbound(chatKey: string): InboundRow | undefined {
    return this.#db.prepare(`
      SELECT event_key AS eventKey, chat_key AS chatKey, chat_type AS chatType,
        peer_openid AS peerOpenId, message_id AS messageId, author_openid AS authorOpenId,
        author_name AS authorName, content, mentioned_bot AS mentionedBot, received_at AS receivedAt, status,
        submission_id AS submissionId
      FROM inbound WHERE chat_key = ? AND status IN ('queued','submitted')
      ORDER BY received_at, rowid LIMIT 1
    `).get(chatKey) as InboundRow | undefined;
  }

  recentMessages(chatKey: string, before: number, limit = 12): InboundRow[] {
    const rows = this.#db.prepare(`
      SELECT event_key AS eventKey, chat_key AS chatKey, chat_type AS chatType,
        peer_openid AS peerOpenId, message_id AS messageId, author_openid AS authorOpenId,
        author_name AS authorName, content, mentioned_bot AS mentionedBot, received_at AS receivedAt, status,
        submission_id AS submissionId
      FROM inbound WHERE chat_key = ? AND received_at < ?
      ORDER BY received_at DESC LIMIT ?
    `).all(chatKey, before, limit) as unknown as InboundRow[];
    return rows.reverse();
  }

  markSubmitted(eventKey: string, submissionId: number): void {
    this.#db.prepare("UPDATE inbound SET status = 'submitted', submission_id = ? WHERE event_key = ?")
      .run(submissionId, eventKey);
  }

  finishInbound(eventKey: string, expired = false): void {
    this.#db.prepare("UPDATE inbound SET status = ? WHERE event_key = ?")
      .run(expired ? "expired" : "done", eventKey);
  }

  enqueueReply(row: InboundRow, content: string): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(`
        INSERT OR IGNORE INTO outbox(event_key, chat_type, peer_openid, message_id, content, created_at)
        VALUES(?, ?, ?, ?, ?, ?)
      `).run(row.eventKey, row.chatType, row.peerOpenId, row.messageId, content, Date.now());
      this.#db.prepare("UPDATE inbound SET status = 'done' WHERE event_key = ?").run(row.eventKey);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  pendingOutbox(): OutboxRow[] {
    return this.#db.prepare(`
      SELECT event_key AS eventKey, chat_type AS chatType, peer_openid AS peerOpenId,
        message_id AS messageId, content, created_at AS createdAt, attempts, next_attempt_at AS nextAttemptAt
      FROM outbox ORDER BY created_at, rowid
    `).all() as unknown as OutboxRow[];
  }

  recordOutboxAttempt(eventKey: string, nextAttemptAt: number): void {
    this.#db.prepare("UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ? WHERE event_key = ?").run(nextAttemptAt, eventKey);
  }

  markOutboxSent(eventKey: string): void {
    this.#db.prepare("DELETE FROM outbox WHERE event_key = ?").run(eventKey);
  }

  expireOutbox(eventKey: string): void {
    this.#db.prepare("DELETE FROM outbox WHERE event_key = ?").run(eventKey);
    this.finishInbound(eventKey, true);
  }

  counts(): { queued: number; completed: number; pendingReplies: number; chats: number } {
    const inbound = this.#db.prepare(`
      SELECT SUM(status IN ('queued','submitted')) AS queued,
        SUM(status IN ('done','expired')) AS completed FROM inbound
    `).get() as { queued: number | null; completed: number | null };
    const replies = this.#db.prepare("SELECT COUNT(*) AS count FROM outbox").get() as { count: number };
    const chats = this.#db.prepare("SELECT COUNT(*) AS count FROM chats").get() as { count: number };
    return {
      queued: inbound.queued ?? 0,
      completed: inbound.completed ?? 0,
      pendingReplies: replies.count,
      chats: chats.count,
    };
  }

  close(): void {
    this.#db.close();
  }
}
