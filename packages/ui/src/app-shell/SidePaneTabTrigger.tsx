/* oxlint-disable eslint(max-lines) -- The side-pane tab trigger centralizes drag and drop, context menus, and icons; this change only adds a test attribute for the Browser resident state, without splitting existing interactions to reduce line count. */
import { useRef, type CSSProperties } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  BotIcon,
  BotMessageSquareIcon,
  BugIcon,
  FileCode2Icon,
  FileDiffIcon,
  MapIcon,
  MessageSquareTextIcon,
  ListTreeIcon,
  PlugIcon,
  NotepadTextIcon,
  PackageIcon,
  PaletteIcon,
  ShieldCheckIcon,
  SquareTerminalIcon,
  TerminalIcon,
  WaypointsIcon,
  Workflow as WorkflowIcon,
  XIcon,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { TabsTrigger } from "@/components/ui/tabs.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import type { WorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";
import { Button } from "@/components/ui/button.js";
import { BrowserUseTabIcon } from "@/app-shell/BrowserUseTabIcon.js";
import { BrowserTabFavicon } from "@/app-shell/BrowserTabFavicon.js";
import { SidePaneTabTitleTooltip } from "@/app-shell/SidePaneTabTitleTooltip.js";

// Tabs default to equal 156px widths; when space is limited, the same grow/shrink parameters reduce them evenly to 60px,
// after which the outer scroll container handles overflow so title length does not change each tab's width.
// Without a separate title limit, long web page titles keep expanding the tab; both the main tab and drag overlay constrain only the title itself so it does not crowd the icon, badge, or close button.
export function SortableSidePaneTabTrigger({
  tab,
  title,
  closeTabLabel,
  closeTabMenuLabel,
  closeOtherTabsLabel,
  closeAllTabsLabel,
  diffBadgeLabel,
  isActive,
  onActivateTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseAllTabs,
  canCloseOtherTabs,
}: {
  tab: WorkspaceSidePaneTab;
  title: string;
  closeTabLabel: string;
  closeTabMenuLabel: string;
  closeOtherTabsLabel: string;
  closeAllTabsLabel: string;
  diffBadgeLabel: string;
  isActive: boolean;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCloseOtherTabs: (tabId: string) => void;
  onCloseAllTabs: () => void;
  canCloseOtherTabs: boolean;
}) {
  const wasDraggingRef = useRef(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
  });
  const normalizedTransform = transform
    ? {
        ...transform,
        // Horizontal tabs have a fixed height; dragging allows horizontal movement only.
        // dnd-kit carries scale information; clamp it back to 1 so the tab is not temporarily compressed or stretched.
        scaleX: 1,
        scaleY: 1,
      }
    : null;
  const style: CSSProperties = {
    transform: CSS.Transform.toString(normalizedTransform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.85 : 1,
  };

  if (isDragging) {
    wasDraggingRef.current = true;
  }

  const tabTrigger = (
    <TabsTrigger value={tab.id} asChild>
      <div
        ref={setNodeRef}
        data-side-pane-tab-id={tab.id}
        data-browser-tab-residency={"residency" in tab ? tab.residency : undefined}
        data-active={isActive ? "" : undefined}
        data-state={isActive ? "active" : "inactive"}
        style={style}
        {...attributes}
        {...listeners}
        onPointerDown={(event) => {
          listeners?.onPointerDown?.(event);
          // Side-pane tabs have a separate close button, so the outer element must not also render as a button.
          // Otherwise, buttons would be nested; browsers repair the DOM in production builds, misrouting tab/close/drag events.
          // Use TabsTrigger asChild to carry Radix state, render the actual DOM element as a div, and keep the close control a native button.
          event.preventDefault();
        }}
        onClick={(event) => {
          // Browsers may dispatch both click and auxclick for a middle click; intercept during click first,
          // to avoid activating an inactive tab before closing it.
          if (event.button === 1) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }

          if (wasDraggingRef.current) {
            wasDraggingRef.current = false;
            event.preventDefault();
            return;
          }

          onActivateTab(tab.id);
        }}
        onAuxClick={(event) => {
          if (event.button !== 1) return;

          // Side Pane tabs previously supported only left-click activation and an explicit close button. A middle click would trigger
          // the browser's default auto-scroll, and some browsers would activate the tab first. Cancel the default behavior during auxclick
          // and close the target tab while keeping the current active tab unchanged.
          event.preventDefault();
          event.stopPropagation();
          onCloseTab(tab.id);
        }}
        className={cn(
          "group relative inline-flex items-center gap-1",
          "flex-[1_1_9.75rem] !h-7 min-w-15 max-w-39 justify-start overflow-hidden rounded-md border px-1.5 pr-2 text-ui-base font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring",
          "!border-transparent !bg-transparent text-foreground-subtle !rounded-lg",
          "hover:text-foreground",
          !isActive && "hover:!bg-hover",
          // After TabsTrigger asChild is wrapped by ContextMenuTrigger, Radix's active marker does not reliably reach the actual tab div.
          // Synchronize data-active / data-state from the controlled isActive value here so Tailwind's active variant matches.
          "data-active:!bg-selected data-active:text-foreground",
          "cursor-default",
          isDragging && "cursor-grabbing shadow-md",
        )}
      >
        <SidePaneTabItemContent
          tab={tab}
          title={title}
          diffBadgeLabel={diffBadgeLabel}
          closeVisible={isActive}
          revealCloseOnHover
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={closeTabLabel}
          className={cn(
            "absolute right-1 top-1/2 -translate-y-1/2 rounded-md",
            !isActive &&
              "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
          )}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onCloseTab(tab.id);
          }}
        >
          <XIcon className="size-3" />
        </Button>
      </div>
    </TabsTrigger>
  );

  return (
    <ContextMenu>
      <SidePaneTabTitleTooltip isDragging={isDragging} title={title}>
        <ContextMenuTrigger asChild>{tabTrigger}</ContextMenuTrigger>
      </SidePaneTabTitleTooltip>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onSelect={() => onCloseTab(tab.id)}>{closeTabMenuLabel}</ContextMenuItem>
        <ContextMenuItem disabled={!canCloseOtherTabs} onSelect={() => onCloseOtherTabs(tab.id)}>
          {closeOtherTabsLabel}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onCloseAllTabs}>{closeAllTabsLabel}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function SidePaneTabDragOverlay({
  tab,
  title,
  diffBadgeLabel,
}: {
  tab: WorkspaceSidePaneTab;
  title: string;
  diffBadgeLabel: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex !h-7 w-39 min-w-15 max-w-39 items-center justify-start gap-1.5 whitespace-nowrap rounded-lg border border-transparent bg-selected px-1.5 pr-1 text-ui-base font-medium text-foreground shadow-md",
        "cursor-grabbing",
      )}
    >
      <SidePaneTabItemContent tab={tab} title={title} diffBadgeLabel={diffBadgeLabel} />
    </div>
  );
}

