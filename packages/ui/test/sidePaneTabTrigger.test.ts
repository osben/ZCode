// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPatchFileDisplayTarget,
  getSidePaneTabTitle,
  SidePaneTabDragOverlay,
  SidePaneTabIcon,
  SortableSidePaneTabTrigger,
} from "@/app-shell/SidePaneTabTrigger.js";
import { SidePaneTabTitleTooltip } from "@/app-shell/SidePaneTabTitleTooltip.js";
import { Tabs, TabsList } from "@/components/ui/tabs.js";
import type { WorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

vi.mock("@/components/ui/context-menu.js", () => {
  const passthrough = ({ children }: { children: ReactNode }) => children;
  return {
    ContextMenu: passthrough,
    ContextMenuTrigger: passthrough,
    ContextMenuContent: ({ children }: { children: ReactNode }) =>
      createElement("div", { "data-testid": "context-menu-content" }, children),
    ContextMenuItem: ({ children }: { children: ReactNode }) =>
      createElement("div", { role: "menuitem" }, children),
  };
});

vi.mock("@/components/ui/tooltip.js", () => {
  const passthrough = ({ children }: { children: ReactNode }) => children;
  return {
    Tooltip: ({ children, open }: { children: ReactNode; open?: boolean }) =>
      createElement("div", { "data-tooltip-open": String(Boolean(open)) }, children),
    TooltipProvider: ({
      children,
      delayDuration,
      skipDelayDuration,
    }: {
      children: ReactNode;
      delayDuration?: number;
      skipDelayDuration?: number;
    }) =>
      createElement(
        "div",
        {
          "data-tooltip-delay": delayDuration,
          "data-tooltip-skip-delay": skipDelayDuration,
        },
        children,
      ),
    TooltipTrigger: passthrough,
    TooltipContent: ({ children }: { children: ReactNode }) =>
      createElement("div", { "data-testid": "side-pane-tab-tooltip" }, children),
  };
});

afterEach(cleanup);

const browserTab: WorkspaceSidePaneTab = {
  id: "browser:test",
  type: "browser",
  faviconUrl: null,
  initialUrl: null,
  title: "Docs",
};

const workflowRunTab: Extract<WorkspaceSidePaneTab, { type: "workflow-run" }> = {
  id: "workflow-run:%2Fworkspace:parent:dwfrun-1",
  type: "workflow-run",
  workspaceKey: "/workspace",
  workspacePath: "/workspace",
  parentSessionId: "parent",
  toolCallId: "tool-wf-1",
  runId: "dwfrun-1",
  workflowName: "Three-way review",
};

const workflowActorTab: Extract<WorkspaceSidePaneTab, { type: "workflow-actor-session" }> = {
  id: "workflow-actor-session:%2Fworkspace:parent:dwf-dwfrun-1-actor_1%402",
  type: "workflow-actor-session",
  workspaceKey: "/workspace",
  workspacePath: "/workspace",
  parentSessionId: "parent",
  runId: "dwfrun-1",
  actorSessionId: "dwf-dwfrun-1-actor_1@2",
  siteId: "actor#1",
  ordinal: 2,
  actorName: "reviewer",
};

const workflowWorkspaceTab: Extract<WorkspaceSidePaneTab, { type: "workflow-workspace" }> = {
  id: "workflow-workspace:%2Fworkspace:parent:dwfrun-1",
  type: "workflow-workspace",
  workspaceKey: "/workspace",
  workspacePath: "/workspace",
  parentSessionId: "parent",
  toolCallId: "tool-wf-1",
  runId: "dwfrun-1",
  workflowName: "Three-way review",
};

function renderSidePaneTab(
  isActive: boolean,
  title = "Docs",
  tab: WorkspaceSidePaneTab = browserTab,
) {
  return renderToStaticMarkup(
    createElement(
      Tabs,
      { value: isActive ? tab.id : "other" },
      createElement(
        TabsList,
        null,
        createElement(SortableSidePaneTabTrigger, {
          tab,
          title,
          closeTabLabel: "Close Docs",
          closeTabMenuLabel: "Close tab",
          closeOtherTabsLabel: "Close other tabs",
          closeAllTabsLabel: "Close all tabs",
          diffBadgeLabel: "Diff",
          isActive,
          onActivateTab: vi.fn(),
          onCloseTab: vi.fn(),
          onCloseOtherTabs: vi.fn(),
          onCloseAllTabs: vi.fn(),
          canCloseOtherTabs: false,
        }),
      ),
    ),
  );
}

describe("getPatchFileDisplayTarget", () => {
  it("falls back to patch headers when patch path is /dev/null", () => {
    expect(
      getPatchFileDisplayTarget({
        title: "Diff",
        path: "/dev/null",
        patch:
          "--- /dev/null\n" +
          "+++ b/packages/ui/src/app-shell/SidePaneTabTrigger.tsx\n" +
          "@@\n" +
          "+content",
      }),
    ).toBe("packages/ui/src/app-shell/SidePaneTabTrigger.tsx");
  });

  it("strips unified diff timestamps before file icon detection", () => {
    expect(
      getPatchFileDisplayTarget({
        title: "Diff",
        patch:
          "--- a/packages/ui/src/app-shell/SidePaneTabTrigger.tsx\t2026-04-21\n" +
          "+++ b/packages/ui/src/app-shell/SidePaneTabTrigger.tsx\t2026-04-21\n" +
          "@@\n" +
          "-old\n" +
          "+new",
      }),
    ).toBe("packages/ui/src/app-shell/SidePaneTabTrigger.tsx");
  });

  it("supports quoted git diff paths", () => {
    expect(
      getPatchFileDisplayTarget({
        title: "Diff",
        patch:
          'diff --git "a/packages/ui/src/Demo View.tsx" "b/packages/ui/src/Demo View.tsx"\n' +
          "--- a/packages/ui/src/Demo View.tsx\n" +
          "+++ b/packages/ui/src/Demo View.tsx\n" +
          "@@\n" +
          "-old\n" +
          "+new",
      }),
    ).toBe("packages/ui/src/Demo View.tsx");
  });
});

describe("getSidePaneTabTitle", () => {
  const subagentTab: Extract<WorkspaceSidePaneTab, { type: "subagent-session" }> = {
    id: "subagent-session:workspace:parent:child",
    type: "subagent-session",
    workspaceKey: "/workspace",
    workspacePath: "/workspace",
    parentSessionId: "parent",
    childSessionId: "child",
    subagentType: "Explore",
    title: "Explore project structure",
  };

  it("uses the authoritative subagent title without type or ordinal", () => {
    expect(getSidePaneTabTitle(subagentTab, ({ id }) => id)).toBe("Explore project structure");
  });

  it("falls back to the localized generic label when title is empty", () => {
    expect(
      getSidePaneTabTitle({ ...subagentTab, title: "  " }, ({ id }) =>
        id === "sidePane.subagent" ? "Subagent" : id,
      ),
    ).toBe("Subagent");
  });

  it("appends the auxiliary conversation ordinal to the localized label", () => {
    expect(
      getSidePaneTabTitle(
        {
          id: "selection-side-chat:workspace:parent:child",
          type: "selection-side-chat",
          workspaceKey: "/workspace",
          workspacePath: "/workspace",
          parentSessionId: "parent",
          childSessionId: "child",
          ordinal: 2,
        },
        ({ id }) => (id === "sidePane.selectionChat" ? "Auxiliary conversation" : id),
      ),
    ).toBe("Auxiliary conversation 2");
  });

  it("prefers the frozen workflow name over the generic workflow run label", () => {
    expect(
      getSidePaneTabTitle(workflowRunTab, ({ id }) =>
        id === "sidePane.workflowRun" ? "Workflow run" : id,
      ),
    ).toBe("Three-way review");
  });

  it("falls back to the localized workflow run label when no name was captured", () => {
    const { workflowName: _dropped, ...unnamed } = workflowRunTab;
    expect(
      getSidePaneTabTitle(unnamed, ({ id }) =>
        id === "sidePane.workflowRun" ? "Workflow run" : id,
      ),
    ).toBe("Workflow run");
  });

  it("titles an actor transcript with its name and always with its instance ordinal", () => {
    // Instances of the same lane family share a name (the script wrote `agent("reviewer")` only once), so the ordinal is
    // the only thing in the title that can tell them apart — two "reviewer" tabs on the tab strip would be indistinguishable.
    // The ordinal uses concatenation rather than a localized template: following the selection-side-chat precedent
    // (`${label} ${ordinal}`), the label mapping table therefore stays "id → string" with no interpolation to carry.
    expect(getSidePaneTabTitle(workflowActorTab, ({ id }) => id)).toBe("reviewer #2");
  });

  it("falls back to the localized actor label, still with the ordinal", () => {
    const { actorName: _dropped, ...unnamed } = workflowActorTab;
    expect(
      getSidePaneTabTitle(unnamed, ({ id }) =>
        id === "sidePane.workflowActor" ? "Workflow subagent" : id,
      ),
    ).toBe("Workflow subagent #2");
  });

  it("titles a workspace transcript with the run name: one run, one workspace transcript", () => {
    // docs/dynamic-workflow/transcript-and-notifications.md "Opening the tab": the title is the run name; the type word lives in the tooltip.
    expect(getSidePaneTabTitle(workflowWorkspaceTab, ({ id }) => id)).toBe("Three-way review");
  });

  it("falls back to the localized script label when no name was captured", () => {
    const { workflowName: _dropped, ...unnamed } = workflowWorkspaceTab;
    expect(
      getSidePaneTabTitle(unnamed, ({ id }) =>
        id === "sidePane.workflowScript" ? "Script steps" : id,
      ),
    ).toBe("Script steps");
  });
});

describe("SortableSidePaneTabTrigger", () => {
  it("keeps active state markers on the real side pane tab element", () => {
    const html = renderSidePaneTab(true);
    const tabMarkup = html.match(/<div data-side-pane-tab-id="browser:test"[^>]*>/)?.[0] ?? "";

    // Bugfix: ContextMenuTrigger + TabsTrigger asChild makes the Radix state landing point unstable.
    // The side pane tab's active styling depends on data-active, so the controlled isActive must patch it onto the real DOM.
    expect(tabMarkup).toContain('data-side-pane-tab-id="browser:test"');
    expect(tabMarkup).toMatch(/\sdata-active(=|\s|>)/);
    expect(tabMarkup).toContain('data-state="active"');
  });

  it("does not mark inactive side pane tabs as active", () => {
    const html = renderSidePaneTab(false);
    const tabMarkup = html.match(/<div data-side-pane-tab-id="browser:test"[^>]*>/)?.[0] ?? "";

    expect(tabMarkup).toContain('data-side-pane-tab-id="browser:test"');
    expect(tabMarkup).not.toMatch(/\sdata-active(=|\s|>)/);
    expect(tabMarkup).toContain('data-state="inactive"');
  });

  it("exposes browser residency on the logical tab shell", () => {
    const html = renderSidePaneTab(false, "Browser", {
      ...browserTab,
      residency: "suspended",
    });

    const tabMarkup = html.match(/<div data-side-pane-tab-id="browser:test"[^>]*>/)?.[0] ?? "";
    expect(tabMarkup).toContain('data-browser-tab-residency="suspended"');
  });

  it("loads the browser favicon without leaking the host page referrer", () => {
    const html = renderSidePaneTab(false, "Browser", {
      ...browserTab,
      faviconUrl: "https://example.com/favicon.ico",
    });

    expect(html).toContain('src="https://example.com/favicon.ico"');
    expect(html).toContain('referrerPolicy="no-referrer"');
  });

  it("renders close, close other, and close all context menu actions", () => {
    const html = renderSidePaneTab(true);

    expect(html).toContain("Close tab");
    expect(html).toContain("Close other tabs");
    expect(html).toContain("Close all tabs");
    expect(html).not.toContain('role="separator"');
  });

  it("always renders the close button for active and inactive tabs", () => {
    expect(renderSidePaneTab(true)).toContain('aria-label="Close Docs"');
    expect(renderSidePaneTab(false)).toContain('aria-label="Close Docs"');
  });

  it("closes an inactive tab on middle-click without activating or bubbling it", () => {
    const onActivateTab = vi.fn();
    const onCloseTab = vi.fn();
    const onParentAuxClick = vi.fn();
    const { container } = render(
      createElement(
        "div",
        { onAuxClick: onParentAuxClick },
        createElement(
          Tabs,
          { value: "other" },
          createElement(
            TabsList,
            null,
            createElement(SortableSidePaneTabTrigger, {
              tab: browserTab,
              title: "Docs",
              closeTabLabel: "Close Docs",
              closeTabMenuLabel: "Close tab",
              closeOtherTabsLabel: "Close other tabs",
              closeAllTabsLabel: "Close all tabs",
              diffBadgeLabel: "Diff",
              isActive: false,
              onActivateTab,
              onCloseTab,
              onCloseOtherTabs: vi.fn(),
              onCloseAllTabs: vi.fn(),
              canCloseOtherTabs: false,
            }),
          ),
        ),
      ),
    );
    const tabShell = container.querySelector<HTMLElement>('[data-side-pane-tab-id="browser:test"]');

    expect(tabShell).not.toBeNull();
    const auxclick = new MouseEvent("auxclick", {
      bubbles: true,
      cancelable: true,
      button: 1,
    });
    const preventDefault = vi.spyOn(auxclick, "preventDefault");
    const stopPropagation = vi.spyOn(auxclick, "stopPropagation");
    const notCanceled = tabShell!.dispatchEvent(auxclick);

    expect(notCanceled).toBe(false);
    expect(auxclick.defaultPrevented).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(onCloseTab).toHaveBeenCalledWith(browserTab.id);
    expect(onActivateTab).not.toHaveBeenCalled();
    expect(onParentAuxClick).not.toHaveBeenCalled();
  });

  it("shows the full title through an independently delayed tooltip", () => {
    const html = renderSidePaneTab(true, "A complete tab title");

    expect(html).toContain('data-tooltip-delay="1500"');
    expect(html).toContain('data-tooltip-skip-delay="0"');
    expect(html).toContain('data-testid="side-pane-tab-tooltip"');
    expect(html).toContain("A complete tab title");
  });

  it("uses a 156px preferred width and an equal-shrink 60px minimum", () => {
    const longTitle = "A very long browser tab title that must be truncated";
    const tabHtml = renderSidePaneTab(true, longTitle);
    const overlayHtml = renderToStaticMarkup(
      createElement(SidePaneTabDragOverlay, {
        tab: browserTab,
        title: longTitle,
        diffBadgeLabel: "Diff",
      }),
    );

    expect(tabHtml).toContain("flex-[1_1_9.75rem]");
    expect(tabHtml).toContain("min-w-15");
    expect(tabHtml).toContain("max-w-39");
    expect(tabHtml).toContain("flex-1");
    expect(tabHtml).toContain('data-side-pane-tab-content=""');
    expect(tabHtml).toContain("mask-image");
    expect(tabHtml).not.toMatch(/class="[^"]*\btruncate\b/);
    expect(overlayHtml).toContain("w-39");
    expect(overlayHtml).toContain('data-side-pane-tab-content=""');
    expect(overlayHtml).toContain("mask-image");
    expect(overlayHtml).not.toMatch(/class="[^"]*\btruncate\b/);
  });
});

