// @vitest-environment jsdom
// ISSUE-043: the commit dialog opened from "Commit or push" must have an accessible name
// (DialogTitle) and must not trigger Radix's missing-title warning, and the changed-file count
// must use the singular form for one file. This uses the real en-US catalog through createIntl so
// the plural family is exercised end to end (the family is selected by formatPlural, not by ICU).
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { GitFileChange, GitIdentity, GitRepositorySummary } from "@zcode/shared";
import { GitActionMenu } from "@/GitActionMenu.js";

const mocks = vi.hoisted(() => ({
  gitService: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock("@/i18n/IntlProvider.js", async () => {
  const { createIntl } = await import("@/i18n/createIntl.js");
  const { default: enUS } = await import("@/i18n/locales/en-US.js");
  const intl = createIntl("en-US", { "en-US": enUS });
  return { useZCodeIntl: () => ({ locale: "en-US", intl }) };
});

vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));

vi.mock("@/GitBranchSwitcher.js", () => ({ GitBranchSwitcher: () => null }));

vi.mock("@/components/ui/tooltip.js", async () => {
  const { createElement } = await import("react");
  const passthrough = ({ children }: { children?: unknown }) =>
    createElement("span", null, children);
  return {
    Tooltip: passthrough,
    TooltipTrigger: passthrough,
    TooltipContent: () => null,
    TooltipProvider: passthrough,
  };
});

vi.mock("@/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    lifecycle: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    trace: vi.fn(),
  },
}));

vi.mock("@/lib/userActionTelemetry.js", () => ({
  runUserAction: (options: { operation: () => unknown }) => options.operation(),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ gitService: mocks.gitService }),
  useOptionalServices: () => null,
}));

const summary: GitRepositorySummary = {
  workspacePath: "/qa/commit-dialog",
  repoRoot: "/qa/commit-dialog",
  workspaceInRepoPath: "",
  autoRefreshWatchPaths: [],
  branchName: "main",
  trackingBranchName: "origin/main",
  headRefType: "branch",
  ahead: 0,
  behind: 0,
  isDirty: true,
  isGitAvailable: true,
  isRepository: true,
};

const identity: GitIdentity = {
  userName: "QA",
  userEmail: "qa@example.invalid",
  nameSource: "global",
  emailSource: "global",
};

const unstagedChange: GitFileChange = {
  path: "src/app.txt",
  repoRelativePath: "src/app.txt",
  workspaceRelativePath: "src/app.txt",
  x: "M",
  y: "M",
  kind: "modified",
  section: "unstaged",
  added: 1,
  removed: 0,
  isStaged: false,
  isUntracked: false,
  isConflicted: false,
};

class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  // cmdk scrolls the selected item into view; jsdom does not implement it.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderWithOneUnstagedFile() {
  mocks.gitService = {
    refresh: vi.fn(async () => ({
      summary,
      identity,
      unstagedChanges: [unstagedChange],
      stagedChanges: [],
    })),
  } as unknown as Record<string, ReturnType<typeof vi.fn>>;

  render(
    createElement(GitActionMenu, {
      workspacePath: "/qa/commit-dialog",
      gitSummary: summary,
      onRefreshGit: vi.fn(),
    }),
  );
  fireEvent.click(screen.getByTestId("git-action-trigger"));
}

describe("GitActionMenu commit dialog accessibility", () => {
  it("names the commit dialog through a DialogTitle without Radix missing-title warnings", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    renderWithOneUnstagedFile();

    expect(await screen.findByRole("dialog", { name: "Commit changes" })).toBeTruthy();
    const radixWarnings = consoleError.mock.calls
      .map((args) => args.map(String).join(" "))
      .filter((text) => text.includes("DialogTitle") || text.includes("Description"));
    expect(radixWarnings).toEqual([]);
  });

  it("uses the singular form for a single changed file", async () => {
    renderWithOneUnstagedFile();

    expect(await screen.findByText("1 file")).toBeTruthy();
    expect(screen.queryByText("1 files")).toBeNull();
  });
});