function SidePaneTabItemContent({
  tab,
  title,
  diffBadgeLabel,
  closeVisible = false,
  revealCloseOnHover = false,
}: {
  tab: WorkspaceSidePaneTab;
  title: string;
  diffBadgeLabel: string;
  closeVisible?: boolean;
  revealCloseOnHover?: boolean;
}) {
  return (
    <span
      data-side-pane-tab-content=""
      className={cn(
        "flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,black_calc(100%-var(--tab-fade-offset)-0.5rem),transparent_calc(100%-var(--tab-fade-offset)))]",
        closeVisible ? "[--tab-fade-offset:1.25rem]" : "[--tab-fade-offset:0px]",
        revealCloseOnHover &&
          "group-hover:[--tab-fade-offset:1.25rem] group-focus-within:[--tab-fade-offset:1.25rem]",
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <SidePaneTabIcon tab={tab} />
      </span>
      <span data-side-pane-tab-title="" className="shrink-0 whitespace-nowrap">
        {title}
      </span>
      {isDiffPreviewTab(tab) ? (
        <span className="ml-0.5 shrink-0 rounded-full border border-border bg-surface px-1 py-0 text-ui-xs leading-3 text-foreground-subtle">
          {diffBadgeLabel}
        </span>
      ) : null}
    </span>
  );
}

function isDiffPreviewTab(tab: WorkspaceSidePaneTab): boolean {
  return (
    tab.type === "code-viewer" &&
    (tab.source.type === "patch" || tab.source.type === "multi-file-diff")
  );
}

export function SidePaneTabIcon({ tab }: { tab: WorkspaceSidePaneTab }) {
  // The plan-detail tab is opened by a switch-mode (ExitPlanMode) tool-call card. The source card uses NotepadTextIcon;
  // the tab must match it to avoid an icon change after clicking. Do not use ListChecksIcon:
  // it would reuse the Todo section icon from the status panel and suggest a todo list rather than a plan document.
  if (tab.type === "plan-detail") {
    return <NotepadTextIcon className="size-3.5" />;
  }
  if (tab.type === "plugin-ui") {
    return <PlugIcon className="size-3.5" />;
  }
  // Same convention: the source card (CreateWorkflow) uses the Lucide Workflow icon, so the tab must match it.
  if (tab.type === "workflow-run") {
    return <WorkflowIcon className="size-3.5" />;
  }
  // The run directory and an individual run's details must be easy to distinguish (a list of entries vs. one execution), so reuse the subagent directory's
  // same directory icon: both directory pages then share a tab icon, which reflects their common role.
  if (tab.type === "workflow-directory") {
    return <ListTreeIcon className="size-3.5" />;
  }
  // An actor transcript is “one actor's conversation record”: neither the whole run (Workflow) nor a subagent
  // session (Bot). The three must be distinguishable in the tab bar because their visibility and cleanup semantics differ.
  if (tab.type === "workflow-actor-session") {
    return <BotMessageSquareIcon className="size-3.5" />;
  }
  // The script transcript and script pill use the same terminal glyph, so the source and tab match without an icon change on open.
  if (tab.type === "workflow-workspace") {
    return <TerminalIcon className="size-3.5" />;
  }
  // Changing the artifact tab icon **by kind** is wrong: tab-bar icons must be stable before opening (when a tab is restored from memory,
  // its metadata may not have loaded yet). Use one fixed artifact icon and leave kind distinctions to the tab header and card.
  if (tab.type === "workflow-artifact") {
    return <PackageIcon className="size-3.5" />;
  }
  if (tab.type === "selection-side-chat") {
    return <MessageSquareTextIcon className="size-3.5" />;
  }
  if (tab.type === "subagent-session") {
    return <BotIcon className="size-3.5" />;
  }

  if (tab.type === "subagent-directory") {
    return <ListTreeIcon className="size-3.5" />;
  }

  if (tab.type === "browser") {
    return <BrowserTabFavicon faviconUrl={tab.faviconUrl} />;
  }

  if (tab.type === "browser-permissions") {
    return <ShieldCheckIcon className="size-3.5" />;
  }

  if (tab.type === "git") {
    return <FileDiffIcon className="size-3.5" />;
  }

  if (tab.type === "treemapping") {
    return <MapIcon className="size-3.5" />;
  }

  if (tab.type === "whiteboard") {
    return <PaletteIcon className="size-3.5" />;
  }

  if (tab.type === "model-trajectory") {
    return <WaypointsIcon className="size-3.5" />;
  }

  if (tab.type === "developer-tools") {
    return <BugIcon className="size-3.5" />;
  }

  if (tab.type === "terminal" || tab.type === "bash-output") {
    return <SquareTerminalIcon className="size-3.5" />;
  }

  // Same as getSidePaneTabTitle: browser-use tabs have no source, so without this guard the code would fall through
  // to `tab.source.type` below and crash while reading type from undefined.
  // After agent navigation, the <webview> favicon event fills in faviconUrl so the tab shows the actual icon, matching human browser tabs;
  // use the globe icon as a fallback when unavailable (about:blank or not yet fetched).
  if (tab.type === "browser-use") {
    return <BrowserUseTabIcon tab={tab} />;
  }

  if (tab.source.type === "patch") {
    const fileDisplayTarget = getPatchFileDisplayTarget(tab.source);
    if (fileDisplayTarget) {
      const descriptor = resolveFileDisplayDescriptor(fileDisplayTarget);
      return <FileDisplayIcon src={descriptor.fileIconSrc} size={14} className="shrink-0" />;
    }

    return <FileDiffIcon className="size-3.5" />;
  }

  if (tab.source.type === "multi-file-diff") {
    if (tab.source.path) {
      const descriptor = resolveFileDisplayDescriptor(tab.source.path);
      return <FileDisplayIcon src={descriptor.fileIconSrc} size={14} className="shrink-0" />;
    }

    return <FileDiffIcon className="size-3.5" />;
  }

  if (tab.source.path) {
    const descriptor = resolveFileDisplayDescriptor(tab.source.path);
    return <FileDisplayIcon src={descriptor.fileIconSrc} size={14} className="shrink-0" />;
  }

  return <FileCode2Icon className="size-3.5" />;
}

function isUsablePatchFileTarget(target: string | null | undefined): target is string {
  const trimmedTarget = target?.trim();
  return Boolean(trimmedTarget && trimmedTarget !== "/dev/null");
}

function unquoteDiffPath(path: string): string {
  const trimmedPath = path.trim();
  if (trimmedPath.length >= 2 && trimmedPath.startsWith('"') && trimmedPath.endsWith('"')) {
    return trimmedPath.slice(1, -1);
  }

  return trimmedPath;
}

function stripDiffPathPrefix(path: string): string {
  const unquotedPath = unquoteDiffPath(path);
  if (unquotedPath.startsWith("a/") || unquotedPath.startsWith("b/")) {
    return unquotedPath.slice(2);
  }

  return unquotedPath;
}

function parseDiffHeaderPath(headerValue: string): string | null {
  const trimmedValue = headerValue.trim();
  if (!trimmedValue) {
    return null;
  }

  if (trimmedValue.startsWith('"')) {
    const quotedPathMatch = trimmedValue.match(/^"((?:\\.|[^"\\])+)"/);
    return quotedPathMatch?.[1] ? stripDiffPathPrefix(quotedPathMatch[1]) : null;
  }

  const pathWithoutTimestamp = trimmedValue.split("\t", 1)[0]?.trim();
  return pathWithoutTimestamp ? stripDiffPathPrefix(pathWithoutTimestamp) : null;
}

