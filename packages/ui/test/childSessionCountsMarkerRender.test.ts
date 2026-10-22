// @vitest-environment jsdom
// Behavioral render tests for the sidebar child-conversation marker (spec:
// sidebar-child-conversation-counts.md §4): per-segment zero-hide, running form with the
// TTL-lag clamp, tooltip composition, and the expander click contract.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      // Return the key so tooltip composition is asserted without locale data.
      formatMessage: ({ id }: { id: string }) => id,
      formatPlural: ({ id }: { id: string }) => id,
    },
  }),
}));

import { ChildSessionCountsMarker } from "@/components/ChildSessionCountsMarker.js";

function taskWith(overrides: Partial<ZCodeTaskMeta>): ZCodeTaskMeta {
  return {
    taskId: "s-parent",
    traceId: "trace-1" as ZCodeTaskMeta["traceId"],
    title: "parent",
    workspacePath: "/ws",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  } as ZCodeTaskMeta;
}

afterEach(cleanup);

describe("ChildSessionCountsMarker running spinner", () => {
  it("rotates an HTML wrapper instead of the SVG", () => {
    const { container } = render(
      createElement(ChildSessionCountsMarker, {
        task: taskWith({ subagentCount: 2, runningSubagentCount: 1 }),
        expanded: false,
      }),
    );
    const spinner = container.querySelector(".motion-safe\\:animate-spin");
    expect(spinner?.tagName).toBe("SPAN");
    expect(spinner?.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("svg.motion-safe\\:animate-spin")).toBeNull();
  });
});

describe("ChildSessionCountsMarker render behavior", () => {
  it("renders nothing for a task without children", () => {
    const { container } = render(
      createElement(ChildSessionCountsMarker, { task: taskWith({}), expanded: false }),
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders only the side-chat segment when there are no subagents", () => {
    render(
      createElement(ChildSessionCountsMarker, {
        task: taskWith({ sideChatCount: 1 }),
        expanded: false,
      }),
    );
    expect(screen.getByTitle("taskList.childSideChatsCount")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
  });

  it("renders the running form (loader + running/total) and includes all tooltip phrases", () => {
    render(
      createElement(ChildSessionCountsMarker, {
        task: taskWith({ sideChatCount: 2, subagentCount: 3, runningSubagentCount: 1 }),
        expanded: false,
      }),
    );
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("1/3")).toBeTruthy();
    expect(
      screen.getByTitle(
        "taskList.childSideChatsCount · taskList.childSubagentsCount · taskList.childSubagentsRunningCount",
      ),
    ).toBeTruthy();
  });

  it("clamps the denominator when the live running count outruns the cached total (TTL lag)", () => {
    render(
      createElement(ChildSessionCountsMarker, {
        task: taskWith({ runningSubagentCount: 2 }),
        expanded: false,
      }),
    );
    expect(screen.getByText("2/2")).toBeTruthy();
  });

  it("expander click fires onToggle and reflects aria-expanded; the display-only variant has none", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      createElement(ChildSessionCountsMarker, {
        task: taskWith({ subagentCount: 2 }),
        expanded: false,
        onToggle,
      }),
    );
    const marker = screen.getByRole("button");
    expect(marker.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(marker);
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(
      createElement(ChildSessionCountsMarker, {
        task: taskWith({ subagentCount: 2 }),
        expanded: true,
        onToggle,
      }),
    );
    expect(marker.getAttribute("aria-expanded")).toBe("true");

    // Drag-overlay variant: plain span, no button semantics, no toggle.
    const display = render(
      createElement(ChildSessionCountsMarker, {
        task: taskWith({ subagentCount: 2 }),
        expanded: false,
      }),
    );
    expect(display.container.querySelector("button")).toBeNull();
    expect(display.container.querySelector("[data-child-sessions-marker]")).toBeTruthy();
  });
});
