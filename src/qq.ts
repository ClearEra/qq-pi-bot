import WebSocket, { type RawData } from "ws";

const API_BASE = "https://api.sgroup.qq.com";
const TOKEN_BASE = "https://bots.qq.com";
const GATEWAY_URL = `${API_BASE}/gateway`;
const TOKEN_URL = `${TOKEN_BASE}/app/getAppAccessToken`;
const MESSAGE_INTENT = 1 << 25;
const MAX_RECONNECT_DELAY_MS = 60_000;

type GatewayPacket = {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
};

export interface QQMessageEvent {
  id?: string;
  content?: string;
  timestamp?: string;
  msg_seq?: number;
  group_openid?: string;
  mentions?: Array<{ is_you?: boolean; bot?: boolean; member_openid?: string; user_openid?: string }>;
  message_scene?: { ext?: string[] };
  author?: {
    user_openid?: string;
    member_openid?: string;
    username?: string;
    bot?: boolean;
  };
}

export interface QQClientOptions {
  appId: string;
  clientSecret: string;
  websocketUrl?: string;
  sessionId?: string;
  sequence?: number;
  fetch?: typeof fetch;
  onMessage(eventType: string, event: QQMessageEvent, sequence: number | undefined, sessionId: string | undefined): Promise<void>;
  onSequence(sessionId: string | undefined, sequence: number): void;
  onStatus(status: string, details?: string): void;
}

export class QQClient {
  readonly #options: QQClientOptions;
  readonly #fetch: typeof fetch;
  #socket: WebSocket | undefined;
  #accessToken = "";
  #tokenExpiresAt = 0;
  #forceTokenRefresh = false;
  #sessionId: string | undefined;
  #sequence: number | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #reconnectAttempt = 0;
  #intentionalClose = false;
  #heartbeatInterval = 45_000;
  #lastHeartbeatAck = true;
  #resumeRequested = false;
  #fatal = false;
  #botId = "";
  #online = false;

  get botId(): string {
    return this.#botId;
  }

  get status(): string {
    if (this.#fatal) return "fatal";
    return this.#online ? "online" : this.#socket?.readyState === WebSocket.OPEN ? "connecting" : "disconnected";
  }

  constructor(options: QQClientOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
    this.#sessionId = options.sessionId;
    this.#sequence = options.sequence;
  }

  start(): Promise<void> {
    this.#intentionalClose = false;
    void this.#connect();
    return Promise.resolve();
  }

  stop(): void {
    this.#intentionalClose = true;
    this.#online = false;
    this.#clearTimers();
    this.#socket?.close(1000, "shutdown");
    this.#socket = undefined;
  }

  async sendMessage(chatType: "c2c" | "group", peerOpenId: string, messageId: string, content: string): Promise<void> {
    const token = await this.#getAccessToken();
    const endpoint = chatType === "c2c"
      ? `/v2/users/${encodeURIComponent(peerOpenId)}/messages`
      : `/v2/groups/${encodeURIComponent(peerOpenId)}/messages`;
    const response = await this.#fetch(`${API_BASE}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `QQBot ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ content, msg_type: 0, msg_id: messageId, msg_seq: 1 }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      // Do not log response bodies: they may echo chat text or credentials.
      if (response.status === 401) this.#forceTokenRefresh = true;
      throw new Error(`QQ send ${response.status}`);
    }
    const receipt = await response.json() as { id?: string };
    if (!receipt.id) throw new Error("QQ send response missing message receipt");
  }

