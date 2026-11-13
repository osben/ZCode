// Settings → Sessions → "Sessions from other tools" (specs/external-sessions.md "Acceptance scenarios" 8).
// Fixture: one Claude Code session and one Codex rollout written into the isolated E2E home, so the
// desktop Host's scanner (os.homedir() = that home) lists them. Outside the conversation-session harness,
// like the other Settings specs; no provider request.
// Not covered here: Resume (macOS Terminal only; this runs in a Linux container), Import (upstream task
// import), and Continue (composer draft). Those need their own scenarios.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
} from "./helpers/desktop-app.js";
import { isIsolatedE2EHomeDir } from "./helpers/e2e-runtime-paths.js";
import { sel } from "./helpers/selectors.js";
import { prepareV4ConversationE2E } from "./helpers/v4-conversation.js";

const SECTION_NAV_ID = testId(TID_SETTINGS_SECTION_NAV, "sessions");
const PANEL = '[data-testid="external-sessions-panel"]';
const CLAUDE_TITLE = "Explain the sessions panel";
const CLAUDE_ANSWER = "It lists sessions from other tools";
const CODEX_QUESTION = "Codex fixture question";
const CODEX_ANSWER = "Codex fixture answer";
const CLAUDE_SESSION_ID = "claude-e2e-session-1";
const CODEX_SESSION_ID = "codex-e2e-session-1";

describe("Settings sessions from other tools", () => {
  before(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    await writeFixtureSessions();
    await openSessionsSettings();
  });
  after(async () => {
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15000 }).catch(() => undefined);
    await clearAppData();
  });

  it("lists the Claude Code and Codex sessions in the panel with their source marks", async () => {
    await browser.waitUntil(
      async () => {
        const rows = await readRows();
        return (
          rows.some((row) => row.title === CLAUDE_TITLE && row.source === "Claude Code") &&
          rows.some((row) => row.source === "Codex")
        );
      },
      { timeout: 20000, timeoutMsg: "external sessions fixtures are not listed in the panel" },
    );
  });

  it("hides one tool's rows when its source chip is toggled off, and restores them on a second click", async () => {
    await clickSourceChip("Codex");
    await browser.waitUntil(async () => (await readRows()).every((row) => row.source !== "Codex"), {
      timeout: 10000,
      timeoutMsg: "Codex rows are still shown after the Codex chip was toggled off",
    });
    expect((await readRows()).some((row) => row.title === CLAUDE_TITLE)).toBe(true);

    await clickSourceChip("Codex");
    await browser.waitUntil(async () => (await readRows()).some((row) => row.source === "Codex"), {
      timeout: 10000,
      timeoutMsg: "Codex rows did not return after the chip was toggled on",
    });
  });

  it("opens a read-only transcript dialog with the user and assistant text", async () => {
    await clickRowTitle(CLAUDE_TITLE);
    await browser.waitUntil(
      async () => {
        const text = await dialogText();
        return text.includes(CLAUDE_TITLE) && text.includes(CLAUDE_ANSWER);
      },
      { timeout: 15000, timeoutMsg: "transcript dialog did not show the Claude session messages" },
    );
    await browser.keys("Escape");
    await browser.waitUntil(async () => (await dialogText()) === "", {
      timeout: 10000,
      timeoutMsg: "transcript dialog did not close",
    });
  });

  it("shows the Codex transcript text as well", async () => {
    await clickRowTitle(readableCodexTitle());
    await browser.waitUntil(
      async () => {
        const text = await dialogText();
        return text.includes(CODEX_QUESTION) && text.includes(CODEX_ANSWER);
      },
      { timeout: 15000, timeoutMsg: "transcript dialog did not show the Codex session messages" },
    );
    await browser.keys("Escape");
  });
});

