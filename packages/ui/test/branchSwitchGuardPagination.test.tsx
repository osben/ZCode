// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const useGlobalTaskList = vi.fn();

vi.mock("@/hooks/useGlobalTaskList.js", () => ({
  useGlobalTaskList: (options: unknown) => {
    useGlobalTaskList(options);
    return { items: [] };
  },
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: () => "" } }),
}));

import { useBranchSwitchGuardShell } from "@/v4/composer/branchSwitchGuard.js";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("branch switch guard task scope", () => {
  it("loads the complete active task list instead of the collapsed sidebar page", () => {
    renderHook(() =>
      useBranchSwitchGuardShell({
        workspaceTabs: [{ workspacePath: "/dev/alpha" }],
      }),
    );

    expect(useGlobalTaskList).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "active", expanded: true, collapsedLimit: 0 }),
    );
  });
});
