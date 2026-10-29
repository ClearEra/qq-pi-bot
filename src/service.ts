import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const execFile = promisify(execFileCallback);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LABEL = "org.pi.qq-bot";
const PLIST_PATH = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG_DIR = path.join(os.homedir(), ".pi", "qq-bot", "logs");
const UID = process.getuid?.() ?? 501;
const DOMAIN = `gui/${UID}`;

async function install(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("LaunchAgent installer requires macOS");
  await mkdir(path.dirname(PLIST_PATH), { recursive: true });
  await mkdir(LOG_DIR, { recursive: true, mode: 0o700 });
  const node = process.execPath;
  const manifest = JSON.parse(await readFile(path.join(ROOT, "release.json"), "utf8")) as { commit: string; mainSha256: string };
  const revision = manifest.commit;
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Invalid release manifest; deploy through npm run deploy");
  const digest = createHash("sha256").update(await readFile(path.join(ROOT, "dist", "main.js"))).digest("hex");
  if (digest !== manifest.mainSha256) throw new Error("Release entrypoint differs from its manifest");
  const caffeinate = "/usr/bin/caffeinate";
  const args = [caffeinate, "-i", "-s", node, path.join(ROOT, "dist", "main.js")];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
  <key>WorkingDirectory</key><string>${xml(ROOT)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(path.join(LOG_DIR, "service.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(LOG_DIR, "service-error.log"))}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(`${path.dirname(node)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`)}</string><key>PI_QQ_BOT_HOME</key><string>${xml(path.join(os.homedir(), ".pi", "qq-bot"))}</string><key>PI_QQ_BOT_COMMIT</key><string>${xml(revision)}</string></dict>
</dict></plist>
`;
  await writeFile(PLIST_PATH, plist, { mode: 0o600 });
  await execFile("launchctl", ["bootout", DOMAIN, PLIST_PATH]).catch(() => undefined);
  await execFile("launchctl", ["bootstrap", DOMAIN, PLIST_PATH]);
  await execFile("launchctl", ["kickstart", "-k", `${DOMAIN}/${LABEL}`]);
  console.log(`Pi QQ Bot LaunchAgent 已安装并启动: ${LABEL}`);
  console.log(`日志目录: ${LOG_DIR}`);
  console.log("LaunchAgent 在用户登录后启动；Mac 睡眠或断网时 QQ 连接也会中断。");
}

async function uninstall(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("LaunchAgent installer requires macOS");
  await execFile("launchctl", ["bootout", DOMAIN, PLIST_PATH]).catch(() => undefined);
  await unlink(PLIST_PATH).catch(() => undefined);
  console.log(`Pi QQ Bot LaunchAgent 已卸载: ${LABEL}`);
}

async function status(): Promise<void> {
  try {
    const result = await execFile("launchctl", ["print", `${DOMAIN}/${LABEL}`]);
    console.log(result.stdout.trim());
  } catch {
    console.log("Pi QQ Bot LaunchAgent 未加载");
    process.exitCode = 1;
  }
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

const action = process.argv[2] ?? "install";
const actions = { install, uninstall, status } as const;
if (!(action in actions)) {
  console.error("Usage: node dist/service.js [install|uninstall|status]");
  process.exitCode = 2;
} else {
  actions[action as keyof typeof actions]().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
