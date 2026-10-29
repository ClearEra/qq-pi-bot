import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import path from "node:path";
import {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  IDENTITY_PATH,
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  ROLE_PATH,
  ensureAppFiles,
  saveConfig,
} from "./config.js";

async function setup(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("当前 Keychain 凭据助手需要 macOS");
  await ensureAppFiles();
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const appId = (await rl.question("QQ Bot AppID: ")).trim();
    if (!/^\d{5,}$/.test(appId)) throw new Error("AppID 格式无效");
    const previous = await readLocalConfig();
    const config = { ...DEFAULT_CONFIG, ...previous, appId };
    await saveConfig(config);
    await saveKeychainSecret();
    await configureModel(rl);
    await configurePersonality(rl);
    await validatePiConfiguration();

    console.log("\nQQ Bot 本地配置已完成。凭据存放在 macOS Keychain。\n");
    console.log("下一步：");
    console.log("1. 运行 npm run install-service 安装 Pi QQ 服务");
    console.log("2. 访问 http://127.0.0.1:18797 修改角色设定和基础信息");
    console.log("3. 在 QQ 开放平台为群聊开通“接收所有消息”权限，并将机器人加入群聊");
  } finally {
    rl.close();
  }
}

async function saveKeychainSecret(): Promise<void> {
  console.log("\nmacOS Keychain 将安全地提示输入新的 AppSecret。不要复用已公开的旧密钥。");
  const result = spawnSync("security", [
    "add-generic-password",
    "-U",
    "-s", KEYCHAIN_SERVICE,
    "-a", KEYCHAIN_ACCOUNT,
    "-w",
  ], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("写入 macOS Keychain 失败");
}

async function configureModel(rl: readline.Interface): Promise<void> {
  const settingsPath = path.join(process.env.HOME ?? "", ".pi", "agent", "settings.json");
  const modelsPath = path.join(process.env.HOME ?? "", ".pi", "agent", "models.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
    defaultProvider?: string;
    defaultModel?: string;
    defaultThinkingLevel?: string;
  };
  const catalog = JSON.parse(await readFile(modelsPath, "utf8")) as {
    providers?: Record<string, { models?: Array<{ id: string; name?: string }> }>;
  };
  const providerNames = Object.keys(catalog.providers ?? {});
  let provider = settings.defaultProvider ?? "";
  if (!provider || !catalog.providers?.[provider]) {
    console.log(`\nPi models.json 中的 providers: ${providerNames.join(", ")}`);
    provider = (await rl.question(`选择 Pi provider (${providerNames[0] ?? ""}): `)).trim() || providerNames[0] || "";
  }
  const providerConfig = catalog.providers?.[provider];
  if (!providerConfig?.models?.length) throw new Error(`Pi models.json 中没有 ${provider} 的模型`);
  let modelId = settings.defaultModel ?? "";
  if (!providerConfig.models.some((model) => model.id === modelId)) {
    console.log(`可用模型: ${providerConfig.models.map((model) => model.id).join(", ")}`);
    modelId = (await rl.question(`选择模型 (${providerConfig.models[0]?.id ?? ""}): `)).trim() || providerConfig.models[0]?.id || "";
  }
  const stored = await readLocalConfig();
  await saveConfig({ ...stored, provider, modelId });
}

async function configurePersonality(rl: readline.Interface): Promise<void> {
  const update = (await rl.question("要用 Pi 当前工作区的 SOUL.md / IDENTITY.md 初始化 QQ 机器人的资料吗？[y/N] ")).trim().toLowerCase();
  if (update !== "y" && update !== "yes") return;
  const workspace = path.join(process.env.HOME ?? "", ".pi", "agent");
  for (const [name, target] of [["IDENTITY.md", IDENTITY_PATH], ["SOUL.md", ROLE_PATH]] as const) {
    try {
      const content = await readFile(path.join(workspace, name), "utf8");
      await writeFile(target, content, { mode: 0o600 });
      console.log(`已从 Pi 复制 ${name}`);
    } catch {
      console.log(`没有找到 Pi ${name}，保留默认设置`);
    }
  }
}

async function validatePiConfiguration(): Promise<void> {
  const app = await import("./models.js");
  const config = await readLocalConfig();
  await app.loadPiModels(config);
}

async function readLocalConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8")) as typeof DEFAULT_CONFIG;
  } catch {
    return DEFAULT_CONFIG;
  }
}

setup().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
