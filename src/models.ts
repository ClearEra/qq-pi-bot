import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import type { Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { BotConfig } from "./config.js";

interface PiModelsFile {
  providers?: Record<string, {
    name?: string;
    baseUrl?: string;
    api?: string;
    apiKey?: string;
    headers?: Record<string, string>;
    models?: Array<{
      id: string;
      name?: string;
      api?: string;
      reasoning?: boolean;
      input?: Array<"text" | "image">;
      contextWindow?: number;
      maxTokens?: number;
      compat?: Model<"openai-completions">["compat"];
      thinkingLevelMap?: Model<"openai-completions">["thinkingLevelMap"];
    }>;
  }>;
}

interface PiSettingsFile {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
}

export interface PiModelRuntime {
  models: ReturnType<typeof createModels>;
  providerId: string;
  modelId: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export async function loadPiModels(config: BotConfig): Promise<PiModelRuntime> {
  const piDir = path.join(os.homedir(), ".pi", "agent");
  const [modelsText, settingsText] = await Promise.all([
    readFile(path.join(piDir, "models.json"), "utf8"),
    readFile(path.join(piDir, "settings.json"), "utf8").catch(() => "{}"),
  ]);
  const catalog = JSON.parse(modelsText) as PiModelsFile;
  const settings = JSON.parse(settingsText) as PiSettingsFile;
  const providerId = config.provider || settings.defaultProvider;
  const modelId = config.modelId || settings.defaultModel;
  if (!providerId || !modelId) throw new Error("Configure a default Pi provider and model in ~/.pi/agent/settings.json");

  const configured = catalog.providers?.[providerId];
  if (!configured?.baseUrl || !configured.apiKey || !configured.models?.length) {
    throw new Error(`Pi provider '${providerId}' is missing its baseUrl, apiKey or models in ~/.pi/agent/models.json`);
  }
  if (configured.api && configured.api !== "openai-completions") {
    throw new Error(`Pi provider '${providerId}' uses '${configured.api}'; this bot currently supports Pi OpenAI-compatible providers`);
  }

  const modelList = configured.models.map((item) => ({
    id: item.id,
    name: item.name ?? item.id,
    api: "openai-completions" as const,
    provider: providerId,
    baseUrl: configured.baseUrl!,
    reasoning: item.reasoning ?? false,
    input: item.input ?? ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: item.contextWindow ?? 128_000,
    maxTokens: item.maxTokens ?? 16_384,
    ...(item.compat === undefined ? {} : { compat: item.compat }),
    ...(item.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: item.thinkingLevelMap }),
  }));
  if (!modelList.some((item) => item.id === modelId)) {
    throw new Error(`Model '${modelId}' is not defined for Pi provider '${providerId}'`);
  }

  const provider = createProvider({
    id: providerId,
    name: configured.name ?? providerId,
    baseUrl: configured.baseUrl,
    ...(configured.headers ? { headers: configured.headers } : {}),
    auth: {
      apiKey: {
        name: `Pi ${providerId} API key`,
        resolve: async () => ({ auth: { apiKey: configured.apiKey! } }),
      },
    },
    models: modelList,
    api: openAICompletionsApi(),
  });
  const models = createModels();
  models.setProvider(provider);
  const level = settings.defaultThinkingLevel ?? "low";
  const allowed = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
  return {
    models,
    providerId,
    modelId,
    thinkingLevel: allowed.has(level) ? level as PiModelRuntime["thinkingLevel"] : "low",
  };
}
