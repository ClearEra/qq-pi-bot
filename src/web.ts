import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { IDENTITY_PATH, ROLE_PATH } from "./config.js";

const MAX_PROFILE_BYTES = 32_000;

export async function startControlServer(options: {
  getStatus(): Promise<Record<string, unknown>>;
  port?: number;
  identityPath?: string;
  rolePath?: string;
}): Promise<Server> {
  const identityPath = options.identityPath ?? IDENTITY_PATH;
  const rolePath = options.rolePath ?? ROLE_PATH;
  const port = options.port ?? 18797;
  const server = createServer(async (request, response) => {
    try {
      applyHeaders(response);
      if (!isLocalRequest(request)) {
        sendJson(response, 403, { error: "仅允许同源本地请求" });
        return;
      }
      if (request.method === "GET" && request.url === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(profilePage());
        return;
      }
      if (request.method === "GET" && request.url === "/api/profile") {
        const [identity, role] = await Promise.all([readFile(identityPath, "utf8"), readFile(rolePath, "utf8")]);
        sendJson(response, 200, { identity, role });
        return;
      }
      if (request.method === "GET" && request.url === "/api/status") {
        sendJson(response, 200, await options.getStatus());
        return;
      }
      if (request.method === "PUT" && request.url === "/api/profile") {
        if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
          sendJson(response, 415, { error: "必须使用 application/json" });
          return;
        }
        const body = await readBody(request);
        const parsed = JSON.parse(body) as { identity?: unknown; role?: unknown };
        if (typeof parsed.identity !== "string" || typeof parsed.role !== "string") {
          sendJson(response, 400, { error: "identity 和 role 必须是文本" });
          return;
        }
        if (Buffer.byteLength(parsed.identity) > MAX_PROFILE_BYTES || Buffer.byteLength(parsed.role) > MAX_PROFILE_BYTES) {
          sendJson(response, 413, { error: "角色设定和基础信息各自不能超过 32 KB" });
          return;
        }
        await Promise.all([
          writeFile(identityPath, `${parsed.identity.trim()}\n`, { mode: 0o600 }),
          writeFile(rolePath, `${parsed.role.trim()}\n`, { mode: 0o600 }),
        ]);
        sendJson(response, 200, { saved: true });
        return;
      }
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      sendJson(response, error instanceof SyntaxError ? 400 : 500, { error: error instanceof SyntaxError ? "无效 JSON" : "请求处理失败" });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  console.log(`角色设置页：http://127.0.0.1:${typeof address === "object" && address ? address.port : port}`);
  return server;
}

function profilePage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pi QQ Bot 设置</title>
<style>
:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#18201e;background:#f4f6f5}*{box-sizing:border-box}body{margin:0}.top{background:#163e36;color:#fff;padding:18px 24px;display:flex;justify-content:space-between;align-items:center}.top h1{font-size:18px;margin:0}.status{font-size:13px;color:#cce3db}.wrap{max-width:1040px;margin:26px auto;padding:0 18px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}section{min-width:0}h2{font-size:15px;margin:0 0 10px}p{font-size:13px;color:#586560;margin:0 0 12px}textarea{display:block;width:100%;height:58vh;min-height:360px;resize:vertical;border:1px solid #cbd4d0;border-radius:5px;background:#fff;padding:14px;font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#18201e}textarea:focus{outline:2px solid #2e7767;border-color:transparent}.actions{display:flex;justify-content:flex-end;align-items:center;gap:14px;margin-top:18px}button{background:#176c59;color:#fff;border:0;border-radius:5px;padding:10px 18px;font-weight:600;cursor:pointer}button:disabled{opacity:.55;cursor:wait}#notice{font-size:13px;color:#176c59}@media(max-width:760px){.grid{grid-template-columns:1fr}.wrap{margin:18px auto}.top{padding:15px 18px}textarea{height:38vh;min-height:260px}}
</style>
</head>
<body>
<header class="top"><h1>Pi QQ Bot</h1><div class="status" id="status">正在连接</div></header>
<main class="wrap"><div class="grid"><section><h2>基础信息</h2><p>名称、背景、功能定位与语言偏好</p><textarea id="identity" spellcheck="false"></textarea></section><section><h2>角色设定</h2><p>个性、边界、回复判断和表达方式</p><textarea id="role" spellcheck="false"></textarea></section></div><div class="actions"><span id="notice" role="status"></span><button id="save">保存</button></div></main>
<script>
const identity=document.querySelector('#identity'),role=document.querySelector('#role'),notice=document.querySelector('#notice'),save=document.querySelector('#save');
async function load(){const r=await fetch('/api/profile');if(!r.ok)throw Error('读取设置失败');const p=await r.json();identity.value=p.identity;role.value=p.role;}
async function status(){try{const r=await fetch('/api/status');const s=await r.json();document.querySelector('#status').textContent=s.gateway==='online'?'QQ 已连接':('QQ: '+s.gateway+' · 消息 '+s.counts.queued+' · 会话 '+s.counts.chats)}catch{document.querySelector('#status').textContent='服务未连接'}}
save.addEventListener('click',async()=>{save.disabled=true;notice.textContent='正在保存';try{const r=await fetch('/api/profile',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({identity:identity.value,role:role.value})});const data=await r.json();if(!r.ok)throw Error(data.error||'保存失败');notice.textContent='已保存';}catch(e){notice.textContent=e.message}finally{save.disabled=false}});
load().catch(e=>notice.textContent=e.message);status();setInterval(status,5000);
</script>
</body></html>`;
}

function applyHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
}

function isLocalRequest(request: IncomingMessage): boolean {
  const address = request.socket.localAddress;
  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
  const port = request.socket.localPort;
  // Validate Host on every route to reject DNS rebinding, not just cross-origin writes.
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const host = request.headers.host;
  if (!host || !hosts.has(host)) return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  return !request.headers.origin || request.headers.origin === `http://${host}`;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_PROFILE_BYTES * 2 + 1024) throw new Error("Request too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}
