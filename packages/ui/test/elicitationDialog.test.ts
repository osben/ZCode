import type { ZCodeElicitationRequest } from "@zcode/shared";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  buildElicitationResponseContent,
  createInitialElicitationDrafts,
  ElicitationDialog,
  getElicitationCountdownSeconds,
  getElicitationQuestionAdvanceKind,
  normalizeElicitationQuestions,
  resolveElicitationCustomInputKeyAction,
  updateElicitationDraftsForOption,
} from "../src/ElicitationDialog.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { expectedCopy } from "./helpers/uiCopy.js";

const SUBAGENT_ORIGIN = {
  kind: "subagent" as const,
  agentId: "general-purpose",
  agentType: "general-purpose",
  childSessionId: "sess-child",
  parentSessionId: "sess-parent",
  parentToolCallId: "tool-parent-agent",
};

function createMultiQuestionRequest(): ZCodeElicitationRequest {
  return {
    type: "elicitation_request",
    taskId: "task-1",
    traceId: "run-1",
    requestId: "request-1",
    message: "Please choose an approach",
    options: [],
    questions: [
      {
        question: "Please choose an approach",
        header: "Approach",
        options: [
          { value: "fast", label: "Fast" },
          { value: "safe", label: "Safe" },
        ],
      },
      {
        question: "Please choose the safeguards",
        header: "Safeguards",
        options: [
          { value: "tests", label: "Tests" },
          { value: "docs", label: "Docs" },
        ],
      },
    ],
  };
}

function createPlanApprovalRequest(): ZCodeElicitationRequest {
  return {
    type: "elicitation_request",
    taskId: "task-1",
    traceId: "run-1",
    requestId: "exit-plan-1",
    message: "Review this implementation plan.",
    header: "Plan",
    options: [
      {
        value: "approve",
        label: "Approve",
        description: "Exit plan mode and start implementation.",
      },
    ],
    questions: [
      {
        question: "Review this implementation plan.",
        header: "Plan",
        options: [
          {
            value: "approve",
            label: "Approve",
            description: "Exit plan mode and start implementation.",
          },
        ],
      },
    ],
    schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
  };
}

