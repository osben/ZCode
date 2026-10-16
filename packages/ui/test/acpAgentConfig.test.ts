import { describe, expect, it } from "vitest";
import type { AcpAgentSummary } from "@zcode/services";
import {
  acpProviderId,
  buildAcpAgentAccess,
  buildAcpPseudoModelConfig,
  formatAcpEnvLines,
  isAcpProviderId,
  joinAcpArgs,
  parseAcpEnvLines,
  splitAcpArgs,
} from "@/settings/model-provider-section/acpAgentConfig.js";

const AGENT: AcpAgentSummary = {
  agentId: "opencode",
  displayName: "opencode",
  installed: true,
  version: "2.0.31",
  commandPath: "/Users/x/.opencode/bin/opencode",
  spawnArgs: ["acp"],
  loginArgs: ["auth", "login"],
  statusArgs: ["auth", "list"],
};

describe("acpAgentConfig", () => {
  it("derives provider ids", () => {
    expect(acpProviderId("opencode")).toBe("acp:opencode");
    expect(isAcpProviderId("acp:cursor")).toBe(true);
    expect(isAcpProviderId("personal-1")).toBe(false);
  });

  it("splits and joins arguments", () => {
    expect(splitAcpArgs("acp --flag")).toEqual(["acp", "--flag"]);
    expect(splitAcpArgs("   ")).toEqual([]);
    expect(joinAcpArgs(["a", "b"])).toBe("a b");
  });

  it("parses env lines and reports invalid ones", () => {
    const parsed = parseAcpEnvLines("TOKEN=abc\n# comment\nBAD LINE\n1BAD=x\nEMPTY=");
    expect(parsed.env).toEqual({ TOKEN: "abc", EMPTY: "" });
    expect(parsed.invalidLines).toEqual(["BAD LINE", "1BAD=x"]);
    expect(formatAcpEnvLines({ A: "1", B: "2" })).toBe("A=1\nB=2");
  });

  it("builds the access config with fallbacks and omits empty env", () => {
    expect(buildAcpAgentAccess(AGENT, { command: "  ", args: ["acp"], env: {} })).toEqual({
      type: "acp-agent",
      agentId: "opencode",
      command: AGENT.commandPath,
      args: ["acp"],
    });
    expect(
      buildAcpAgentAccess(AGENT, {
        command: "/opt/opencode",
        args: ["acp"],
        env: { TOKEN: "1" },
      }),
    ).toEqual({
      type: "acp-agent",
      agentId: "opencode",
      command: "/opt/opencode",
      args: ["acp"],
      env: { TOKEN: "1" },
    });
  });

  it("builds a complete pseudo-model config with per-agent context windows", () => {
    const opencode = buildAcpPseudoModelConfig("opencode");
    const cursor = buildAcpPseudoModelConfig("cursor");
    expect((opencode.properties as { contextWindow: number }).contextWindow).toBe(262144);
    expect((cursor.properties as { contextWindow: number }).contextWindow).toBe(200000);
    expect(opencode.optionSpecs).toMatchObject({
      reasoningLevel: { values: ["auto"], default: "auto", map: "{}" },
      maxOutputTokens: { max: 32000, map: "{}" },
    });
    expect((opencode.properties as { supportsToolCall: boolean }).supportsToolCall).toBe(true);
  });
});
