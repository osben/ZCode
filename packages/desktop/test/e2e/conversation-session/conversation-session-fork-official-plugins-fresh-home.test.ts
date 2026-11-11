// Fork case (specs/fork-agent-runtime-selection.md, acceptance scenario 12): on a fresh E2E home the
// official plugin store is laid out before the agent starts, and the first model request lists the
// bundled `visualize` skill. Under ZCODE_E2E_AGENT_RUNTIME=rust no Node agent runs, so the store
// comes from the Node storage-preparation Worker; under Node the agent seeds it itself.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { clearAppData, getE2EAppDataPaths } from "../helpers/desktop-app.js";
import { waitForUpstreamNetworkCapture } from "../helpers/upstream-capture.js";
import {
  E2E_REPLY_TOKEN,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";

const MARKER = "E2E_FORK_OFFICIAL_PLUGINS";
const SKILLS_HEADER = "The following skills are available for use with the Skill tool:";

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) collectStrings(item, out);
  return out;
}

/** Skill names from the request's skill listing (`- <name>: <description> ...`). */
function listedSkillNames(requestJson: unknown): string[] {
  const listing = collectStrings(requestJson).find((text) => text.includes(SKILLS_HEADER));
  if (!listing) return [];
  return listing
    .slice(listing.indexOf(SKILLS_HEADER) + SKILLS_HEADER.length)
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) =>
      line
        .slice(2)
        .split(/: | \(/u)[0]!
        .trim(),
    );
}

describe("Fork official plugins on a fresh home", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("seeds the plugin store and lists the visualize skill in the first request", async function () {
    this.timeout(150_000);
    const pluginStore = join(getE2EAppDataPaths().storageRoot, "cli", "plugins");

    await prepareV4ConversationE2E();
    const prompt = `${MARKER}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(prompt);
    const record = await waitForUpstreamNetworkCapture(MARKER);
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);

    const skills = listedSkillNames(record.requestJson);
    console.log(
      `[${MARKER}] runtime=${process.env.ZCODE_E2E_AGENT_RUNTIME ?? "node"} skills=${JSON.stringify(skills)}`,
    );
    expect(
      existsSync(
        join(pluginStore, "marketplaces", "zcode-plugins-official", "bundled-marketplace.json"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          pluginStore,
          "cache",
          "zcode-plugins-official",
          "visualize",
          "0.1.1",
          "skills",
          "visualize",
          "SKILL.md",
        ),
      ),
    ).toBe(true);
    expect(skills).toContain("skill-creator:skill-creator");
    expect(skills).toContain("visualize:visualize");
  });
});
