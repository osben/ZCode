import { describe, expect, it } from "vitest";
import {
  FORK_SETTING_KEYS,
  forkAppSettingsPatchSchema,
  forkAppSettingsSchema,
  forkAppSettingsStoredSchema,
  splitForkSettingsPatch,
} from "../src/forkAppSettings.js";

describe("agentRuntime fork setting", () => {
  it("defaults to node and is never materialised into the stored view", () => {
    expect(forkAppSettingsSchema.parse({}).agentRuntime).toBe("node");
    expect(forkAppSettingsStoredSchema.parse({})).not.toHaveProperty("agentRuntime");
  });

  it("drops an unknown stored value instead of failing the sidecar", () => {
    expect(
      forkAppSettingsStoredSchema.parse({ agentRuntime: "deno" }).agentRuntime,
    ).toBeUndefined();
    expect(forkAppSettingsSchema.parse({ agentRuntime: "deno" }).agentRuntime).toBe("node");
  });

  it("is routed to the sidecar, not setting.json", () => {
    expect(FORK_SETTING_KEYS).toContain("agentRuntime");
    const { forkPatch, basePatch } = splitForkSettingsPatch({ agentRuntime: "rust" });
    expect(forkPatch).toEqual({ agentRuntime: "rust" });
    expect(basePatch).not.toHaveProperty("agentRuntime");
    expect(forkAppSettingsPatchSchema.parse({ agentRuntime: "rust" })).toEqual({
      agentRuntime: "rust",
    });
  });
});
