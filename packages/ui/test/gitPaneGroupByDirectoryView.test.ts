// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitDiffResult } from "@zcode/shared";
import type { GitPaneFileChange, GitPaneRepositoryState } from "@/hooks/useGitRepository.js";
import { GIT_PANE_GROUP_BY_DIRECTORY_STORAGE_KEY } from "@/lib/gitPaneGroupByDirectoryPreference.js";
import { GitPane } from "@/GitPane.js";
import { buildLastTurnGitDataset, withLastTurnDataset } from "@/review-last-turn/index.js";

// Renders the real GitPane. Services, store, i18n and file-context hooks are replaced with
// stubs, and GitPaneChangeCard is replaced by a stub that exposes the props GitPane owns
// (expansion, hideDirectoryPart, row identity). The real card's rendering is not covered here.

const { gitService } = vi.hoisted(() => ({
  gitService: { getDiff: vi.fn() },
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ gitService }),
}));
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (selector: (state: unknown) => unknown) =>
    selector({ theme: "light", codePreviewSettings: {} }),
}));
vi.mock("@/hooks/useFileContextActions.js", () => ({
  useFileContextActions: () => ({
    canRevealInFileManager: () => false,
    copyAbsolutePath: vi.fn(),
    copyRelativePath: vi.fn(),
    revealInFileManager: vi.fn(),
  }),
}));
vi.mock("@/hooks/useWorkspaceOpenInEditorTarget.js", () => ({
  useWorkspaceOpenInEditorTarget: () => ({ isRemoteWorkspace: false, remoteTarget: undefined }),
}));
vi.mock("@/i18n/IntlProvider.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/i18n/IntlProvider.js")>()),
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/GitPaneChangeCard.js", async () => {
  const { createElement: h } = await import("react");
  return {
    GitPaneChangeCard: (props: {
      change: { path: string };
      isExpanded: boolean;
      hideDirectoryPart?: boolean;
      onOpenChange: (change: { path: string }, open: boolean) => void;
    }) =>
      h(
        "div",
        {
          "data-testid": "change-card",
          "data-path": props.change.path,
          "data-hide-directory-part": String(props.hideDirectoryPart === true),
          "aria-expanded": String(props.isExpanded),
        },
        h(
          "button",
          {
            type: "button",
            onClick: () => props.onOpenChange(props.change, !props.isExpanded),
          },
          `toggle ${props.change.path}`,
        ),
      ),
  };
});

const CHECKBOX_LABEL = "chat.changeSummary.treeView";

function makeDiff(path: string, overrides: Partial<GitDiffResult> = {}): GitDiffResult {
  return {
    path,
    availability: "unavailable",
    patch: null,
    beforeContent: null,
    afterContent: null,
    summary: null,
    ...overrides,
  };
}

function makeChange(
  workspaceRelativePath: string,
  overrides: Partial<GitPaneFileChange> = {},
): GitPaneFileChange {
  return {
    path: workspaceRelativePath,
    repoRelativePath: workspaceRelativePath,
    workspaceRelativePath,
    kind: "modified",
    section: "unstaged",
    added: 1,
    removed: 0,
    isStaged: false,
    isUntracked: false,
    isConflicted: false,
    diff: makeDiff(workspaceRelativePath),
    ...overrides,
  };
}

// Unstaged source: two sections. The packages/ui/src run appears in both sections, so grouped
// mode must show two headers for it and keep the flat order.
const unstagedChanges: GitPaneFileChange[] = [
  makeChange("packages/ui/src/GitPane.tsx", { added: 2, removed: 1 }),
  makeChange("packages/ui/src/useTheme.ts", { added: 4, removed: 0 }),
  makeChange("packages/shared/src/git.ts", { added: 1, removed: 1 }),
];
const untrackedChanges: GitPaneFileChange[] = [
  makeChange("packages/ui/src/scratch.ts", { section: "untracked", isUntracked: true, added: 3 }),
  makeChange("README.md", { section: "untracked", isUntracked: true, added: 1 }),
];
const stagedChanges: GitPaneFileChange[] = [
  makeChange("apps/cli/main.ts", { section: "staged", isStaged: true, added: 5, removed: 2 }),
];

const EMPTY_SUMMARY = {
  workspacePath: "/project",
  repoRoot: "/project",
  workspaceInRepoPath: "",
  autoRefreshWatchPaths: [],
  branchName: "main",
  trackingBranchName: null,
  headRefType: "branch",
  ahead: 0,
  behind: 0,
  isDirty: true,
  isGitAvailable: true,
  isRepository: true,
} as unknown as GitPaneRepositoryState["summary"];

