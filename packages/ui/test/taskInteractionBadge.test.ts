import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ZCodeTaskPendingInteraction } from "@zcode/shared";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { expectedCopy } from "./helpers/uiCopy.js";
import {
  TaskInteractionBadge,
  getTaskInteractionBadgePresentation,
} from "../src/TaskInteractionBadge.js";

const countdown: ZCodeTaskPendingInteraction = {
  interactionId: "ask-1",
  kind: "userInput",
  toolName: "AskUserQuestion",
  autoResolution: {
    state: "visibleCountdown",
    startedAt: 0,
    visibleAt: 60_000,
    deadlineAt: 300_000,
  },
};

describe("TaskInteractionBadge", () => {
  it("keeps the first minute static, then derives absolute four-minute progress", () => {
    expect(getTaskInteractionBadgePresentation(countdown, false, 0)).toEqual({
      kind: "userInput",
      canSnooze: true,
    });
    expect(getTaskInteractionBadgePresentation(countdown, false, 59_000)).toEqual({
      kind: "userInput",
      canSnooze: true,
    });
    expect(getTaskInteractionBadgePresentation(countdown, false, 60_000)).toEqual({
      kind: "userInput",
      countdownProgress: 1,
      canSnooze: true,
    });
    expect(getTaskInteractionBadgePresentation(countdown, false, 180_000)).toEqual({
      kind: "userInput",
      countdownProgress: 0.5,
      canSnooze: true,
    });
    expect(getTaskInteractionBadgePresentation(countdown, false, 300_000)).toEqual({
      kind: "userInput",
      countdownProgress: 0,
      canSnooze: true,
    });
  });

  it("returns to a static full pill after snooze and never animates permissions", () => {
    expect(
      getTaskInteractionBadgePresentation(
        {
          interactionId: "ask-1",
          kind: "userInput",
          toolName: "AskUserQuestion",
          autoResolution: {
            state: "snoozed",
            startedAt: 0,
            snoozedAt: 299_000,
          },
        },
        false,
        300_000,
      ),
    ).toEqual({ kind: "userInput", canSnooze: false });
    expect(
      getTaskInteractionBadgePresentation(
        { interactionId: "permission-1", kind: "permission" },
        false,
        300_000,
      ),
    ).toEqual({ kind: "permission", canSnooze: false });
    expect(
      getTaskInteractionBadgePresentation(
        {
          interactionId: "exit-plan-1",
          kind: "userInput",
          toolName: "ExitPlanMode",
        },
        false,
        300_000,
      ),
    ).toEqual({ kind: "permission", canSnooze: false });
  });

  it("uses toolName for Ask identity and autoResolution as the old-summary fallback", () => {
    expect(
      getTaskInteractionBadgePresentation(
        {
          interactionId: "ask-new",
          kind: "userInput",
          toolName: "AskUserQuestion",
        },
        false,
        0,
      ),
    ).toEqual({ kind: "userInput", canSnooze: true });
    expect(
      getTaskInteractionBadgePresentation(
        {
          interactionId: "ask-old",
          kind: "userInput",
          autoResolution: {
            state: "hiddenGrace",
            startedAt: 0,
            visibleAt: 60_000,
            deadlineAt: 300_000,
          },
        },
        false,
        0,
      ),
    ).toEqual({ kind: "userInput", canSnooze: true });
  });

  it.each([
    ["zh-CN", "等待确认", "停止计时"],
    ["en-US", expectedCopy("taskList.userInputTag"), expectedCopy("taskList.stopCountdown")],
  ] as const)(
    "renders waiting and stop labels with countdown state in %s",
    (locale, waiting, stop) => {
      const html = renderToStaticMarkup(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: locale },
          createElement(TaskInteractionBadge, {
            interaction: countdown,
            now: 180_000,
            onSnoozeCountdown: () => true,
            formatMessage: (id: string) => {
              if (id === "taskList.permissionTag" || id === "taskList.userInputTag") {
                return waiting;
              }
              if (id === "taskList.stopCountdown") {
                return stop;
              }
              return id;
            },
          }),
        ),
      );

      expect(html).toContain(waiting);
      expect(html).toContain(stop);
      expect(html).toContain(`aria-label="${stop}"`);
      expect(html).toContain('data-countdown-snoozable="true"');
      expect(html).toContain('data-countdown-progress="0.500"');
      expect(html).toContain("bg-interaction-ask-fill");
    },
  );

  it("keeps permissions static even when a snooze callback is present", () => {
    const html = renderToStaticMarkup(
      createElement(TaskInteractionBadge, {
        interaction: { interactionId: "permission-1", kind: "permission" },
        now: 180_000,
        onSnoozeCountdown: () => true,
        formatMessage: (id: string) =>
          id === "taskList.permissionTag"
            ? expectedCopy("taskList.permissionTag")
            : expectedCopy("taskList.stopCountdown"),
      }),
    );

    expect(html).toContain(expectedCopy("taskList.permissionTag"));
    expect(html).not.toContain(expectedCopy("taskList.stopCountdown"));
    expect(html).not.toContain("data-countdown-snoozable");
  });

  it("keeps a snoozed Ask badge static without a stop action", () => {
    const html = renderToStaticMarkup(
      createElement(TaskInteractionBadge, {
        interaction: {
          interactionId: "ask-1",
          kind: "userInput",
          toolName: "AskUserQuestion",
          autoResolution: {
            state: "snoozed",
            startedAt: 0,
            snoozedAt: 299_000,
          },
        },
        now: 300_000,
        onSnoozeCountdown: () => true,
        formatMessage: (id: string) =>
          id === "taskList.userInputTag"
            ? expectedCopy("taskList.userInputTag")
            : expectedCopy("taskList.stopCountdown"),
      }),
    );

    expect(html).toContain(expectedCopy("taskList.userInputTag"));
    expect(html).not.toContain(expectedCopy("taskList.stopCountdown"));
    expect(html).not.toContain("data-countdown-snoozable");
  });
});