function parseDiffGitLinePath(line: string): string | null {
  const gitPathMatch = line.match(
    /^diff --git (?:"((?:\\.|[^"\\])*)"|(\S+)) (?:"((?:\\.|[^"\\])*)"|(\S+))$/,
  );
  const nextPath = gitPathMatch?.[3] ?? gitPathMatch?.[4];
  const previousPath = gitPathMatch?.[1] ?? gitPathMatch?.[2];
  const normalizedNextPath = nextPath ? stripDiffPathPrefix(nextPath) : null;
  if (isUsablePatchFileTarget(normalizedNextPath)) {
    return normalizedNextPath;
  }

  const normalizedPreviousPath = previousPath ? stripDiffPathPrefix(previousPath) : null;
  return isUsablePatchFileTarget(normalizedPreviousPath) ? normalizedPreviousPath : null;
}

function getPatchHeaderFileDisplayTarget(patch: string): string | null {
  for (const line of patch.split(/\r?\n/)) {
    const diffGitTarget = parseDiffGitLinePath(line);
    if (diffGitTarget) {
      return diffGitTarget;
    }

    if (line.startsWith("+++ ")) {
      const nextFileTarget = parseDiffHeaderPath(line.slice(4));
      if (isUsablePatchFileTarget(nextFileTarget)) {
        // Some file diff sources have no path, and the title may be only “Diff”.
        // Read the actual filename from the unified diff header, then pass it to fileDisplay to resolve the file-type icon.
        return nextFileTarget;
      }
    }
  }

  for (const line of patch.split(/\r?\n/)) {
    if (!line.startsWith("--- ")) {
      continue;
    }

    const previousFileTarget = parseDiffHeaderPath(line.slice(4));
    if (isUsablePatchFileTarget(previousFileTarget)) {
      return previousFileTarget;
    }
  }

  return null;
}

