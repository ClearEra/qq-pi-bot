import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { get } from "node:http";
import { startControlServer } from "./web.js";

test("local profile editor saves files and rejects foreign Origin, Host, and malformed writes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-qq-web-"));
  const identityPath = path.join(directory, "IDENTITY.md");
  const rolePath = path.join(directory, "SOUL.md");
  await writeFile(identityPath, "identity");
  await writeFile(rolePath, "role");
  const server = await startControlServer({ port: 0, identityPath, rolePath, getStatus: async () => ({ gateway: "online" }) });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.deepEqual(await (await fetch(`${base}/api/profile`)).json(), { identity: "identity", role: "role" });
    const update = { method: "PUT", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ identity: "new identity", role: "new role" }) };
    assert.equal((await fetch(`${base}/api/profile`, update)).status, 200);
    assert.equal(await readFile(identityPath, "utf8"), "new identity\n");
    assert.equal((await fetch(`${base}/api/profile`, { ...update, headers: { ...update.headers, Origin: "https://attacker.example" } })).status, 403);
    assert.equal((await fetch(`${base}/api/profile`, { ...update, headers: { ...update.headers, Origin: "http://localhost:9999" } })).status, 403);
    const reboundStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(`${base}/api/profile`, { headers: { Host: "attacker.example" } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on("error", reject);
    });
    assert.equal(reboundStatus, 403);
    assert.equal((await fetch(`${base}/api/profile`, { ...update, body: "{" })).status, 400);
    assert.equal((await fetch(`${base}/api/profile`, { method: "PUT", body: "text" })).status, 415);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