describe("ElicitationDialog", () => {
  it("only exposes 59s through 1s during the final minute", () => {
    const autoResolution = {
      state: "visibleCountdown" as const,
      startedAt: 700_000,
      visibleAt: 760_000,
      deadlineAt: 1_000_000,
    };

    expect(getElicitationCountdownSeconds(autoResolution, 940_000)).toBeNull();
    expect(getElicitationCountdownSeconds(autoResolution, 940_001)).toBe(59);
    expect(getElicitationCountdownSeconds(autoResolution, 999_000)).toBe(1);
    expect(getElicitationCountdownSeconds(autoResolution, 999_999)).toBe(1);
    expect(getElicitationCountdownSeconds(autoResolution, 1_000_000)).toBeNull();
    expect(
      getElicitationCountdownSeconds(
        { state: "snoozed", startedAt: 700_000, snoozedAt: 900_000 },
        940_001,
      ),
    ).toBeNull();
  });

  it.each([
    ["en-US", expectedCopy("taskList.stopCountdown"), ">59s</button>"],
    ["zh-CN", "停止计时", ">59秒</button>"],
  ] as const)("renders a localized final-minute timer (%s)", (locale, stopLabel, secondsMarkup) => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(940_001);
    const Dialog = ElicitationDialog as ComponentType<Record<string, unknown>>;
    const autoResolution = {
      state: "visibleCountdown" as const,
      startedAt: 700_000,
      visibleAt: 760_000,
      deadlineAt: 1_000_000,
    };
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: locale },
        createElement(Dialog, {
          request: createMultiQuestionRequest(),
          autoResolution,
          onFirstInteraction: () => {},
          onRespond: () => {},
        }),
      ),
    );

    try {
      expect(html).toContain('data-elicitation-countdown-seconds="59"');
      expect(html).toContain(`aria-label="${stopLabel}"`);
      expect(html).toContain(secondsMarkup);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("shows a subagent source tag for delegated elicitation requests only", () => {
    const Dialog = ElicitationDialog as ComponentType<Record<string, unknown>>;
    const request = createMultiQuestionRequest();
    const mainHtml = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(Dialog, {
          request,
          onRespond: () => {},
        }),
      ),
    );
    const subagentHtml = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(Dialog, {
          request: {
            ...request,
            origin: SUBAGENT_ORIGIN,
          },
          onRespond: () => {},
        }),
      ),
    );

    expect(mainHtml).not.toContain('data-interaction-origin-badge="subagent"');
    expect(subagentHtml).toContain('data-interaction-origin-badge="subagent"');
    expect(subagentHtml).toContain(expectedCopy("chat.interactionOrigin.subagent"));
    expect(subagentHtml).toContain(
      expectedCopy("chat.interactionOrigin.subagent.title", { agentType: "general-purpose" }),
    );
  });

  it("submits after the final question and includes the final selected option", () => {
    const request = createMultiQuestionRequest();
    const questions = normalizeElicitationQuestions(request);
    const initialDrafts = createInitialElicitationDrafts(questions, request);
    const firstDrafts = updateElicitationDraftsForOption(initialDrafts, questions[0]!, "fast");
    const finalDrafts = updateElicitationDraftsForOption(firstDrafts, questions[1]!, "tests");

    expect(getElicitationQuestionAdvanceKind(questions, 0)).toBe("next");
    expect(getElicitationQuestionAdvanceKind(questions, 1)).toBe("submit");
    expect(buildElicitationResponseContent(questions, finalDrafts)).toEqual({
      answers: {
        "Please choose an approach": "fast",
        "Please choose the safeguards": "tests",
      },
      answer_0: "fast",
      answer_1: "tests",
    });
  });

  it("allows submitting answers to only some questions without fabricating unanswered ones", () => {
    const request = createMultiQuestionRequest();
    const questions = normalizeElicitationQuestions(request);
    const initialDrafts = createInitialElicitationDrafts(questions, request);
    const finalDrafts = updateElicitationDraftsForOption(initialDrafts, questions[1]!, "tests");

    expect(buildElicitationResponseContent(questions, finalDrafts)).toEqual({
      answers: { "Please choose the safeguards": "tests" },
      answer_1: "tests",
    });
  });

  it("allows submitting zero answers", () => {
    const request = createMultiQuestionRequest();
    const questions = normalizeElicitationQuestions(request);
    const drafts = createInitialElicitationDrafts(questions, request);

    expect(buildElicitationResponseContent(questions, drafts)).toEqual({ answers: {} });
  });

  it("keeps the full hover title for a truncated question header", () => {
    const Dialog = ElicitationDialog as ComponentType<Record<string, unknown>>;
    const longQuestion =
      "The PRD spans 4 native codebases plus shared contract and tokens. How should I sequence implementation?";
    const request = createMultiQuestionRequest();
    request.questions![0] = {
      ...request.questions![0]!,
      question: longQuestion,
    };
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(Dialog, {
          request,
          onRespond: () => {},
        }),
      ),
    );

    expect(html).toContain(`title="${longQuestion}"`);
  });

  it("keeps both the body and the full title for long questions", () => {
    const Dialog = ElicitationDialog as ComponentType<Record<string, unknown>>;
    const longQuestion =
      "The PRD spans 4 native codebases plus shared contract and tokens. How should I sequence implementation without hiding the decision text on mobile?";
    const request = createMultiQuestionRequest();
    request.questions![0] = {
      ...request.questions![0]!,
      question: longQuestion,
    };
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(Dialog, {
          request,
          onRespond: () => {},
        }),
      ),
    );

    expect(html).toContain(`title="${longQuestion}"`);
    expect(html).toContain(">Approach</span>");
    expect(html).toContain(`>${longQuestion}</span>`);
  });

  it("provides an expand entry for long questions", () => {
    const Dialog = ElicitationDialog as ComponentType<Record<string, unknown>>;
    const longQuestion =
      "Imagine you are designing a next-generation distributed real-time collaboration platform for a global audience. It must support millions of concurrent users editing documents, whiteboards, spreadsheets and low-code apps, and still allow offline editing with automatic conflict merging once connectivity returns. Explain your choices at the data synchronization protocol level.";
    const request = createMultiQuestionRequest();
    request.questions![0] = {
      question: longQuestion,
      header: "Data sync protocol",
      options: [
        {
          value: "crdt",
          label: "CRDT (Conflict-free Replicated Data Types)",
          description:
            "Based on conflict-free replicated data types, naturally supporting decentralized sync and P2P scenarios.",
        },
        {
          value: "ot",
          label: "OT (Operational Transform)",
          description:
            "Based on operational transformation, relying on a central server to order and transform operations.",
        },
        {
          value: "hybrid",
          label: "Hybrid CRDT + OT",
          description:
            "The client handles local changes and offline buffering; the server handles final ordering.",
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(Dialog, {
          request,
          onRespond: () => {},
        }),
      ),
    );

    expect(html).toContain(`aria-label="${expectedCopy("chat.elicitation.expandQuestion")}"`);
  });

  it("provides a whole-card collapse entry for the mobile blocking dialog and marks hideable content", () => {
    const Dialog = ElicitationDialog as ComponentType<Record<string, unknown>>;
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(Dialog, {
          request: createMultiQuestionRequest(),
          onRespond: () => {},
        }),
      ),
    );

    expect(html).toContain(`aria-label="${expectedCopy("chat.elicitation.collapseDialog")}"`);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-elicitation-dialog-body="true"');
    expect(html).toContain('data-elicitation-dialog-footer="true"');
  });

  it("shows option labels and descriptions", () => {
    const Dialog = ElicitationDialog as ComponentType<Record<string, unknown>>;
    const request = createMultiQuestionRequest();
    request.questions![0]!.options[0] = {
      value: "fast",
      label: "Fast",
      description: "Handle the core path first",
    };
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(Dialog, {
          request,
          onRespond: () => {},
        }),
      ),
    );

    expect(html).toContain(">Fast</span>");
    expect(html).toContain(">Handle the core path first</span>");
  });

  it.each([
    {
      lang: "en-US",
      permissionTitle: expectedCopy("chat.permission.title"),
      planTitle: expectedCopy("chat.permission.switchMode.placeholder"),
      approveLabel: expectedCopy("chat.elicitation.planApproval.approve"),
      approveDescription: expectedCopy("chat.elicitation.planApproval.approveDescription"),
      forbidden: [">Allow</span>", "Allow only this time"],
    },
    {
      lang: "zh-CN",
      permissionTitle: "需要权限",
      planTitle: "实施计划",
      approveLabel: "批准",
      approveDescription: "退出计划模式并开始实施。",
      forbidden: [">允许</span>", ">Approve</span>", "Exit plan mode and start implementation."],
    },
  ] as const)(
    "plan approval title follows permission copy and approve option keeps approval copy (%s)",
    ({ lang, permissionTitle, planTitle, approveLabel, approveDescription, forbidden }) => {
      const Dialog = ElicitationDialog as ComponentType<Record<string, unknown>>;
      const request = createPlanApprovalRequest();
      const html = renderToStaticMarkup(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: lang },
          createElement(Dialog, {
            request,
            onRespond: () => {},
          }),
        ),
      );

      expect(html).toContain(permissionTitle);
      expect(html).toContain(planTitle);
      expect(html).toContain(`${approveLabel}</span>`);
      expect(html).toContain(approveDescription);
      expect(html).toContain(">1.</span>");
      expect(html).toContain(">2.</span>");
      for (const text of forbidden) {
        expect(html).not.toContain(text);
      }
    },
  );

  it("custom answer input Enter follows the current question and plan approval semantics, and avoids IME composition", () => {
    expect(
      resolveElicitationCustomInputKeyAction({
        key: "Enter",
        advanceKind: "next",
      }),
    ).toBe("advance");
    expect(
      resolveElicitationCustomInputKeyAction({
        key: "Enter",
        advanceKind: "submit",
      }),
    ).toBe("submit");
    expect(resolveElicitationCustomInputKeyAction({ key: "Enter" })).toBe("advance");
    expect(resolveElicitationCustomInputKeyAction({ key: "Enter", ctrlKey: true })).toBe("submit");
    expect(resolveElicitationCustomInputKeyAction({ key: "Enter", metaKey: true })).toBe("submit");
    expect(
      resolveElicitationCustomInputKeyAction({
        key: "Enter",
        nativeEvent: { isComposing: true },
      }),
    ).toBeNull();
    expect(
      resolveElicitationCustomInputKeyAction({
        key: "Enter",
        compositionActive: true,
      }),
    ).toBeNull();
    expect(resolveElicitationCustomInputKeyAction({ key: "Escape" })).toBe("dismiss");
    expect(
      resolveElicitationCustomInputKeyAction({
        key: "Escape",
        hasPreviousQuestion: true,
      }),
    ).toBe("previous");
  });

  it("ExitPlanMode custom feedback input submits on bare Enter", () => {
    expect(
      resolveElicitationCustomInputKeyAction({
        key: "Enter",
        isPlanApproval: true,
      }),
    ).toBe("submit");
    expect(
      resolveElicitationCustomInputKeyAction({
        key: "Escape",
        hasPreviousQuestion: true,
        isPlanApproval: true,
      }),
    ).toBe("dismiss");
  });
});
