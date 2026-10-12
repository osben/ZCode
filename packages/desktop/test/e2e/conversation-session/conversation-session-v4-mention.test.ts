// S01 / S05 / S08 gate: composer aggregated entry points, legacy triggers, and the Session Skill catalog lifecycle.
// Evidence layer L3:
// 1) A first-round fixed reply establishes a session (written into sessions-index);
// 2) Creating a new draft → both `@` and `#` discover candidates from the same sessions-index;
// 3) Selecting from either entry writes the original `#session-id` canonical mention;
// 4) `$` / `¥` / `￥` still open the Skills panel and write the original Skill mention;
// 5) The `+` menu shows @ / / / $ hints at the bottom; typing $ manually opens skill candidates;
// 6) After Session initialization, manually adding a SKILL.md leaves the old Session's catalog frozen while a new task rediscovers it.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  clearAppData,
  getE2EAppDataPaths,
  setInputValueByTestIdDom,
} from "../helpers/desktop-app.js";
import { TID_CHAT_ATTACHMENT_BUTTON, TID_V4_COMPOSER_INPUT } from "@zcode/shared";
import {
  clickV4SlashOption,
  getV4ComposerText,
  getV4SlashOptionIds,
  hasV4SlashPanel,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4MentionOptionPrefix,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

const SESSION_SKILL_NAME = "e2e-session-skill-catalog";
const SESSION_SKILL_DIRECTORY = join(
  getE2EAppDataPaths().workspace,
  ".zcode",
  "skills",
  SESSION_SKILL_NAME,
);
const SESSION_SKILL_PATH = join(SESSION_SKILL_DIRECTORY, "SKILL.md");

function isSessionSkillOption(optionId: string) {
  return optionId.startsWith("skill:") && optionId.includes(SESSION_SKILL_NAME);
}

async function waitForSessionSkillAbsent(trigger: "/" | "$") {
  let snapshot: { hasTarget: boolean; status: string | null } | undefined;
  let stableEmptyPolls = 0;
  await browser.waitUntil(
    async () => {
      if (!(await hasV4SlashPanel())) {
        stableEmptyPolls = 0;
        return false;
      }
      snapshot = await browser.execute((skillName) => {
        const optionIds = Array.from(
          document.querySelectorAll<HTMLElement>("[data-option-id]"),
        ).map((element) => element.dataset.optionId ?? "");
        const status = document
          .querySelector<HTMLElement>('[data-section-id="skills"][data-status]')
          ?.getAttribute("data-status");
        return {
          hasTarget: optionIds.some(
            (optionId) => optionId.startsWith("skill:") && optionId.includes(skillName),
          ),
          status: status ?? null,
        };
      }, SESSION_SKILL_NAME);
      if (snapshot.hasTarget || snapshot.status === "empty" || snapshot.status === "error") {
        return true;
      }
      if (snapshot.status === "loading") {
        stableEmptyPolls = 0;
        return false;
      }
      // The `$` single-group panel omits the Skills row entirely when filtered results are empty, so there is no explicit empty state.
      // Observe the panel being present, not loading, and without the target candidate several polls in a row,
      // to avoid mistaking an incomplete first frame for the final empty result.
      stableEmptyPolls += 1;
      return stableEmptyPolls >= 3;
    },
    {
      timeout: 15000,
      timeoutMsg: `${trigger} 没有完成旧 Session Skill catalog 查询`,
    },
  );
  expect(snapshot?.status).not.toBe("error");
  expect(snapshot?.hasTarget).toBe(false);
}

async function waitForSessionSkillPresent(trigger: "/" | "$") {
  let optionId: string | undefined;
  await browser.waitUntil(
    async () => {
      optionId = (await getV4SlashOptionIds()).find(isSessionSkillOption);
      return Boolean(optionId);
    },
    {
      timeout: 15000,
      timeoutMsg: `${trigger} 没有展示新任务重新发现的 Skill: ${SESSION_SKILL_NAME}`,
    },
  );
  return optionId as string;
}

describe("S01 / S05 / S08：composer 候选入口与 Session Skill catalog", () => {
  before(async () => {
    await rm(SESSION_SKILL_DIRECTORY, { recursive: true, force: true });
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await rm(SESSION_SKILL_DIRECTORY, { recursive: true, force: true });
    await clearAppData();
  });

  it("@ 与 # 共用 sessions-index，+ 菜单突出 @、/ 和 $", async () => {
    await prepareV4ConversationE2E();

    // 1) Establish a session (for both @ / # catalogs to hit)
    await sendV4Prompt("E2E_V4_MENTION_SEED 建立可被 mention 的会话");
    await waitForV4TimelineContaining("V4_MENTION_SEED_OK", 45000);
    const seedPane = await waitForV4Pane(
      (s) => !s.canStop && s.sessionId !== "draft" && s.sessionId !== null,
      "首轮没有回到空闲态且绑定 session",
      45000,
    );
    const seedSessionId = seedPane.sessionId;
    if (!seedSessionId || seedSessionId === "draft") {
      throw new Error(`没有拿到可引用的 seed session: ${JSON.stringify(seedPane)}`);
    }

    // 2) New draft → clean composer
    await startNewV4Draft();

    // 3) The `@` aggregated entry loads sessions-index and still writes the # canonical mention.
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "@E2E_V4_MENTION_SEED", {
      timeout: 15000,
      timeoutMsg: "v4 composer 输入框没有出现或不可输入",
    });
    const atSessionOptionId = await waitForV4MentionOptionPrefix("session:");
    expect(atSessionOptionId.startsWith("session:")).toBe(true);
    expect(await clickV4SlashOption(atSessionOptionId)).toBe(true);
    await browser.waitUntil(
      async () => ((await getV4ComposerText()) ?? "").includes(`#${seedSessionId}`),
      {
        timeout: 15000,
        timeoutMsg: "@ 会话候选没有写入原 #session-id canonical mention",
      },
    );
    await browser.waitUntil(async () => !(await hasV4SlashPanel()), {
      timeout: 15000,
      timeoutMsg: "选中 @ 会话候选后面板没有关闭",
    });

    // 4) The legacy `#` panel keeps working and shares the same sessions-index authority as @.
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "#E2E_V4_MENTION_SEED", {
      timeout: 15000,
      timeoutMsg: "v4 composer 输入框没有出现或不可输入",
    });
    const hashSessionOptionId = await waitForV4MentionOptionPrefix("session:");
    expect(hashSessionOptionId).toBe(atSessionOptionId);
    expect(await clickV4SlashOption(hashSessionOptionId)).toBe(true);
    await browser.waitUntil(
      async () => ((await getV4ComposerText()) ?? "").includes(`#${seedSessionId}`),
      {
        timeout: 15000,
        timeoutMsg: "# 会话候选没有写入原 #session-id canonical mention",
      },
    );
    await browser.waitUntil(async () => !(await hasV4SlashPanel()), {
      timeout: 15000,
      timeoutMsg: "选中 # 会话候选后面板没有关闭",
    });

    // 5) Legacy Skills triggers (including both Yen keyboard aliases) keep opening the same candidate panel.
    let expectedSkillOptionId: string | undefined;
    let expectedSkillMarkdown: string | undefined;
    for (const skillTrigger of ["$", "¥", "￥"] as const) {
      await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, skillTrigger, {
        timeout: 15000,
        timeoutMsg: `无法输入 Skills 兼容触发器 ${skillTrigger}`,
      });
      const skillOptionId = await waitForV4MentionOptionPrefix("skill:");
      expect(skillOptionId.startsWith("skill:")).toBe(true);
      if (expectedSkillOptionId) {
        expect(skillOptionId).toBe(expectedSkillOptionId);
      } else {
        expectedSkillOptionId = skillOptionId;
      }
      expect(await clickV4SlashOption(skillOptionId)).toBe(true);
      let selectedSkillMarkdown: string | undefined;
      await browser.waitUntil(
        async () => {
          selectedSkillMarkdown = (await getV4ComposerText()) ?? undefined;
          return Boolean(
            selectedSkillMarkdown?.startsWith("[$") && selectedSkillMarkdown.includes("SKILL.md)"),
          );
        },
        {
          timeout: 15000,
          timeoutMsg: `${skillTrigger} 候选没有写入原 Skill canonical mention`,
        },
      );
      if (expectedSkillMarkdown) {
        expect(selectedSkillMarkdown).toBe(expectedSkillMarkdown);
      } else {
        expectedSkillMarkdown = selectedSkillMarkdown;
      }
      await browser.waitUntil(async () => !(await hasV4SlashPanel()), {
        timeout: 15000,
        timeoutMsg: `选中 ${skillTrigger} Skill 候选后面板没有关闭`,
      });
    }

    // 6) The + menu introduces quick inputs via bottom hints; the hints are no longer clickable menu items.
    // Placed after the mention assertions to avoid the Radix menu's close focus racing with Lexical input.
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", {
      timeout: 15000,
      timeoutMsg: "验证动作菜单前无法清空输入框",
    });
    const actionMenuButton = await $(`[data-testid="${TID_CHAT_ATTACHMENT_BUTTON}"]`);
    await actionMenuButton.waitForDisplayed({ timeout: 15000 });
    await actionMenuButton.click();
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const triggers = Array.from(
            document.querySelectorAll<HTMLElement>('[data-trigger="+"] code'),
          ).map((element) => element.textContent);
          return JSON.stringify(triggers) === JSON.stringify(["@", "/", "$"]);
        }),
      {
        timeout: 15000,
        timeoutMsg: "+ 菜单没有按顺序展示 @ / / / $ 提示",
      },
    );
    await browser.keys("Escape");
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "$", { timeout: 15000 });
    expect((await waitForV4MentionOptionPrefix("skill:")).startsWith("skill:")).toBe(true);
    await browser.keys("Escape");

    // Clear the draft so the old mention does not interfere with S08's unique-name filtering.
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", {
      timeout: 15000,
      timeoutMsg: "v4 composer 输入框没有出现或不可输入",
    });

    // 7) Return to the initialized S1 first, then manually add a Skill from the file system.
    // Bug root cause: the old Composer reused the UI snapshot taken at workspace mount for a long time, so new tasks could not see file changes either;
    // the correct boundary pinned here is that the old resident Session does not hot-reload, while the new runtime created by a new task rediscovers.
    await selectV4TaskById(seedSessionId);
    await mkdir(SESSION_SKILL_DIRECTORY, { recursive: true });
    await writeFile(
      SESSION_SKILL_PATH,
      [
        "---",
        `name: ${SESSION_SKILL_NAME}`,
        "description: E2E fixture for the Session Skill catalog lifecycle.",
        "---",
        "",
        "# Session Skill Catalog E2E",
      ].join("\n"),
      "utf-8",
    );

    // 8) S1 still reads the runtime catalog frozen at first context initialization; neither / nor $ can see the new Skill.
    for (const trigger of ["/", "$"] as const) {
      await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, `${trigger}${SESSION_SKILL_NAME}`, {
        timeout: 15000,
        timeoutMsg: `无法在旧 Session 输入 Skill 触发器 ${trigger}`,
      });
      await waitForSessionSkillAbsent(trigger);
      await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", {
        timeout: 15000,
        timeoutMsg: `旧 Session ${trigger} 断言后没有清空 composer`,
      });
    }

    // 9) A new task creates a new prewarm/runtime; the same real SKILL.md must appear in both / and $ candidates.
    await startNewV4Draft();
    let slashSkillOptionId: string | undefined;
    for (const trigger of ["/", "$"] as const) {
      await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, `${trigger}${SESSION_SKILL_NAME}`, {
        timeout: 15000,
        timeoutMsg: `无法在新任务输入 Skill 触发器 ${trigger}`,
      });
      const optionId = await waitForSessionSkillPresent(trigger);
      if (slashSkillOptionId) {
        expect(optionId).toBe(slashSkillOptionId);
      } else {
        slashSkillOptionId = optionId;
      }
      await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", {
        timeout: 15000,
        timeoutMsg: `新任务 ${trigger} 断言后没有清空 composer`,
      });
    }
  });
});
