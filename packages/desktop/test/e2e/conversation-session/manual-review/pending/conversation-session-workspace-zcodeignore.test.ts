import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "../../../helpers/desktop-app.js";
import { skipOccupationOnboardingIfPresent } from "../../../helpers/occupation-onboarding.js";
import {
  prepareConversationE2E,
  startNewTask,
  typeChatPrompt,
} from "../../../helpers/conversation-session.js";

// gitignore parsing is line-based; line-ending style doesn't affect rules; write \n uniformly to avoid multi-line
// literals in the e2e source.
const LINE_SEP = "\n";

// E2E case for .zcodeignore as the single source of truth (spec 2026-08-07, amended 2026-09-15,
// ZCT-2096811705629528064).
// Verifies the full interaction chain on a real Electron Desktop:
//   1. When the workspace has a .gitignore (containing obj/), the @ scan loads rules in memory only and does not
//      create a .zcodeignore;
//      the obj/ tree is pruned whole and files under obj are not searchable;
//   2. Manually creating a .zcodeignore to relax the exclusion rules (the settings entry is currently hidden;
//      file editing is the real user path),
//      then closing and reopening the @ panel to rescan, makes files under obj searchable again.
// The filtering authority is services-layer fileService.listWorkspaceFiles; this spec only collects evidence on
// the user-visible matrix.
const TEST_TIMEOUT_MS = 180000;
const TID_PROMPT_SUGGESTION_PANEL = "prompt-suggestion-panel";
const TID_PROMPT_SUGGESTION_OPTION = "prompt-suggestion-option";
const TID_PROMPT_SUGGESTION_STATUS = "prompt-suggestion-status";

interface PanelOptionSnapshot {
  id: string | null;
  index: number;
  sectionId: string | null;
  selected: boolean;
  text: string;
}

interface PanelSnapshot {
  options: PanelOptionSnapshot[];
  statuses: Array<{ sectionId: string | null; status: string | null; text: string }>;
  trigger: string | null;
}

// Pending cleanup state produced by the seed: new directories + a manually created .zcodeignore + restoring the
// original .gitignore content.
let seededDirs: string[] = [];
let createdZcodeIgnore = false;
let originalGitignore: string | null = null;

describe("会话区 .zcodeignore 工作区搜索忽略规则 E2E", () => {
  before(async function () {
    this.timeout(TEST_TIMEOUT_MS);
    // A new isolated profile first shows the occupation onboarding; the file search scenario is only reachable
    // after it completes.
    await skipOccupationOnboardingIfPresent();
    await prepareConversationE2E();
  });

  beforeEach(async function () {
    this.timeout(TEST_TIMEOUT_MS);
    await startNewTask();
  });

  after(async () => {
    await Promise.all(seededDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    seededDirs = [];
    if (createdZcodeIgnore) {
      await rm(join(DEFAULT_WORKSPACE, ".zcodeignore"), { force: true });
      createdZcodeIgnore = false;
    }
    const gitignorePath = join(DEFAULT_WORKSPACE, ".gitignore");
    if (originalGitignore === null) {
      await rm(gitignorePath, { force: true });
    } else {
      await writeFile(gitignorePath, originalGitignore, "utf-8");
    }
    originalGitignore = null;
    await browser.electron.restoreAllMocks();
  });

  it("@ 按内存规则剪枝且不创建 .zcodeignore；手动规则文件仍生效", async function () {
    this.timeout(TEST_TIMEOUT_MS);

    const runId = Date.now();
    const marker = `zci-e2e-${runId}`;
    const objFileRelPath = join("obj", "Debug", `${marker}.cs`);
    const srcFileRelPath = join("src", `${marker}.ts`);

    // Seed: merge-write .gitignore (preserving the original content, restored in after), and place one marker
    // file each under obj and src.
    const gitignorePath = join(DEFAULT_WORKSPACE, ".gitignore");
    originalGitignore = await readFile(gitignorePath, "utf-8").catch(() => null);
    const baseGitignore = originalGitignore ?? "";
    if (!/^obj\/$/m.test(baseGitignore)) {
      await writeFile(
        gitignorePath,
        `${baseGitignore}${baseGitignore.endsWith("\n") || !baseGitignore ? "" : "\n"}obj/\n`,
        "utf-8",
      );
    }
    const objDir = join(DEFAULT_WORKSPACE, "obj");
    const srcDir = join(DEFAULT_WORKSPACE, "src");
    await mkdir(join(objDir, "Debug"), { recursive: true });
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(DEFAULT_WORKSPACE, objFileRelPath), `// ${marker}\n`, "utf-8");
    await writeFile(join(DEFAULT_WORKSPACE, srcFileRelPath), `// ${marker}\n`, "utf-8");
    seededDirs.push(objDir, srcDir);

    // 1) Default pruning: the src marker is searchable (proving the panel and index work), obj/Debug is not
    // (the in-memory rule is in effect).
    await typeChatPrompt(`@${marker}`);
    const visiblePanel = await waitForPanelSections("@", ["files"], "@ 文件候选面板没有打开");
    expect(visiblePanel.options.map((o) => o.text).join("\n")).toContain(`${marker}.ts`);
    await typeChatPrompt(`@${marker}.cs`);
    await waitForPanelNoOptionContaining("obj/Debug", "obj/ 下被忽略文件不应进入候选");

    // While the management entry is hidden, search must not automatically create the config file in the
    // workspace.
    const zcodeIgnorePath = join(DEFAULT_WORKSPACE, ".zcodeignore");
    await expect(stat(zcodeIgnorePath)).rejects.toMatchObject({ code: "ENOENT" });

    // 2) Manually create the rules file to relax obj/: the settings entry is currently hidden
    // (HIDDEN_SETTINGS_SECTIONS),
    // and the real user path is editing .zcodeignore directly; writing empty rules is equivalent to "deleting
    // all exclusion rules".
    // Use an array join to write literal "\n"-terminated content, avoiding a multi-line string literal.
    await writeFile(zcodeIgnorePath, ["# emptied by e2e", ""].join(LINE_SEP), "utf-8");
    createdZcodeIgnore = true;

    // 3) The relaxed rules take effect: first type plain text to close the @ panel (the local 30s TTL cache
    // has been removed —
    // closing the panel cleans up and reopening always rescans; spec updated 2026-08-26 / 2026-09-15), then
    // deliberately reuse
    // the exact same query as step two to verify the new rule: if the caching semantics regressed (miss-refresh
    // dedupe would block
    // a rescan of the same query), this assertion fails, providing regression protection.
    // The close step cannot be omitted: step two's @ query text is still in the input box, and the panel's
    // enabled never became false — without a "close → reopen" cycle the index is not re-read.
    // On the panel's second opening within the same session the plugins/skills sections are already cached, so
    // only assert that the files section contains the target.
    await typeChatPrompt("refresh-panel");
    await typeChatPrompt(`@${marker}.cs`);
    await waitForPanelFilesOptionContaining(
      `${marker}.cs`,
      "删除规则后 obj/Debug 下文件未恢复可搜",
    );
  });
});

