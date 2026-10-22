// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AcpAgentMark } from "@/settings/model-provider-section/AcpAgentMark.js";
import { resolveAcpAgentLogoAsset } from "@/settings/model-provider-section/acpAgentLogo.js";

// specs/acp-agent-runtime.md "Settings UI placement": brand marks for the agents that have one; the
// letter mark stays the fallback for the rest.
describe("ACP agent logos", () => {
  it("maps opencode and Cursor to light and dark marks", () => {
    expect(resolveAcpAgentLogoAsset("opencode", "light")).not.toBeNull();
    expect(resolveAcpAgentLogoAsset("opencode", "dark")).not.toBe(
      resolveAcpAgentLogoAsset("opencode", "light"),
    );
    expect(resolveAcpAgentLogoAsset("cursor", "dark")).not.toBe(
      resolveAcpAgentLogoAsset("cursor", "light"),
    );
  });

  it("reuses the OpenAI mark for Codex and the Anthropic mark for Claude Code", () => {
    expect(resolveAcpAgentLogoAsset("codex", "light")).not.toBeNull();
    expect(resolveAcpAgentLogoAsset("claude", "dark")).not.toBeNull();
  });

  it("keeps the letter fallback for agents without a mark", () => {
    expect(resolveAcpAgentLogoAsset("qwen", "light")).toBeNull();
    expect(resolveAcpAgentLogoAsset("gemini", "dark")).toBeNull();
    expect(resolveAcpAgentLogoAsset("unknown-agent", "light")).toBeNull();
  });

  it("renders an image for a branded agent and the initial for the rest", () => {
    const branded = renderToStaticMarkup(
      createElement(AcpAgentMark, { agentId: "cursor", name: "Cursor" }),
    );
    expect(branded).toContain("<img");
    const plain = renderToStaticMarkup(
      createElement(AcpAgentMark, { agentId: "qwen", name: "Qwen Code" }),
    );
    expect(plain).not.toContain("<img");
    expect(plain).toContain(">Q<");
  });
});
