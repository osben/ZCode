import { describe, expect, it } from "vitest";
import {
  composeMemoryGuidanceDefault,
  DEFAULT_CLI_PREFIX_PROMPT,
  DEFAULT_COMMUNICATION_PROMPT,
  DEFAULT_CONTEXT_MANAGEMENT_PROMPT,
  DEFAULT_HARNESS_PROMPT,
  DEFAULT_IDENTITY_INTRO_PROMPT,
  renderMemoryGuidancePrompt,
  SYSTEM_PROMPT_DEFAULTS,
} from "@zcode/shared";
import { buildCliPrefixSection } from "../src/context/sections/cli-prefix.js";
import { buildIdentitySection } from "../src/context/sections/identity.js";
import {
  buildContextManagementSection,
  buildDynamicBehaviorSection,
} from "../src/context/dynamic-sections.js";
import { buildMemorySection } from "../src/context/sections/memory.js";

/**
 * Pins the shared constants against the builders' rendered defaults: the shared texts are
 * the single source shown in the settings UI, and any drift here means the UI would lie
 * about what is effective. Also covers override replacement behavior.
 */
describe("system prompt section defaults and overrides", () => {
  it("renders the shared constants byte-identically by default", () => {
    expect(buildCliPrefixSection().content).toBe(DEFAULT_CLI_PREFIX_PROMPT);
    expect(buildDynamicBehaviorSection().content).toBe(DEFAULT_COMMUNICATION_PROMPT);
    expect(buildContextManagementSection().content).toBe(DEFAULT_CONTEXT_MANAGEMENT_PROMPT);
    const identity = buildIdentitySection();
    expect(identity.content).toContain(DEFAULT_IDENTITY_INTRO_PROMPT);
    expect(identity.content).toContain(DEFAULT_HARNESS_PROMPT);
    expect(SYSTEM_PROMPT_DEFAULTS["cli-prefix"]).toBe(DEFAULT_CLI_PREFIX_PROMPT);
  });

  it("replaces the cli prefix and dynamic sections with overrides", () => {
    expect(buildCliPrefixSection("You are MY agent.").content).toBe("You are MY agent.");
    expect(buildDynamicBehaviorSection("Speak plainly.").content).toBe("Speak plainly.");
    expect(buildContextManagementSection("Never summarize.").content).toBe("Never summarize.");
    // Section identity and placement stay intact; only the body changes.
    expect(buildDynamicBehaviorSection("Speak plainly.").source).toBe("dynamic_behavior");
    expect(buildDynamicBehaviorSection("Speak plainly.").cacheHint).toBe("dynamic");
  });

  it("overrides the identity intro and harness while keeping the security notice", () => {
    const content = buildIdentitySection(undefined, {
      "identity-intro": "I am Fork.",
      harness: "# Harness\n- Custom.",
    }).content;
    expect(content).toContain("I am Fork.");
    expect(content).toContain("# Harness\n- Custom.");
    expect(content).not.toContain(DEFAULT_IDENTITY_INTRO_PROMPT);
    expect(content).not.toContain(DEFAULT_HARNESS_PROMPT);
    // The security notice is a fixed product constant and survives overrides.
    expect(content).toContain("IMPORTANT: Assist with authorized security testing");
  });

  it("substitutes {{memoryRoot}} in a memory-guidance override", () => {
    const section = buildMemorySection(
      "/mem/root",
      "default-index",
      "Memory at {{memoryRoot}} and {{memoryRoot}}.",
    );
    expect(section?.content).toBe("Memory at /mem/root and /mem/root.");
  });

  it("keeps the default memory assembly equal to the substituted shared constant", () => {
    // semantic-recall branch renders exactly the shared constant with the root substituted…
    const plain = buildMemorySection("/mem/root", "semantic-recall");
    expect(plain?.content).toBe(
      renderMemoryGuidancePrompt(SYSTEM_PROMPT_DEFAULTS["memory-guidance"], "/mem/root"),
    );
    // …while default-index adds the MEMORY.md pointer line on top of the same base.
    const indexed = buildMemorySection("/mem/root", "default-index");
    expect(indexed?.content).toContain("add a one-line pointer in `MEMORY.md`");
    expect(indexed?.content).toContain("You have a persistent file-based memory at `/mem/root/`.");
  });

  it("renders the active-branch memory default byte-identically from the shared composer", () => {
    // The service reports composeMemoryGuidanceDefault("default-index") as the memory-guidance
    // default; this pins the runtime's rendered default to that exact value so the Settings
    // default/diff preview cannot drift from the restored prompt.
    const indexed = buildMemorySection("/mem/root", "default-index");
    expect(indexed?.content).toBe(
      renderMemoryGuidancePrompt(composeMemoryGuidanceDefault("default-index"), "/mem/root"),
    );
  });
});