function makeState(
  overrides: Partial<Pick<GitPaneRepositoryState, "loading" | "error">> & {
    unstaged?: GitPaneFileChange[];
  } = {},
): GitPaneRepositoryState {
  const unstaged = overrides.unstaged ?? [...unstagedChanges, ...untrackedChanges];
  const unstagedSections = [
    {
      id: "unstaged" as const,
      changes: unstaged.filter((change) => change.section === "unstaged"),
    },
    {
      id: "untracked" as const,
      changes: unstaged.filter((change) => change.section === "untracked"),
    },
  ].filter((section) => section.changes.length > 0);
  return {
    workspaceKey: "/project",
    workspacePath: "/project",
    summary: EMPTY_SUMMARY,
    identity: {
      userName: null,
      userEmail: null,
      nameSource: null,
      emailSource: null,
      scopeLabel: null,
    },
    placeholder: { enabled: false },
    loading: overrides.loading ?? false,
    error: overrides.error ?? null,
    revision: 1,
    sourceOptions: [
      { id: "unstaged", count: unstaged.length, readonly: false, disabled: false },
      { id: "staged", count: stagedChanges.length, readonly: false, disabled: false },
    ],
    datasets: {
      unstaged: { id: "unstaged", readonly: false, sections: unstagedSections },
      staged: {
        id: "staged",
        readonly: false,
        sections: [{ id: "staged", changes: stagedChanges }],
      },
      branch: { id: "branch", readonly: false, sections: [] },
      "last-turn": { id: "last-turn", readonly: true, sections: [] },
    },
  };
}

interface PaneProps {
  gitState: GitPaneRepositoryState;
  selectedSourceId: "unstaged" | "staged" | "last-turn";
  fileChangeFindQuery: string;
  fileChangeFindActiveIndex: number;
  onFileChangeFindMatchCountChange: (count: number) => void;
}

function paneProps(overrides: Partial<PaneProps> = {}): PaneProps {
  return {
    gitState: makeState(),
    selectedSourceId: "unstaged",
    fileChangeFindQuery: "",
    fileChangeFindActiveIndex: 0,
    onFileChangeFindMatchCountChange: vi.fn(),
    ...overrides,
  };
}

function mountPane(props: PaneProps) {
  const noop = vi.fn();
  const view = render(
    createElement(GitPane, {
      workspacePath: "/project",
      isDesktop: false,
      fileChangeFindNavigationRequestId: 0,
      onSelectSource: noop,
      onClose: noop,
      onRefresh: noop,
      ...props,
    } as never),
  );
  return {
    ...view,
    rerenderWith: (next: Partial<PaneProps>) =>
      view.rerender(
        createElement(GitPane, {
          workspacePath: "/project",
          isDesktop: false,
          fileChangeFindNavigationRequestId: 0,
          onSelectSource: noop,
          onClose: noop,
          onRefresh: noop,
          ...props,
          ...next,
        } as never),
      ),
  };
}

function getCheckbox() {
  return screen.queryByRole("checkbox", { name: CHECKBOX_LABEL });
}

function isChecked(): boolean {
  return getCheckbox()?.getAttribute("aria-checked") === "true";
}

function renderedCardPaths(): string[] {
  return screen.queryAllByTestId("change-card").map((card) => card.getAttribute("data-path")!);
}

function renderedHeaders(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-git-pane-directory-virtual-row]"),
  );
}

function cardFor(path: string): HTMLElement {
  const card = document.querySelector<HTMLElement>(
    `[data-testid="change-card"][data-path="${path}"]`,
  );
  if (!card) {
    throw new Error(`card not rendered: ${path}`);
  }
  return card;
}

const ALL_PATHS = [...unstagedChanges, ...untrackedChanges].map((change) => change.path);

// jsdom has no layout. TanStack Virtual computes its visible range from the scroll element's
// size, so a 0px viewport renders no rows. Give every element a fixed viewport so the small
// fixtures below stay fully inside the rendered range. This does not model real scrolling.
const VIEWPORT_PX = 800;
let restoreViewport: Array<() => void> = [];

function stubViewport() {
  const rect = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: VIEWPORT_PX,
    right: VIEWPORT_PX,
    width: VIEWPORT_PX,
    height: VIEWPORT_PX,
    toJSON: () => ({}),
  } as DOMRect;
  const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
  const restoreDimension = (name: "offsetHeight" | "clientHeight") => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get: () => VIEWPORT_PX,
    });
    return () => {
      if (original) {
        Object.defineProperty(HTMLElement.prototype, name, original);
      } else {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
      }
    };
  };
  restoreViewport = [
    () => rectSpy.mockRestore(),
    restoreDimension("offsetHeight"),
    restoreDimension("clientHeight"),
  ];
}

