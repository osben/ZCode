import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildForkAgentRuntimeHostEnv,
  primeForkAgentRuntimeSelection,
  resetForkAgentRuntimeSelectionForTests,
  resolveForkAgentRuntimeSelection,
  resolveRustAgentBinaryCandidates,
} from "../src/main/fork-agent-runtime/contract.js";

const present = (paths: string[]) => async (path: string) => paths.includes(path);

describe("resolveForkAgentRuntimeSelection", () => {
  it("defaults to node without env or setting", async () => {
    await expect(
      resolveForkAgentRuntimeSelection({
        envValue: undefined,
        storedSetting: undefined,
        binaryCandidates: ["/bin/zcode-rs"],
        isUsable: present(["/bin/zcode-rs"]),
      }),
    ).resolves.toEqual({ selected: "node", effective: "node", source: "default" });
  });

  it("uses the stored setting and the first usable binary", async () => {
    await expect(
      resolveForkAgentRuntimeSelection({
        envValue: undefined,
        storedSetting: "rust",
        binaryCandidates: ["/a/zcode-rs", "/b/zcode-rs"],
        isUsable: present(["/b/zcode-rs"]),
      }),
    ).resolves.toEqual({
      selected: "rust",
      effective: "rust",
      source: "setting",
      rustAgentPath: "/b/zcode-rs",
    });
  });

  it("lets a valid shell value override the setting", async () => {
    const selection = await resolveForkAgentRuntimeSelection({
      envValue: " node ",
      storedSetting: "rust",
      binaryCandidates: ["/bin/zcode-rs"],
      isUsable: present(["/bin/zcode-rs"]),
    });
    expect(selection).toMatchObject({ selected: "node", effective: "node", source: "env" });
  });

  it("ignores an invalid shell value and reports it", async () => {
    const selection = await resolveForkAgentRuntimeSelection({
      envValue: "deno",
      storedSetting: "node",
      binaryCandidates: [],
    });
    expect(selection).toMatchObject({ source: "setting", ignoredEnvValue: "deno" });
  });

  it("falls back to node with a reason when the rust binary is missing", async () => {
    await expect(
      resolveForkAgentRuntimeSelection({
        envValue: "rust",
        storedSetting: undefined,
        binaryCandidates: ["/missing/zcode-rs"],
        isUsable: present([]),
      }),
    ).resolves.toEqual({
      selected: "rust",
      effective: "node",
      source: "env",
      fallbackReason: "binary_missing",
    });
  });
});

describe("resolveRustAgentBinaryCandidates", () => {
  it("prefers an explicit path", () => {
    expect(
      resolveRustAgentBinaryCandidates({
        explicitPath: "/x/zcode-rs",
        isPackaged: true,
        resourcesPath: "/r",
        devResourcesDir: "/d",
      }),
    ).toEqual(["/x/zcode-rs"]);
  });

  it("uses a dedicated resources directory, never resources/glm", () => {
    const packaged = resolveRustAgentBinaryCandidates({
      isPackaged: true,
      resourcesPath: "/r",
      devResourcesDir: "/d",
      platform: "win32",
    });
    expect(packaged).toEqual([join("/r", "zcode-rs", "zcode-rs.exe")]);
    const dev = resolveRustAgentBinaryCandidates({
      isPackaged: false,
      devResourcesDir: "/d",
      platform: "darwin",
    });
    expect(dev).toEqual([join("/d", "zcode-rs", "zcode-rs")]);
    expect([...packaged, ...dev].every((path) => !path.split(/[\\/]/).includes("glm"))).toBe(true);
  });
});

describe("buildForkAgentRuntimeHostEnv", () => {
  it("replaces inherited values with the decided runtime", () => {
    const env = buildForkAgentRuntimeHostEnv(
      {
        KEEP: "1",
        ZCODE_FORK_AGENT_RUNTIME: "rust",
        ZCODE_FORK_RUST_AGENT_PATH: "/shell/zcode-rs",
      },
      { selected: "rust", effective: "node", source: "env", fallbackReason: "binary_missing" },
    );
    expect(env).toEqual({ KEEP: "1", ZCODE_FORK_AGENT_RUNTIME: "node" });
  });

  it("writes the binary path only for an effective rust runtime", () => {
    expect(
      buildForkAgentRuntimeHostEnv(
        {},
        { selected: "rust", effective: "rust", source: "setting", rustAgentPath: "/r/zcode-rs" },
      ),
    ).toEqual({ ZCODE_FORK_AGENT_RUNTIME: "rust", ZCODE_FORK_RUST_AGENT_PATH: "/r/zcode-rs" });
  });

  it("gives node before the selection is primed", () => {
    expect(buildForkAgentRuntimeHostEnv({ ZCODE_FORK_AGENT_RUNTIME: "rust" }, undefined)).toEqual({
      ZCODE_FORK_AGENT_RUNTIME: "node",
    });
  });
});

describe("primeForkAgentRuntimeSelection", () => {
  afterEach(() => resetForkAgentRuntimeSelectionForTests());

  it("decides once per process so a later setting change waits for restart", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const readStoredSetting = vi.fn(async () => "node");
    const first = await primeForkAgentRuntimeSelection({
      readStoredSetting,
      logger,
      env: {},
      isPackaged: false,
    });
    readStoredSetting.mockResolvedValue("rust");
    const second = await primeForkAgentRuntimeSelection({
      readStoredSetting,
      logger,
      env: {},
      isPackaged: false,
    });
    expect(second).toBe(first);
    expect(readStoredSetting).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith("[agent-runtime] selection resolved", {
      selected: "node",
      effective: "node",
      source: "setting",
    });
  });

  it("falls back to the default when the setting read fails", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const selection = await primeForkAgentRuntimeSelection({
      readStoredSetting: async () => {
        throw Object.assign(new Error("EACCES: /private/settings/path"), { code: "EACCES" });
      },
      logger,
      env: {},
      isPackaged: false,
    });
    expect(selection).toMatchObject({ effective: "node", source: "default" });
    // Only the code is logged: the message can carry the settings path.
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { code: "EACCES" });
  });

  it("warns about an invalid env value and uses the setting", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const selection = await primeForkAgentRuntimeSelection({
      readStoredSetting: async () => "node",
      logger,
      env: { ZCODE_FORK_AGENT_RUNTIME: "python" },
      isPackaged: false,
    });
    expect(selection).toMatchObject({ effective: "node", source: "setting" });
    expect(logger.warn).toHaveBeenCalledWith(
      "[agent-runtime] ignored invalid ZCODE_FORK_AGENT_RUNTIME value",
    );
  });

  it("warns once when rust is selected but the binary is missing", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const selection = await primeForkAgentRuntimeSelection({
      readStoredSetting: async () => "rust",
      logger,
      env: { ZCODE_FORK_RUST_AGENT_PATH: "/definitely/missing/zcode-rs" },
      isPackaged: false,
    });
    expect(selection).toMatchObject({ effective: "node", fallbackReason: "binary_missing" });
    await primeForkAgentRuntimeSelection({
      readStoredSetting: async () => "rust",
      logger,
      env: { ZCODE_FORK_RUST_AGENT_PATH: "/definitely/missing/zcode-rs" },
      isPackaged: false,
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "[agent-runtime] rust agent binary missing, running node",
      expect.objectContaining({ selected: "rust", effective: "node", reason: "binary_missing" }),
    );
  });
});
