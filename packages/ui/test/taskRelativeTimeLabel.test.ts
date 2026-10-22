// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider, useZCodeIntl } from "@/i18n/IntlProvider.js";
import { NOW_MINUTE_INTERVAL_MS } from "@/lib/taskListItemPresentation.js";
import { TaskRelativeTimeLabel } from "@/TaskListItem.js";

const START_MS = 1_000_000_000;

function TimeLabelHarness({ timestamp }: { timestamp: number }) {
  const { intl } = useZCodeIntl();
  return createElement(TaskRelativeTimeLabel, { timestamp, intl });
}

function renderLabel(timestamp: number) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(TimeLabelHarness, { timestamp }),
    ),
  );
}

function setDocumentVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => state === "hidden",
  });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START_MS);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(document, "visibilityState");
  Reflect.deleteProperty(document, "hidden");
});

describe("TaskRelativeTimeLabel", () => {
  it("changes from 'now' to '1m' after a minute while the window is visible", () => {
    renderLabel(START_MS);
    expect(screen.getByText("now")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(NOW_MINUTE_INTERVAL_MS);
    });
    expect(screen.getByText("1m")).toBeTruthy();
    expect(screen.queryByText("now")).toBeNull();
  });

  it("keeps the old label while hidden and catches up when shown again", () => {
    renderLabel(START_MS);

    setDocumentVisibility("hidden");
    act(() => {
      vi.advanceTimersByTime(NOW_MINUTE_INTERVAL_MS * 2);
    });
    expect(screen.getByText("now")).toBeTruthy();

    setDocumentVisibility("visible");
    expect(screen.getByText("2m")).toBeTruthy();
  });
});