export function getPatchFileDisplayTarget(source: {
  path?: string;
  title: string;
  patch: string;
}): string | null {
  if (isUsablePatchFileTarget(source.path)) {
    return source.path;
  }

  const patchHeaderTarget = getPatchHeaderFileDisplayTarget(source.patch);
  if (patchHeaderTarget) {
    return patchHeaderTarget;
  }

  // Diffs for added/deleted files may pass /dev/null as source.path.
  // /dev/null is not a product filename and would always resolve to the document icon; fall back to the title only when the path is invalid.
  return isUsablePatchFileTarget(source.title) ? source.title : null;
}

export function getSidePaneTabTitle(
  tab: WorkspaceSidePaneTab,
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string,
): string {
  if (tab.type === "plan-detail") {
    return formatMessage({ id: "planTool.panel.planTab" });
  }
  // The display name is a fallback frozen when the card opens; run identity always comes from runId (the portion in the tab id).
  if (tab.type === "workflow-run") {
    return tab.workflowName?.trim() || formatMessage({ id: "sidePane.workflowRun" });
  }
  if (tab.type === "workflow-directory") {
    return formatMessage({ id: "sidePane.workflowDirectory" });
  }
  // Keep the instance number in the title: instances in the same lane family share the name from the script, so without the number the tab bar would show
  // two indistinguishable “reviewer” tabs. Concatenate instead of using a localized template, following the selection-side-chat precedent.
  if (tab.type === "workflow-actor-session") {
    const name = tab.actorName?.trim() || formatMessage({ id: "sidePane.workflowActor" });
    return `${name} #${tab.ordinal}`;
  }
  // The title is the run name (one script transcript per run); the type label "Script steps" appears in the tooltip.
  if (tab.type === "workflow-workspace") {
    return tab.workflowName?.trim() || formatMessage({ id: "sidePane.workflowScript" });
  }
  // The display name is a fallback frozen when opened; artifact identity is always (runId, artifactId), the two parts of the tab ID.
  if (tab.type === "workflow-artifact") {
    return (
      tab.title?.trim() || tab.artifactId || formatMessage({ id: "sidePane.workflowArtifact" })
    );
  }
  if (tab.type === "selection-side-chat") {
    return `${formatMessage({ id: "sidePane.selectionChat" })} ${tab.ordinal}`;
  }
  if (tab.type === "subagent-session") {
    return tab.title?.trim() || formatMessage({ id: "sidePane.subagent" });
  }

  if (tab.type === "subagent-directory") {
    return formatMessage({ id: "sidePane.subagentDirectory" });
  }

  if (tab.type === "browser") {
    const pageTitle = tab.title?.trim();
    return pageTitle || formatMessage({ id: "browser.title" });
  }

  if (tab.type === "browser-permissions") {
    return formatMessage({ id: "browser.permission.settings" });
  }

  if (tab.type === "git") {
    return formatMessage({ id: "sidePane.review" });
  }

  if (tab.type === "treemapping") {
    return formatMessage({ id: "treemapping.title" });
  }

  if (tab.type === "whiteboard") {
    return tab.title || formatMessage({ id: "whiteboard.title" });
  }

  if (tab.type === "model-trajectory") {
    return tab.title?.trim() || formatMessage({ id: "modelTrajectory.title" });
  }

  if (tab.type === "developer-tools") {
    return formatMessage({ id: "developerTools.title" });
  }

  if (tab.type === "terminal" || tab.type === "bash-output") {
    return tab.title || formatMessage({ id: "terminal.title" });
  }

  // browser-use tabs were not handled here and fell through to `tab.source.title` below.
  // These tabs have no source field, so reading undefined.title crashed React and took down the workspace subtree.
  // Use the page title (filled by getState after the agent navigates), falling back to the browser.title copy.
  if (tab.type === "browser-use") {
    return tab.title?.trim() || formatMessage({ id: "browser.title" });
  }

  if (tab.type === "plugin-ui") {
    return tab.title.trim() || formatMessage({ id: "sidePane.pluginUi" });
  }

  return tab.source.title || formatMessage({ id: "codeViewer.title" });
}