describe("SidePaneTabTitleTooltip", () => {
  it("preserves the trigger shrink behavior required by responsive tab widths", () => {
    const html = renderToStaticMarkup(
      createElement(
        SidePaneTabTitleTooltip,
        { isDragging: false, title: "Docs" },
        createElement("div", { "data-testid": "responsive-tab-trigger" }),
      ),
    );
    const triggerMarkup = html.match(/<div data-testid="responsive-tab-trigger"[^>]*>/)?.[0] ?? "";

    expect(triggerMarkup).toContain('class="shrink"');
    expect(triggerMarkup).not.toContain("shrink-0");
  });
});

describe("SidePaneTabIcon browser-use operation state", () => {
  it("temporarily replaces the favicon with an animated mouse pointer", () => {
    const html = renderToStaticMarkup(
      createElement(SidePaneTabIcon, {
        tab: {
          id: "browser-use:tab-1",
          type: "browser-use",
          sessionId: "sess-1",
          tabId: "tab-1",
          workspaceKey: "/workspace",
          faviconUrl: "https://example.com/favicon.ico",
          browserUseOperationUntil: Date.now() + 5_000,
        },
      }),
    );

    expect(html).toContain('data-browser-use-operation-indicator="active"');
    expect(html).toContain("browser-use-operation-breathe");
    expect(html).not.toContain("motion-safe:animate-pulse");
    expect(html).not.toContain("https://example.com/favicon.ico");
  });

  it("restores the real favicon after the operation deadline", () => {
    const html = renderToStaticMarkup(
      createElement(SidePaneTabIcon, {
        tab: {
          id: "browser-use:tab-1",
          type: "browser-use",
          sessionId: "sess-1",
          tabId: "tab-1",
          workspaceKey: "/workspace",
          faviconUrl: "https://example.com/favicon.ico",
          browserUseOperationUntil: Date.now() - 1,
        },
      }),
    );

    expect(html).not.toContain("data-browser-use-operation-indicator");
    expect(html).toContain("https://example.com/favicon.ico");
  });
});