beforeEach(() => {
  window.localStorage.clear();
  gitService.getDiff.mockReset();
  stubViewport();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  restoreViewport.forEach((restore) => restore());
  restoreViewport = [];
});

describe("Review pane: Group by directory checkbox visibility", () => {
  it("shows the checkbox for a settled, non-empty list", () => {
    mountPane(paneProps());
    expect(getCheckbox()).not.toBeNull();
  });

  it("hides the checkbox for an empty list", () => {
    mountPane(paneProps({ gitState: makeState({ unstaged: [] }) }));
    expect(getCheckbox()).toBeNull();
  });

  it("hides the checkbox while loading, even though stale rows stay on screen", () => {
    mountPane(paneProps({ gitState: makeState({ loading: true }) }));
    expect(renderedCardPaths()).toEqual(ALL_PATHS);
    expect(getCheckbox()).toBeNull();
  });

  it("hides the checkbox in the error state", () => {
    mountPane(paneProps({ gitState: makeState({ error: "boom" }) }));
    expect(getCheckbox()).toBeNull();
    expect(renderedCardPaths()).toEqual(ALL_PATHS);
    expect(screen.getByRole("alert").textContent).toContain("git.error.description");
  });
});

describe("Review pane: flat and grouped rendering", () => {
  it("fresh state is flat: unchecked, no headers, files in change order", () => {
    mountPane(paneProps());

    expect(isChecked()).toBe(false);
    expect(renderedHeaders()).toHaveLength(0);
    expect(renderedCardPaths()).toEqual(ALL_PATHS);
    for (const card of screen.getAllByTestId("change-card")) {
      expect(card.getAttribute("data-hide-directory-part")).toBe("false");
    }
  });

  it("checking the box groups consecutive same-directory runs per section, keeping file order", () => {
    mountPane(paneProps());
    fireEvent.click(getCheckbox()!);

    expect(isChecked()).toBe(true);
    expect(window.localStorage.getItem(GIT_PANE_GROUP_BY_DIRECTORY_STORAGE_KEY)).toBe("true");

    // Four runs: packages/ui/src (unstaged), packages/shared/src, packages/ui/src (untracked again), root.
    const headers = renderedHeaders();
    // The header's title attribute carries the directory ("" for root-level files).
    expect(headers.map((header) => header.querySelector("[title]")?.getAttribute("title"))).toEqual(
      ["packages/ui/src", "packages/shared/src", "packages/ui/src", ""],
    );
    // First run aggregates GitPane.tsx (+2 -1) and useTheme.ts (+4 -0) into a file count of 2.
    expect(headers[0]!.textContent).toContain("2");
    expect(headers[0]!.textContent).toContain("+6");
    expect(headers[0]!.textContent).toContain("−1");

    expect(renderedCardPaths()).toEqual(ALL_PATHS);
    for (const card of screen.getAllByTestId("change-card")) {
      expect(card.getAttribute("data-hide-directory-part")).toBe("true");
    }
  });

  it("unchecking returns to flat order and removes the stored preference", () => {
    mountPane(paneProps());
    fireEvent.click(getCheckbox()!);
    fireEvent.click(getCheckbox()!);

    expect(isChecked()).toBe(false);
    expect(window.localStorage.getItem(GIT_PANE_GROUP_BY_DIRECTORY_STORAGE_KEY)).toBeNull();
    expect(renderedHeaders()).toHaveLength(0);
    expect(renderedCardPaths()).toEqual(ALL_PATHS);
  });

  it("keeps the checkbox state when the source switches", () => {
    const props = paneProps();
    const { rerenderWith } = mountPane(props);
    fireEvent.click(getCheckbox()!);

    rerenderWith({ selectedSourceId: "staged" });

    expect(isChecked()).toBe(true);
    expect(renderedCardPaths()).toEqual(["apps/cli/main.ts"]);
    expect(renderedHeaders()).toHaveLength(1);
  });
});

describe("Review pane: reload persistence", () => {
  it("restores the grouped view after remount when the stored value is 'true'", () => {
    const first = mountPane(paneProps());
    fireEvent.click(getCheckbox()!);
    first.unmount();

    mountPane(paneProps());
    expect(isChecked()).toBe(true);
    expect(renderedHeaders()).toHaveLength(4);
  });

  it("treats an invalid stored value as unchecked and flat", () => {
    window.localStorage.setItem(GIT_PANE_GROUP_BY_DIRECTORY_STORAGE_KEY, "directory");

    mountPane(paneProps());
    expect(isChecked()).toBe(false);
    expect(renderedHeaders()).toHaveLength(0);
  });

  it("does not read or write the chat card preference key", () => {
    window.localStorage.setItem("zcode-change-summary-tree-view", "true");

    mountPane(paneProps());
    expect(isChecked()).toBe(false);

    fireEvent.click(getCheckbox()!);
    expect(window.localStorage.getItem("zcode-change-summary-tree-view")).toBe("true");
  });
});

