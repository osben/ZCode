// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskSearchDialog } from "@/TaskSearchDialog.js";

const taskListProbe = vi.hoisted(() => ({
  searchQueries: [] as string[],
  refresh: vi.fn(),
}));

vi.mock("@/hooks/useGlobalTaskList.js", () => ({
  useGlobalTaskList: (params: { searchQuery: string }) => {
    taskListProbe.searchQueries.push(params.searchQuery);
    return {
      items: [],
      total: 0,
      hasMore: false,
      loading: false,
      hasCurrentResult: true,
      syncingRemoteWorkspaces: false,
      refresh: taskListProbe.refresh,
    };
  },
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const PLACEHOLDER = "taskSearch.placeholder";

// cmdk and Radix measure with ResizeObserver and scrollIntoView, which jsdom does not provide.
class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

function renderOpenDialog() {
  render(
    createElement(TaskSearchDialog, {
      workspaceTabs: [],
      onSelectTask: vi.fn(),
      openRequestId: 1,
    }),
  );
  return screen.getByPlaceholderText(PLACEHOLDER) as HTMLInputElement;
}

describe("TaskSearchDialog query settling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    taskListProbe.searchQueries.length = 0;
    taskListProbe.refresh.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("sends one settled query to the task list for a burst of keystrokes", () => {
    const input = renderOpenDialog();

    for (const value of ["r", "re", "rev", "revi", "revie", "review"]) {
      fireEvent.change(input, { target: { value } });
      act(() => {
        vi.advanceTimersByTime(50);
      });
      // The input itself is never delayed.
      expect(input.value).toBe(value);
    }

    // Keystrokes are 50 ms apart, inside the settle window: nothing but the empty query has been sent.
    expect(new Set(taskListProbe.searchQueries)).toEqual(new Set([""]));
    expect(taskListProbe.refresh).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(new Set(taskListProbe.searchQueries)).toEqual(new Set(["", "review"]));
    // Re-renders can repeat the settled query without a new RPC, so count only changes of query.
    const queryTransitions = taskListProbe.searchQueries.filter(
      (query, index, queries) => index === 0 || queries[index - 1] !== query,
    );
    expect(queryTransitions).toEqual(["", "review"]);
    expect(taskListProbe.refresh).toHaveBeenCalledTimes(1);
  });

  it("empties the task list immediately when the input is cleared", () => {
    const input = renderOpenDialog();

    fireEvent.change(input, { target: { value: "review" } });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(taskListProbe.searchQueries.at(-1)).toBe("review");

    fireEvent.change(input, { target: { value: "" } });

    expect(taskListProbe.searchQueries.at(-1)).toBe("");
  });
});
