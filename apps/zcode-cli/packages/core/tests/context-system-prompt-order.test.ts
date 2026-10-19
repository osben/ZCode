import { describe, expect, it } from "vitest";
import {
  SYSTEM_PROMPT_DEFAULTS,
  SYSTEM_PROMPT_MAIN_PROMPT_ORDER,
  SYSTEM_PROMPT_OVERRIDE_KEYS,
  SYSTEM_PROMPT_PLACEHOLDERS,
  SYSTEM_PROMPT_RUNTIME_SUBSTITUTED_KEYS,
  type SystemPromptOverrideKey,
} from "@zcode/shared";
import { createContextBuilder } from "../src/context/index.js";

const sentinelFor = (key: SystemPromptOverrideKey) => `SENTINEL-${key}`;

/**
 * Drift guard for the Settings "Assembled prompt" preview, which lists the main-prompt keys in
 * SYSTEM_PROMPT_MAIN_PROMPT_ORDER. That order must equal the order ContextBuilder.build() emits:
 * each main key gets a distinct sentinel override, and the sentinel positions are compared.
 */
describe("system prompt main-prompt order matches ContextBuilder", () => {
  it("emits every main key once, in the order the shared constant lists", () => {
    const overrides: Partial<Record<SystemPromptOverrideKey, string>> = {};
    for (const key of SYSTEM_PROMPT_MAIN_PROMPT_ORDER) {
      overrides[key] =
        key === "memory-guidance"
          ? `${sentinelFor(key)} {{memoryRoot}}`
          : sentinelFor(key);
    }
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "darwin",
        shell: "zsh",
        osVersion: "Darwin 25.4.0",
        nodeVersion: "v24.14.0",
      },
      guidanceToolNames: ["Read", "Edit", "Bash", "Agent", "TodoWrite", "AskUserQuestion"],
      memoryRoot: "/mem/root",
      systemPromptOverrides: overrides,
    }).build();
    const emitted = result.systemMessages.map((message) => String(message.content)).join("\n");

    const positions = SYSTEM_PROMPT_MAIN_PROMPT_ORDER.map((key) => {
      const token = sentinelFor(key);
      expect(emitted.split(token).length - 1, `${key} sentinel count`).toBe(1);
      return emitted.indexOf(token);
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("gives placeholders only to the keys the runtime substitutes", () => {
    for (const key of SYSTEM_PROMPT_OVERRIDE_KEYS) {
      const substituted = (SYSTEM_PROMPT_RUNTIME_SUBSTITUTED_KEYS as readonly string[]).includes(key);
      expect(SYSTEM_PROMPT_DEFAULTS[key].includes("{{"), `${key} default`).toBe(substituted);
      expect(SYSTEM_PROMPT_PLACEHOLDERS[key].length > 0, `${key} placeholders`).toBe(substituted);
    }
  });
});
