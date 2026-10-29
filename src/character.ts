import { defineExtension, section } from "@earendil-works/pi-durable";
import { readPromptFiles } from "./config.js";

export const characterExtension = defineExtension({
  name: "qq-character",
  sections: [
    section("qq-bot-identity", async () => (await readPromptFiles()).identity),
    section("qq-bot-personality", async () => (await readPromptFiles()).role),
    section("qq-bot-reply-policy", () =>
      "You receive exactly one new QQ message as a JSON object. Always call reply_decision exactly once. Choose silent when you should not speak. Never answer with ordinary assistant text.",
    ),
  ],
});
