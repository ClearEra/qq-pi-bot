import assert from "node:assert/strict";
import test from "node:test";
import { validateConfig, DEFAULT_CONFIG } from "./config.js";

test("configuration uses Pi defaults and validates deadlines, input limits and chat policy", () => {
  const valid = { ...DEFAULT_CONFIG, appId: "123456" };
  assert.equal(validateConfig(valid).provider, "");
  for (const patch of [
    { appId: "not-an-id" }, { groupMode: "anything" }, { groups: "true" },
    { replyDeadlineSeconds: -1 }, { replyDeadlineSeconds: 300 }, { maxMessageChars: 0 },
    { maxMessageChars: 100000 }, { websocketUrl: "ws://external.example" },
  ]) assert.throws(() => validateConfig({ ...valid, ...patch }));
});