// Same positive assertion as the filter spec: the panel trigger matched, the files section appeared, and the
// candidates are non-empty.
async function waitForPanelSections(
  trigger: string,
  expectedSectionIds: string[],
  timeoutMsg: string,
) {
  let latest: PanelSnapshot | null = null;
  await browser.waitUntil(
    async () => {
      latest = await getPanelSnapshot();
      return (
        latest.trigger === trigger &&
        latest.options.length > 0 &&
        arraysEqual(optionSectionIds(latest), expectedSectionIds)
      );
    },
    { timeout: 15000, timeoutMsg },
  );
  return latest ?? getPanelSnapshot();
}

function optionSectionIds(snapshot: PanelSnapshot): string[] {
  return Array.from(new Set(snapshot.options.map((option) => option.sectionId ?? "?")));
}

// Wait for the files section to show a candidate containing needle; other sections may or may not be visible.
async function waitForPanelFilesOptionContaining(needle: string, timeoutMsg: string) {
  await browser.waitUntil(
    async () => {
      const snapshot = await getPanelSnapshot();
      if (snapshot.trigger !== "@") {
        return false;
      }
      return snapshot.options
        .filter((option) => option.sectionId === "files")
        .some((option) => option.text.includes(needle));
    },
    { timeout: 15000, timeoutMsg },
  );
}

function arraysEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

// Same exclusion assertion as the filter spec: after two consecutive panel snapshots agree, the files candidates
// must not contain needle.
async function waitForPanelNoOptionContaining(needle: string, timeoutMsg: string) {
  let previous: PanelSnapshot | null = null;
  let stable: PanelSnapshot | null = null;
  await browser.waitUntil(
    async () => {
      const snapshot = await getPanelSnapshot();
      const signature = panelSignature(snapshot);
      const previousSignature = previous ? panelSignature(previous) : null;
      previous = snapshot;
      if (previousSignature !== null && previousSignature === signature) {
        stable = snapshot;
        return true;
      }
      return false;
    },
    { timeout: 15000, timeoutMsg: `${timeoutMsg}（候选面板持续抖动，无法判定稳定终态）` },
  );
  const finalSnapshot = stable ?? previous ?? (await getPanelSnapshot());
  const finalTexts = finalSnapshot.options
    .filter((option) => option.sectionId === "files")
    .map((option) => option.text);
  if (finalTexts.some((text) => text.includes(needle))) {
    throw new Error(
      `${timeoutMsg}（needle="${needle}"，实际 files 候选：${JSON.stringify(finalTexts)}）`,
    );
  }
}

function panelSignature(snapshot: PanelSnapshot): string {
  const filesStatuses = snapshot.statuses
    .filter((entry) => entry.sectionId === "files")
    .map((entry) => `${entry.status ?? "?"}:${entry.text}`)
    .join("|");
  const filesOptions = snapshot.options
    .filter((option) => option.sectionId === "files")
    .map((option) => option.text)
    .join("|");
  return `trigger=${snapshot.trigger ?? "?"};filesStatus=${filesStatuses};filesOptions=${filesOptions}`;
}

function getPanelSnapshot(): Promise<PanelSnapshot> {
  return browser.execute(
    (panelTestId, optionPrefix, statusPrefix) => {
      const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
      const options = Array.from(
        panel?.querySelectorAll<HTMLElement>(`[data-testid^="${optionPrefix}-"]`) ?? [],
      ).map((element) => ({
        id: element.getAttribute("data-option-id"),
        index: Number(element.getAttribute("data-option-index") ?? "0"),
        sectionId: element.getAttribute("data-section-id"),
        selected: element.getAttribute("data-selected") === "true",
        text: (element.innerText || element.textContent || "").replace(/\u00a0/g, " ").trim(),
      }));
      const statuses = Array.from(
        panel?.querySelectorAll<HTMLElement>(`[data-testid^="${statusPrefix}-"]`) ?? [],
      ).map((element) => ({
        sectionId: element.getAttribute("data-section-id"),
        status: element.getAttribute("data-status"),
        text: (element.innerText || element.textContent || "").replace(/\u00a0/g, " ").trim(),
      }));
      return {
        options,
        statuses,
        trigger: panel?.getAttribute("data-trigger") ?? null,
      };
    },
    TID_PROMPT_SUGGESTION_PANEL,
    TID_PROMPT_SUGGESTION_OPTION,
    TID_PROMPT_SUGGESTION_STATUS,
  );
}
