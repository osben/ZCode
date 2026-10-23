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

  it("has marks for Codex, Claude Code, Qwen and Gemini", () => {
    expect(resolveAcpAgentLogoAsset("codex", "light")).not.toBeNull();
    for (const id of ["claude", "qwen", "gemini"]) {
      expect(resolveAcpAgentLogoAsset(id, "light")).not.toBeNull();
      expect(resolveAcpAgentLogoAsset(id, "dark")).not.toBe(resolveAcpAgentLogoAsset(id, "light"));
    }
  });

  it("keeps the letter fallback for unknown agents", () => {
    expect(resolveAcpAgentLogoAsset("unknown-agent", "light")).toBeNull();
  });

  it("renders an image for a branded agent and the initial for the rest", () => {
    const branded = renderToStaticMarkup(
      createElement(AcpAgentMark, { agentId: "cursor", name: "Cursor" }),
    );
    expect(branded).toContain("<img");
    const plain = renderToStaticMarkup(
      createElement(AcpAgentMark, { agentId: "unknown-agent", name: "Unknown Agent" }),
    );
    expect(plain).not.toContain("<img");
    expect(plain).toContain(">U<");
  });
});