describe("Review pane: expansion and active find across modes", () => {
  it("keeps a flat-mode expanded card expanded when grouping is toggled", () => {
    mountPane(paneProps());
    expect(cardFor("packages/shared/src/git.ts").getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "toggle packages/shared/src/git.ts" }));
    expect(cardFor("packages/shared/src/git.ts").getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(getCheckbox()!);
    expect(cardFor("packages/shared/src/git.ts").getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(getCheckbox()!);
    expect(cardFor("packages/shared/src/git.ts").getAttribute("aria-expanded")).toBe("true");
  });

  it("auto-expands the active find match and keeps it at its grouped row index after toggling", () => {
    // Only git.ts contains the needle; every other change has a loaded diff with no match.
    const changes = [...unstagedChanges, ...untrackedChanges].map((change) =>
      change.path === "packages/shared/src/git.ts"
        ? makeChange(change.path, {
            diff: makeDiff(change.path, {
              availability: "patch",
              beforeContent: "needle",
              afterContent: "",
            }),
          })
        : change,
    );
    const onMatchCount = vi.fn();
    mountPane(
      paneProps({
        gitState: makeState({ unstaged: changes }),
        fileChangeFindQuery: "needle",
        onFileChangeFindMatchCountChange: onMatchCount,
      }),
    );

    expect(onMatchCount).toHaveBeenLastCalledWith(1);
    expect(cardFor("packages/shared/src/git.ts").getAttribute("aria-expanded")).toBe("true");
    expect(gitService.getDiff).not.toHaveBeenCalled();

    // Flat index of git.ts is 2. Grouped: header(0) GitPane(1) useTheme(2) header(3) git.ts(4).
    const rowIndexOf = (path: string) =>
      document
        .querySelector<HTMLElement>(
          `[data-git-pane-change-virtual-row] [data-testid="change-card"][data-path="${path}"]`,
        )
        ?.parentElement?.getAttribute("data-index");
    expect(rowIndexOf("packages/shared/src/git.ts")).toBe("2");

    fireEvent.click(getCheckbox()!);
    expect(rowIndexOf("packages/shared/src/git.ts")).toBe("4");
    expect(cardFor("packages/shared/src/git.ts").getAttribute("aria-expanded")).toBe("true");
    expect(onMatchCount).toHaveBeenLastCalledWith(1);
  });
});

describe("Review pane: Last turn source (ISSUE-056)", () => {
  function lastTurnState(withTurn: boolean): GitPaneRepositoryState {
    const base = makeState();
    const state = {
      ...base,
      sourceOptions: [
        ...base.sourceOptions,
        { id: "last-turn" as const, count: 0, readonly: true, disabled: false },
      ],
    };
    if (!withTurn) return state;
    const dataset = buildLastTurnGitDataset({
      workspacePath: "/project",
      result: {
        files: 1,
        additions: 4,
        deletions: 0,
        items: [
          {
            path: "/project/src/math.js",
            additions: 4,
            deletions: 0,
            writeCount: 1,
            toolNames: ["Edit"],
            patches: [
              {
                oldStart: 3,
                oldLines: 0,
                newStart: 4,
                newLines: 4,
                lines: ["+export function square(x) {", "+  return x * x;", "+}", "+"],
              },
            ],
          },
        ],
      },
    });
    return withLastTurnDataset(state, { dataset, count: 1 });
  }

  it("lists the turn's file instead of the empty state and never asks Git for its diff", () => {
    mountPane(paneProps({ gitState: lastTurnState(true), selectedSourceId: "last-turn" }));
    expect(renderedCardPaths()).toEqual(["/project/src/math.js"]);
    expect(screen.queryByText("git.empty.lastTurnTitle")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "toggle /project/src/math.js" }));
    expect(cardFor("/project/src/math.js").getAttribute("aria-expanded")).toBe("true");
    expect(gitService.getDiff).not.toHaveBeenCalled();
  });

  it("keeps the empty state when no turn changed files", () => {
    mountPane(paneProps({ gitState: lastTurnState(false), selectedSourceId: "last-turn" }));
    expect(renderedCardPaths()).toEqual([]);
    expect(screen.getByText("git.empty.lastTurnTitle")).toBeTruthy();
  });
});
