// @vitest-environment jsdom
// Saved workflow card (docs/dynamic-workflow/launch.md "Cards"): name / description / last-run states / argument chips.
import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TID_WORKFLOW_CARD,
  TID_WORKFLOW_CARD_MENU,
  TID_WORKFLOW_CARD_RUN,
  TID_WORKFLOW_ACTION_MOVE,
  type ZCodeSavedWorkflowEntry,
  type ZCodeSavedWorkflowRun,
} from "@zcode/shared";
import { testId } from "@zcode/shared/test-ids";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { expectedCopy } from "./helpers/uiCopy.js";
import {
  SavedWorkflowCard,
  SavedWorkflowLastRunBadge,
} from "@/settings/saved-workflows/SavedWorkflowCard.js";

const NOW = 1_700_000_000_000;

afterEach(() => {
  cleanup();
});

function entry(overrides: Partial<ZCodeSavedWorkflowEntry> = {}): ZCodeSavedWorkflowEntry {
  return {
    name: "release-check",
    description: "跑测试、比对 changelog、准备发布说明。",
    scope: "project",
    path: "/repo/.zcode/workflows/release-check.dwf.ts",
    ...overrides,
  };
}

function run(overrides: Partial<ZCodeSavedWorkflowRun> = {}): ZCodeSavedWorkflowRun {
  return {
    runId: "run-1",
    name: "release-check",
    status: "completed",
    createdAt: NOW - 120_000,
    updatedAt: NOW - 60_000,
    spentTokens: 1200,
    ...overrides,
  };
}

function mount(node: ReactNode) {
  return render(createElement(ZCodeIntlProvider, { initialLocale: "en-US" }, node));
}

describe("SavedWorkflowLastRunBadge", () => {
  it("never-run and the four terminal states each get their own data marker", () => {
    const { unmount } = mount(
      createElement(SavedWorkflowLastRunBadge, { run: undefined, now: NOW }),
    );
    expect(
      screen
        .getByText(expectedCopy("workflows.hub.lastRun.never"))
        .getAttribute("data-workflow-last-run"),
    ).toBe("never");
    unmount();
    for (const [status, kind] of [
      ["completed", "completed"],
      ["failed", "errored"],
      ["running", "running"],
      ["pending", "running"],
      ["cancelled", "stopped"],
    ] as const) {
      const view = mount(
        createElement(SavedWorkflowLastRunBadge, { run: run({ status }), now: NOW }),
      );
      expect(view.container.querySelector(`[data-workflow-last-run="${kind}"]`)).not.toBeNull();
      view.unmount();
    }
  });
});

describe("SavedWorkflowCard", () => {
  it("renders name, description, last run, and argument chips (at most 3 + +N)", () => {
    mount(
      createElement(SavedWorkflowCard, {
        entry: entry({
          args: {
            branch: { type: "string" },
            count: { type: "number" },
            dry: { type: "boolean" },
            extra: { type: "json" },
            more: { type: "string" },
          },
        }),
        lastRun: run(),
        now: NOW,
        onOpen: vi.fn(),
        onRun: vi.fn(),
        onRevise: vi.fn(),
        onCopyPath: vi.fn(),
        onDelete: vi.fn(),
      }),
    );
    const card = screen.getByTestId(testId(TID_WORKFLOW_CARD, "release-check"));
    expect(card.getAttribute("data-workflow-name")).toBe("release-check");
    expect(card.textContent).toContain("release-check");
    expect(card.textContent).toContain("跑测试、比对 changelog、准备发布说明。");
    expect(card.querySelector('[data-workflow-last-run="completed"]')).not.toBeNull();
    const chips = card.querySelector('[data-workflow-args="true"]');
    expect(chips?.textContent).toBe("branchcountdry+2");
  });

  it("clicking the card opens details; the card Run button does not bubble into open", () => {
    const onOpen = vi.fn();
    const onRun = vi.fn();
    mount(
      createElement(SavedWorkflowCard, {
        entry: entry(),
        lastRun: undefined,
        now: NOW,
        onOpen,
        onRun,
        onRevise: vi.fn(),
        onCopyPath: vi.fn(),
        onDelete: vi.fn(),
      }),
    );
    fireEvent.click(screen.getByTestId(testId(TID_WORKFLOW_CARD_RUN, "release-check")));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    const card = screen.getByTestId(testId(TID_WORKFLOW_CARD, "release-check"));
    fireEvent.click(card);
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(2);
    // No argument chips section without args.
    expect(card.querySelector('[data-workflow-args="true"]')).toBeNull();
  });

  it("disables card actions while busy", () => {
    mount(
      createElement(SavedWorkflowCard, {
        entry: entry(),
        lastRun: undefined,
        now: NOW,
        busy: true,
        onOpen: vi.fn(),
        onRun: vi.fn(),
        onRevise: vi.fn(),
        onCopyPath: vi.fn(),
        onDelete: vi.fn(),
      }),
    );
    expect(
      (screen.getByTestId(testId(TID_WORKFLOW_CARD_RUN, "release-check")) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("with onMove the menu offers scope items: promote-to-global for project scope, move-to-project for global scope", () => {
    const onMove = vi.fn();
    const view = mount(
      createElement(SavedWorkflowCard, {
        entry: entry(),
        lastRun: undefined,
        now: NOW,
        onOpen: vi.fn(),
        onRun: vi.fn(),
        onRevise: vi.fn(),
        onCopyPath: vi.fn(),
        onMove,
        onDelete: vi.fn(),
      }),
    );
    fireEvent.pointerDown(screen.getByTestId(testId(TID_WORKFLOW_CARD_MENU, "release-check")), {
      button: 0,
      ctrlKey: false,
    });
    const moveItem = screen.getByTestId(testId(TID_WORKFLOW_ACTION_MOVE, "release-check"));
    expect(moveItem.textContent).toBe(expectedCopy("workflows.hub.card.promoteToGlobal"));
    fireEvent.click(moveItem);
    expect(onMove).toHaveBeenCalledTimes(1);
    view.unmount();

    mount(
      createElement(SavedWorkflowCard, {
        entry: entry({ scope: "global" }),
        lastRun: undefined,
        now: NOW,
        onOpen: vi.fn(),
        onRun: vi.fn(),
        onRevise: vi.fn(),
        onCopyPath: vi.fn(),
        onMove: vi.fn(),
        onDelete: vi.fn(),
      }),
    );
    fireEvent.pointerDown(screen.getByTestId(testId(TID_WORKFLOW_CARD_MENU, "release-check")), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByTestId(testId(TID_WORKFLOW_ACTION_MOVE, "release-check")).textContent).toBe(
      expectedCopy("workflows.hub.card.moveToProject"),
    );
  });

  it("without onMove the menu has no move item", () => {
    mount(
      createElement(SavedWorkflowCard, {
        entry: entry(),
        lastRun: undefined,
        now: NOW,
        onOpen: vi.fn(),
        onRun: vi.fn(),
        onRevise: vi.fn(),
        onCopyPath: vi.fn(),
        onDelete: vi.fn(),
      }),
    );
    fireEvent.pointerDown(screen.getByTestId(testId(TID_WORKFLOW_CARD_MENU, "release-check")), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.queryByTestId(testId(TID_WORKFLOW_ACTION_MOVE, "release-check"))).toBeNull();
  });
});