/** Writes the two fixtures under the isolated home. Refuses to write anywhere that is not an isolated E2E home. */
async function writeFixtureSessions() {
  const { homeDir } = getE2EAppDataPaths();
  if (!isIsolatedE2EHomeDir(homeDir)) {
    throw new Error(
      `refusing to write external session fixtures outside an isolated E2E home: ${homeDir}`,
    );
  }
  const timestamp = "2026-11-12T10:00:00.000Z";
  const claudeDir = join(homeDir, ".claude", "projects", "-e2e-external-sessions");
  await mkdir(claudeDir, { recursive: true });
  await writeFile(
    join(claudeDir, `${CLAUDE_SESSION_ID}.jsonl`),
    [
      {
        type: "user",
        sessionId: CLAUDE_SESSION_ID,
        cwd: DEFAULT_WORKSPACE,
        gitBranch: "main",
        timestamp,
        isSidechain: false,
        uuid: "claude-e2e-u",
        message: { role: "user", content: CLAUDE_TITLE },
      },
      {
        type: "assistant",
        sessionId: CLAUDE_SESSION_ID,
        cwd: DEFAULT_WORKSPACE,
        gitBranch: "main",
        timestamp,
        isSidechain: false,
        uuid: "claude-e2e-a",
        message: {
          role: "assistant",
          model: "claude-opus-5-5",
          content: [{ type: "text", text: CLAUDE_ANSWER }],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n",
    "utf-8",
  );

  const codexDir = join(homeDir, ".codex", "sessions", "2026", "11", "12");
  await mkdir(codexDir, { recursive: true });
  const codexRecords = [
    {
      timestamp,
      type: "session_meta",
      payload: { id: CODEX_SESSION_ID, cwd: DEFAULT_WORKSPACE, timestamp },
    },
    {
      timestamp,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: CODEX_QUESTION }],
      },
    },
    {
      timestamp,
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: CODEX_ANSWER }],
      },
    },
  ];
  await writeFile(
    join(codexDir, `rollout-2026-11-12T10-00-00-${CODEX_SESSION_ID}.jsonl`),
    codexRecords.map((record) => JSON.stringify(record)).join("\n") + "\n",
    "utf-8",
  );
}

async function openSessionsSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15000,
    timeoutMsg: "no settings entry button",
  });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });
  await clickTestIdByDom(SECTION_NAV_ID, {
    timeout: 15000,
    timeoutMsg: "Settings has no Sessions section entry",
  });
  await $(sel("external-sessions-panel")).waitForDisplayed({ timeout: 15000 });
}

/** Rows as the panel renders them: source mark text and the title (the title button carries it as `title`). */
async function readRows(): Promise<Array<{ source: string; title: string }>> {
  return browser.execute((panelSelector: string) => {
    const panel = document.querySelector(panelSelector);
    return Array.from(
      panel?.querySelectorAll<HTMLElement>('[data-testid="external-session-row"]') ?? [],
    ).map((row) => ({
      source: row.querySelector("span")?.textContent?.trim() ?? "",
      title: row.querySelector("button[title]")?.getAttribute("title") ?? "",
    }));
  }, PANEL);
}

async function clickSourceChip(label: string) {
  await browser.execute(
    (panelSelector: string, chipLabel: string) => {
      const panel = document.querySelector(panelSelector);
      const chip = Array.from(
        panel?.querySelectorAll<HTMLButtonElement>("button[aria-pressed]") ?? [],
      ).find(
        // The chip is its label text node followed by a count span, so compare the label node only.
        (button) =>
          Array.from(button.childNodes)
            .find((node) => node.nodeType === Node.TEXT_NODE)
            ?.textContent?.trim() === chipLabel,
      );
      if (!chip) throw new Error(`no source chip labelled ${chipLabel}`);
      chip.click();
    },
    PANEL,
    label,
  );
}

async function clickRowTitle(title: string) {
  await browser.execute(
    (panelSelector: string, rowTitle: string) => {
      const panel = document.querySelector(panelSelector);
      const button = Array.from(
        panel?.querySelectorAll<HTMLButtonElement>("button[title]") ?? [],
      ).find((candidate) => candidate.getAttribute("title") === rowTitle);
      if (!button) throw new Error(`no row titled ${rowTitle}`);
      button.click();
    },
    PANEL,
    title,
  );
}

/** The Codex rollout head carries no title, so the listed title is the adapter's fallback: label · id prefix. */
function readableCodexTitle(): string {
  return `Codex · ${CODEX_SESSION_ID.slice(0, 8)}`;
}

async function dialogText(): Promise<string> {
  return browser.execute(() => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    return dialog?.innerText ?? "";
  });
}