// Bug cause: the plan-detail tab is opened by the switch-mode (ExitPlanMode) tool call card,
// and the source card uses NotepadTextIcon. The tab icon previously misused ListChecksIcon, causing the icon
// to jump when the user clicked the card to open the tab, and ListChecksIcon clashed with the status panel's Todo section icon.
// Convention pinned here: the plan-detail tab icon must match the source card — NotepadTextIcon.
describe("SidePaneTabIcon plan-detail", () => {
  it("uses NotepadTextIcon to match the switch-mode source card", () => {
    const html = renderToStaticMarkup(
      createElement(SidePaneTabIcon, {
        tab: {
          id: "plan-detail:test",
          type: "plan-detail",
          workspaceKey: "/workspace",
          workspacePath: "/workspace",
          parentSessionId: "parent",
          toolCallId: "tool-1",
          markdown: "# Plan",
        },
      }),
    );

    expect(html).toContain("lucide-notepad-text");
    // Prevent falling back to ListChecksIcon, which clashes with Todo
    expect(html).not.toContain("lucide-list-checks");
  });
});

// Same convention: the workflow-run tab is opened by the CreateWorkflow tool card, whose source card uses the lucide Workflow
// icon; the tab must match it, otherwise the icon jumps when clicking the card into the detail view.
describe("SidePaneTabIcon workflow-run", () => {
  it("uses the same Workflow icon as the CreateWorkflow source card", () => {
    const html = renderToStaticMarkup(createElement(SidePaneTabIcon, { tab: workflowRunTab }));

    expect(html).toContain("lucide-workflow");
  });
});

// An actor transcript is "one actor's conversation record", so it can use neither the run's Workflow icon
// (that is the whole run) nor the subagent's Bot icon — on the tab strip those two conversation kinds are
// indistinguishable, yet their visibility and recycling semantics are completely different.
describe("SidePaneTabIcon workflow-actor-session", () => {
  it("is visually distinct from both the run tab and a subagent tab", () => {
    const html = renderToStaticMarkup(createElement(SidePaneTabIcon, { tab: workflowActorTab }));

    expect(html).toContain("lucide-bot-message-square");
    expect(html).not.toContain("lucide-workflow");
  });
});

// A script transcript is "what this run did to the workspace", so it uses the terminal icon: neither the run's Workflow
// (the whole run) nor an actor's chat bubble (that is a subagent's transcript).
describe("SidePaneTabIcon workflow-workspace", () => {
  it("uses the terminal icon, distinct from run and actor tabs", () => {
    const html = renderToStaticMarkup(
      createElement(SidePaneTabIcon, { tab: workflowWorkspaceTab }),
    );
    expect(html).toContain("lucide-terminal");
    expect(html).not.toContain("lucide-workflow");
    expect(html).not.toContain("lucide-bot-message-square");
  });
});