  async #connect(): Promise<void> {
    if (this.#intentionalClose) return;
    this.#options.onStatus("authenticating");
    try {
      const token = await this.#getAccessToken();
      const url = this.#options.websocketUrl || await this.#getGatewayUrl(token);
      if (this.#intentionalClose) return;
      this.#resumeRequested = Boolean(this.#sessionId && this.#sequence !== undefined);
      const socket = new WebSocket(url, { handshakeTimeout: 20_000, perMessageDeflate: false });
      this.#socket = socket;
      let queue = Promise.resolve();
      let failed = false;

      socket.on("open", () => {
        this.#lastHeartbeatAck = true;
        this.#options.onStatus("connecting");
      });
      socket.on("message", (data) => {
        queue = queue.then(async () => {
          if (failed || this.#intentionalClose || this.#socket !== socket) return;
          await this.#handleMessage(data, socket);
        }).catch((error: unknown) => {
          failed = true;
          this.#options.onStatus("error", errorMessage(error));
          socket.close(4000, "event handler failed");
        });
      });
      socket.on("error", (error) => this.#options.onStatus("error", error.message));
      socket.on("close", (code, reason) => {
        if (this.#socket !== socket) return;
        failed = true;
        this.#clearHeartbeat();
        this.#online = false;
        if (this.#intentionalClose) return;
        if (code === 4914 || code === 4915) {
          this.#fatal = true;
          this.#options.onStatus("fatal", `close=${code} ${reason.toString()}`);
          return;
        }
        if (code === 4004) this.#forceTokenRefresh = true;
        if (code === 4006 || code === 4007 || code === 4009) {
          this.#sessionId = undefined;
          this.#sequence = undefined;
          this.#options.onSequence(undefined, 0);
        }
        this.#options.onStatus("reconnecting", `close=${code} ${reason.toString()}`);
        this.#scheduleReconnect(code === 4008 ? 60_000 : undefined);
      });
    } catch (error) {
      this.#options.onStatus("reconnecting", errorMessage(error));
      this.#scheduleReconnect();
    }
  }

  async #handleMessage(data: RawData, socket: WebSocket): Promise<void> {
    let packet: GatewayPacket;
    try {
      packet = JSON.parse(rawDataToString(data)) as GatewayPacket;
    } catch {
      this.#options.onStatus("error", "收到无法解析的 Gateway 数据包");
      return;
    }

    switch (packet.op) {
      case 10: {
        const hello = packet.d as { heartbeat_interval?: number } | undefined;
        this.#heartbeatInterval = Math.max(5_000, hello?.heartbeat_interval ?? 45_000);
        const token = await this.#getAccessToken();
        if (this.#intentionalClose || this.#socket !== socket || socket.readyState !== WebSocket.OPEN) return;
        if (this.#resumeRequested && this.#sessionId && this.#sequence !== undefined) {
          this.#send({ op: 6, d: { token: `QQBot ${token}`, session_id: this.#sessionId, seq: this.#sequence } });
        } else {
          this.#send({
            op: 2,
            d: {
              token: `QQBot ${token}`,
              intents: MESSAGE_INTENT,
              shard: [0, 1],
              properties: { $os: process.platform, $browser: "pi", $device: "pi-qq-bot" },
            },
          });
        }
        this.#startHeartbeat();
        break;
      }
      case 0: {
        const payload = packet.d as Record<string, unknown> | undefined;
        if (packet.t === "READY") {
          this.#sessionId = String(payload?.session_id ?? "");
          const user = payload?.user as { username?: string; id?: string } | undefined;
          this.#botId = user?.id ?? this.#botId;
          this.#options.onSequence(this.#sessionId, packet.s ?? this.#sequence ?? 0);
          this.#online = true;
          this.#reconnectAttempt = 0;
          this.#options.onStatus("online", String(user?.username ?? ""));
        } else if (packet.t === "RESUMED") {
          this.#online = true;
          this.#reconnectAttempt = 0;
          this.#options.onStatus("online", "会话已恢复");
        } else if (packet.t === "C2C_MESSAGE_CREATE" || packet.t === "GROUP_AT_MESSAGE_CREATE" || packet.t === "GROUP_MESSAGE_CREATE") {
          await this.#options.onMessage(packet.t, (payload ?? {}) as QQMessageEvent, packet.s, this.#sessionId);
        }
        if (packet.s !== undefined) {
          this.#sequence = packet.s;
          this.#options.onSequence(this.#sessionId, packet.s);
        }
        break;
      }
      case 1:
        this.#lastHeartbeatAck = false;
        this.#sendHeartbeat();
        break;
      case 7:
        this.#options.onStatus("reconnecting", "服务器要求重新连接");
        this.#socket?.close(4000, "reconnect requested");
        break;
      case 9: {
        const canResume = packet.d === true;
        if (!canResume) {
          this.#sessionId = undefined;
          this.#sequence = undefined;
          this.#options.onSequence(undefined, 0);
        }
        this.#forceTokenRefresh = !canResume;
        this.#options.onStatus("reconnecting", "Gateway 拒绝或重置了会话");
        this.#socket?.close(4004, "invalid session");
        break;
      }
      case 11:
        this.#lastHeartbeatAck = true;
        break;
      default:
        break;
    }
  }

  async #getAccessToken(): Promise<string> {
    if (!this.#forceTokenRefresh && this.#accessToken && Date.now() < this.#tokenExpiresAt - 60_000) return this.#accessToken;
    const response = await this.#fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: this.#options.appId, clientSecret: this.#options.clientSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`获取 QQ Access Token 失败: HTTP ${response.status}`);
    const data = await response.json() as { access_token?: string; expires_in?: number; message?: string };
    if (!data.access_token) throw new Error(`QQ Access Token 响应缺少 access_token: ${data.message ?? "unknown error"}`);
    this.#accessToken = data.access_token;
    this.#tokenExpiresAt = Date.now() + (data.expires_in ?? 7_200) * 1_000;
    this.#forceTokenRefresh = false;
    return this.#accessToken;
  }

  async #getGatewayUrl(token: string): Promise<string> {
    const response = await this.#fetch(GATEWAY_URL, {
      headers: { Authorization: `QQBot ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`获取 QQ Gateway 地址失败: HTTP ${response.status}`);
    const result = await response.json() as { url?: string };
    if (!result.url) throw new Error("QQ Gateway 响应缺少 url");
    return result.url;
  }

  #startHeartbeat(): void {
    this.#clearHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      if (!this.#lastHeartbeatAck) {
        this.#socket?.terminate();
        return;
      }
      this.#sendHeartbeat();
    }, this.#heartbeatInterval);
  }

  #sendHeartbeat(): void {
    this.#lastHeartbeatAck = false;
    this.#send({ op: 1, d: this.#sequence ?? null });
  }

  #send(packet: unknown): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(packet));
  }

  #scheduleReconnect(minimumDelayMs = 0): void {
    if (this.#intentionalClose || this.#fatal || this.#reconnectTimer) return;
    const exponential = Math.max(minimumDelayMs, Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * 2 ** this.#reconnectAttempt++));
    const jittered = minimumDelayMs > 0 ? minimumDelayMs : Math.round(exponential * (0.75 + Math.random() * 0.5));
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#connect();
    }, jittered);
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
  }

  #clearTimers(): void {
    this.#clearHeartbeat();
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
  }
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
