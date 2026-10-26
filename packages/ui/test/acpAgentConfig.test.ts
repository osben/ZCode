import { describe, expect, it } from "vitest";
import type { AcpAgentSummary } from "@zcode/services";
import {
  acpProviderId,
  buildAcpAgentSaveInput,
  formatAcpEnvLines,
  groupAcpModelValues,
  isAcpProviderId,
  joinAcpArgs,
  parseAcpEnvLines,
  splitAcpArgs,
  toggleAcpHiddenModel,
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

  it("round-trips arguments through join and split", () => {
    const cases = [
      ["--config"],
      ["--config", "/tmp/Agent Config"],
      ["--name=John Doe"],
      ['say "hi"'],
      ["back\\slash", "with space"],
      [""],
      ["", "trailing"],
    ];
    for (const args of cases) {
      expect(splitAcpArgs(joinAcpArgs(args))).toEqual(args);
    }
  });

  it("keeps quoted whitespace inside one argument", () => {
    expect(splitAcpArgs('a "b c"')).toEqual(["a", "b c"]);
    expect(splitAcpArgs("--name='John Doe'")).toEqual(["--name=John Doe"]);
    expect(splitAcpArgs('one "two three" four')).toEqual(["one", "two three", "four"]);
    expect(splitAcpArgs("a\\ b")).toEqual(["a b"]);
    expect(splitAcpArgs('""')).toEqual([""]);
  });

  it("parses env lines and reports invalid ones", () => {
    const parsed = parseAcpEnvLines("TOKEN=abc\n# comment\nBAD LINE\n1BAD=x\nEMPTY=");
    expect(parsed.env).toEqual({ TOKEN: "abc", EMPTY: "" });
    expect(parsed.invalidLines).toEqual(["BAD LINE", "1BAD=x"]);
    expect(formatAcpEnvLines({ A: "1", B: "2" })).toBe("A=1\nB=2");
  });

  it("preserves surrounding whitespace in env values", () => {
    // An unchanged form must not rewrite a saved value.
    expect(parseAcpEnvLines("TOKEN= abc ").env).toEqual({ TOKEN: " abc " });
    expect(parseAcpEnvLines("  KEY = value  ").env).toEqual({ KEY: " value  " });
  });

  it("builds the sidecar save request with fallbacks and always includes env", () => {
    expect(
      buildAcpAgentSaveInput(AGENT, { command: "  ", args: ["acp"], env: {} }, { enabled: true }),
    ).toEqual({
      agentId: "opencode",
      providerName: "opencode (ACP)",
      command: AGENT.commandPath,
      args: ["acp"],
      env: {},
      enabled: true,
    });
    expect(
      buildAcpAgentSaveInput(
        AGENT,
        { command: "/opt/opencode", args: ["acp"], env: { TOKEN: "1" } },
        { enabled: false, providerName: "Mine" },
      ),
    ).toEqual({
      agentId: "opencode",
      providerName: "Mine",
      command: "/opt/opencode",
      args: ["acp"],
      env: { TOKEN: "1" },
      enabled: false,
    });
  });
});

// specs/acp-agent-runtime.md "Settings: models and Advanced".
describe("ACP agent model visibility helpers", () => {
  it("groups values by group in the agent's order", () => {
    const values = [
      { value: "a", group: "Free" },
      { value: "b", group: null },
      { value: "c", group: "Free" },
    ];
    expect(groupAcpModelValues(values)).toEqual([
      { group: "Free", values: [values[0], values[2]] },
      { group: null, values: [values[1]] },
    ]);
  });

  it("hides and shows a value, keeping values the agent no longer offers", () => {
    expect(toggleAcpHiddenModel(["gone"], ["a", "b"], "b", false)).toEqual(["b", "gone"]);
    expect(toggleAcpHiddenModel(["b", "gone"], ["a", "b"], "b", true)).toEqual(["gone"]);
  });

  it("never hides the last visible value", () => {
    expect(toggleAcpHiddenModel(["b"], ["a", "b"], "a", false)).toEqual(["b"]);
  });
});
