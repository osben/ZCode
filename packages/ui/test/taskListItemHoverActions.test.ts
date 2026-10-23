import { act, createElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";

type TestEvent = {
  bubbles?: boolean;
  currentTarget?: TestElement;
  relatedTarget?: unknown;
  target?: TestElement;
  type: string;
};

type TestEventHandler = (event: TestEvent) => void;

type TestElement = Element & {
  __attrs: Map<string, string>;
  __listeners: Map<string, TestEventHandler[]>;
  childNodes: TestElement[];
  dispatchEvent: (event: TestEvent) => boolean;
  parentNode: TestElement | null;
};

const {
  contextMenuMounts,
  contextMenuOpenChangeHandlers,
  contextActionsCalls,
  leadingIndicatorState,
  formatRelativeTimeCalls,
  tooltipCalls,
  rootTooltipProps,
  triggerChildren,
  stableIntl,
} = vi.hoisted(() => ({
  contextMenuMounts: [] as Array<Record<string, unknown>>,
  contextMenuOpenChangeHandlers: [] as Array<(open: boolean) => void>,
  contextActionsCalls: [] as Array<Record<string, unknown>>,
  leadingIndicatorState: { value: "none" },
  formatRelativeTimeCalls: [] as number[],
  tooltipCalls: [] as Array<Record<string, unknown>>,
  rootTooltipProps: [] as Array<Record<string, unknown>>,
  triggerChildren: [] as ReactElement[],
  stableIntl: {
    formatMessage: ({ id }: { id: string }) => id,
  },
}));

vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    createElement("svg", { "data-icon": name, ...props });

  return {
    ...actual,
    Archive: createIcon("archive"),
    Cloud: createIcon("cloud"),
    CloudUpload: createIcon("cloud-upload"),
    Clock: createIcon("clock"),
    Cpu: createIcon("cpu"),
    FileDiff: createIcon("file-diff"),
    Folder: createIcon("folder"),
    GitBranch: createIcon("git-branch"),
    GitMerge: createIcon("git-merge"),
    LoaderIcon: createIcon("loader"),
    Pin: createIcon("pin"),
    Smartphone: createIcon("smartphone"),
  };
});

vi.mock("@/components/ui/badge.js", () => ({
  Badge: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
}));

vi.mock("@/components/ui/tooltip.js", () => ({
  TooltipProvider: ({ children }: { children?: ReactNode }) => children,
  Tooltip: (props: { children?: ReactNode }) => {
    rootTooltipProps.push(props as Record<string, unknown>);
    return props.children;
  },
  TooltipTrigger: ({ children }: { children?: ReactNode }) => children,
  TooltipContent: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children?: ReactNode }) =>
    createElement("button", props, children),
}));

vi.mock("@/components/ui/context-menu.js", () => ({
  ContextMenu: ({
    children,
    onOpenChange,
  }: {
    children?: ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => {
    if (onOpenChange) {
      contextMenuOpenChangeHandlers.push(onOpenChange);
    }
    return createElement("div", null, children);
  },
  ContextMenuTrigger: ({ children }: { children: ReactElement }) => {
    triggerChildren.push(children);
    return children;
  },
}));

vi.mock("@/lib/taskListItemPresentation.js", () => ({
  deriveTaskLeadingIndicator: () => leadingIndicatorState.value,
  // The row label subscribes to the shared minute ticker; a static clock keeps the mock inert.
  useNowMinute: () => 0,
  formatTaskRelativeTime: (updatedAt: number) => {
    formatRelativeTimeCalls.push(updatedAt);
    return "now";
  },
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children, ...props }: { children?: ReactNode }) => {
    tooltipCalls.push(props);
    return createElement("span", null, children);
  },
}));

vi.mock("@/TaskListItemContextMenu.js", () => ({
  TaskListItemContextMenu: (props: Record<string, unknown>) => {
    contextMenuMounts.push(props);
    return createElement("div", { "data-testid": "task-context-menu" });
  },
}));

vi.mock("@/useTaskListItemContextActions.js", () => ({
  useTaskListItemContextActions: (params: Record<string, unknown>) => {
    contextActionsCalls.push(params);
    return {
      fileManagerLabel: "Finder",
      handleCopyText: vi.fn(),
      handleOpenProviderConfig: vi.fn(),
      handleOpenTaskPathInFileManager: vi.fn(),
      providerConfigFile: { exists: false, loading: false, path: null },
      taskNativeSessionLogFile: { exists: false, loading: false, path: null },
      taskSessionFile: { exists: false, loading: false, path: null },
    };
  },
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => null,
}));

vi.mock("@/feedback/feedbackStore.js", () => ({
  useFeedbackStore: (selector: (state: { openSubmit: () => void }) => unknown) =>
    selector({ openSubmit: vi.fn() }),
}));

vi.mock("@/store/modelTrajectoryStore.js", () => ({
  useModelTrajectoryStore: {
    getState: () => ({
      requestOpen: vi.fn(),
    }),
  },
}));

vi.mock("@/components/ui/toast.js", () => ({
  toast: () => {},
}));

vi.mock("@/store/zcodeSessionStore.js", async () => {
  const actual = await vi.importActual<typeof import("@/store/zcodeSessionStore.js")>(
    "@/store/zcodeSessionStore.js",
  );
  return {
    ...actual,
    getTaskRuntimeState: () => "idle",
    getTaskUnreadIndicator: () => false,
    hasTaskPendingHumanInterventionRequest: () => false,
    hasTaskPendingPermissionRequest: () => false,
    selectWorkspaceZCodeState: () => ({}),
    useZCodeSessionStore: (selector: (state: Record<string, unknown>) => unknown) => selector({}),
  };
});

function createTask(): ZCodeTaskMeta {
  return {
    createdAt: 1,
    mode: "default",
    provider: "codex",
    taskId: "task-1",
    title: "Task 1",
    traceId: "trace-1",
    updatedAt: 2,
    workspacePath: "/workspace",
  };
}

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    __attrs: new Map<string, string>(),
    __listeners: new Map<string, TestEventHandler[]>(),
    addEventListener: (type: string, handler: TestEventHandler) => {
      const handlers = element.__listeners.get(type) ?? [];
      handlers.push(handler);
      element.__listeners.set(type, handlers);
    },
    appendChild: (child: TestElement) => {
      child.parentNode = element as unknown as TestElement;
      element.childNodes.push(child);
      return child;
    },
    childNodes: [] as TestElement[],
    dispatchEvent: (event: TestEvent) => {
      event.target ??= element as unknown as TestElement;
      let current: TestElement | null = element as unknown as TestElement;
      while (current) {
        event.currentTarget = current;
        for (const handler of current.__listeners.get(event.type) ?? []) {
          handler(event);
        }
        if (!event.bubbles) {
          break;
        }
        current = current.parentNode;
      }
      return true;
    },
    getAttribute: (name: string) => element.__attrs.get(name) ?? null,
    insertBefore: (child: TestElement, beforeChild?: TestElement | null) => {
      child.parentNode = element as unknown as TestElement;
      const beforeIndex = beforeChild ? element.childNodes.indexOf(beforeChild) : -1;
      if (beforeIndex >= 0) {
        element.childNodes.splice(beforeIndex, 0, child);
      } else {
        element.childNodes.push(child);
      }
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as TestElement | null,
    querySelector: (selector: string) => {
      const attributeMatch = /^\[([^=\]]+)(?:=[^\]]+)?\]$/u.exec(selector);
      if (!attributeMatch) {
        return null;
      }
      return findByAttribute(element as unknown as TestElement, attributeMatch[1]);
    },
    removeAttribute: (name: string) => {
      element.__attrs.delete(name);
    },
    removeChild: (child: TestElement) => {
      element.childNodes = element.childNodes.filter((item) => item !== child);
      child.parentNode = null;
      return child;
    },
    removeEventListener: (type: string, handler: TestEventHandler) => {
      element.__listeners.set(
        type,
        (element.__listeners.get(type) ?? []).filter((item) => item !== handler),
      );
    },
    setAttribute: (name: string, value: string) => {
      element.__attrs.set(name, String(value));
    },
    style: {},
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as TestElement;
}

function findByAttribute(node: TestElement, attributeName: string) {
  if (node.__attrs?.has(attributeName)) {
    return node;
  }
  for (const child of node.childNodes ?? []) {
    const match = findByAttribute(child, attributeName);
    if (match) {
      return match;
    }
  }
  return null;
}

function findByAttributeValue(node: TestElement, attributeName: string, attributeValue: string) {
  if (node.__attrs?.get(attributeName) === attributeValue) {
    return node;
  }
  for (const child of node.childNodes ?? []) {
    const match = findByAttributeValue(child, attributeName, attributeValue);
    if (match) {
      return match;
    }
  }
  return null;
}

function installMinimalDom(hoverNone = false) {
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document;
  const windowMock = {
    addEventListener: () => {},
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    matchMedia: () => ({ matches: hoverNone }),
    Node: function Node() {},
    removeEventListener: () => {},
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentMock,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowMock,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return createMinimalElement(documentMock);
}

describe("TaskListItem hover action rendering", () => {
  afterEach(() => {
    contextMenuMounts.length = 0;
    contextMenuOpenChangeHandlers.length = 0;
    contextActionsCalls.length = 0;
    leadingIndicatorState.value = "none";
    formatRelativeTimeCalls.length = 0;
    tooltipCalls.length = 0;
    rootTooltipProps.length = 0;
    triggerChildren.length = 0;
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps idle rows free of per-row context menu and hover-only archive tooltip", async () => {
    const { MemoTaskItem } = await import("@/TaskListItem.js");
    const root: Root = createRoot(installMinimalDom());

    act(() => {
      root.render(
        createElement(MemoTaskItem, {
          intl: stableIntl,
          isActive: false,
          isArchiveConfirming: false,
          isPinned: false,
          onArchiveTask: vi.fn(),
          onArchiveTaskInline: vi.fn(),
          onCancelArchiveConfirm: vi.fn(),
          onMarkTaskAsUnread: vi.fn(),
          onSelectTask: vi.fn(),
          onStartRenameTask: vi.fn(),
          onTogglePinTask: vi.fn(),
          task: createTask(),
          workspacePath: "/workspace",
        }),
      );
    });

    expect(contextMenuOpenChangeHandlers).toHaveLength(0);
    expect(contextMenuMounts).toHaveLength(0);
    expect(contextActionsCalls).toHaveLength(0);
    expect(tooltipCalls).toHaveLength(0);

    act(() => {
      root.unmount();
    });
  });

  it("keeps the row Tooltip open prop boolean when hoverEnabled flips on a mounted row", async () => {
    const { MemoTaskItem } = await import("@/TaskListItem.js");
    const root: Root = createRoot(installMinimalDom());
    const renderRow = (hoverEnabled: boolean) =>
      act(() => {
        root.render(
          createElement(MemoTaskItem, {
            hoverEnabled,
            intl: stableIntl,
            isActive: false,
            isArchiveConfirming: false,
            isPinned: false,
            onArchiveTask: vi.fn(),
            onArchiveTaskInline: vi.fn(),
            onCancelArchiveConfirm: vi.fn(),
            onMarkTaskAsUnread: vi.fn(),
            onSelectTask: vi.fn(),
            onStartRenameTask: vi.fn(),
            onTogglePinTask: vi.fn(),
            task: createTask(),
            workspacePath: "/workspace",
          }),
        );
      });

    // Radix warns when `open` switches between undefined and a boolean; every render must hand it a boolean.
    renderRow(true);
    renderRow(false);
    renderRow(true);

    expect(rootTooltipProps.length).toBeGreaterThan(0);
    expect(rootTooltipProps.map((props) => typeof props.open)).toEqual(
      rootTooltipProps.map(() => "boolean"),
    );

    act(() => {
      root.unmount();
    });
  });

  it("触屏常驻 actions 时仍保留 task 元信息", async () => {
    const { MemoTaskItem } = await import("@/TaskListItem.js");
    const container = installMinimalDom(true);
    const root: Root = createRoot(container);
    leadingIndicatorState.value = "unread";

    act(() => {
      root.render(
        createElement(MemoTaskItem, {
          intl: stableIntl,
          isActive: false,
          isArchiveConfirming: false,
          isPinned: false,
          onArchiveTask: vi.fn(),
          onArchiveTaskInline: vi.fn(),
          onCancelArchiveConfirm: vi.fn(),
          onMarkTaskAsUnread: vi.fn(),
          onSelectTask: vi.fn(),
          onStartRenameTask: vi.fn(),
          onTogglePinTask: vi.fn(),
          task: createTask(),
          workspacePath: "/workspace",
        }),
      );
    });

    expect(findByAttribute(container, "data-task-row-actions")).not.toBeNull();
    const metadata = findByAttribute(container, "data-task-row-metadata");
    expect(metadata).not.toBeNull();
    expect(metadata?.__attrs.get("class")).not.toContain("hidden");
    const unreadIndicator = findByAttribute(container, "data-unread-indicator");
    expect(unreadIndicator).not.toBeNull();
    expect(unreadIndicator?.parentNode?.__attrs.get("class")).not.toContain("hidden");

    act(() => {
      root.unmount();
    });
  });

  it("restores a mobile-active task's run-state indicator when hover actions replace the phone marker", async () => {
    const { MemoTaskItem } = await import("@/TaskListItem.js");
    const container = installMinimalDom();
    const root: Root = createRoot(container);
    leadingIndicatorState.value = "unread";

    act(() => {
      root.render(
        createElement(MemoTaskItem, {
          intl: stableIntl,
          isActive: false,
          isArchiveConfirming: false,
          isMobileActive: true,
          isPinned: false,
          onArchiveTask: vi.fn(),
          onArchiveTaskInline: vi.fn(),
          onCancelArchiveConfirm: vi.fn(),
          onMarkTaskAsUnread: vi.fn(),
          onSelectTask: vi.fn(),
          onStartRenameTask: vi.fn(),
          onTogglePinTask: vi.fn(),
          task: createTask(),
          workspacePath: "/workspace",
        }),
      );
    });

    const row = findByAttribute(container, "data-task-item-key");
    const unreadIndicator = findByAttribute(container, "data-unread-indicator");
    expect(row).not.toBeNull();
    expect(unreadIndicator?.parentNode?.__attrs.get("class")).toContain("invisible");

    act(() => {
      row?.dispatchEvent({ bubbles: true, relatedTarget: null, type: "mouseover" });
    });

    // Hover swaps the phone marker out, so the run-state slot must be visible, not merely un-invisible.
    expect(unreadIndicator?.parentNode?.__attrs.get("class")).not.toContain("invisible");
    expect(unreadIndicator?.parentNode?.__attrs.get("class")).not.toContain("hidden");

    act(() => {
      root.unmount();
    });
  });

  // task-hover-card-layout #9 (regular row only; grouped rows have no phone marker).
  it.each([
    { name: "error", attribute: "data-error-indicator", value: "true", indicator: "error" },
    { name: "unread", attribute: "data-unread-indicator", value: "true", indicator: "unread" },
    { name: "running", attribute: "data-icon", value: "loader", indicator: "loading" },
  ] as const)(
    "shows a mobile-active $name task's run-state indicator in the slot once hover actions take it",
    async ({ attribute, value, indicator }) => {
      const { MemoTaskItem } = await import("@/TaskListItem.js");
      const container = installMinimalDom();
      const root: Root = createRoot(container);
      leadingIndicatorState.value = indicator;

      act(() => {
        root.render(
          createElement(MemoTaskItem, {
            intl: stableIntl,
            isActive: false,
            isArchiveConfirming: false,
            isMobileActive: true,
            isPinned: false,
            onArchiveTask: vi.fn(),
            onArchiveTaskInline: vi.fn(),
            onCancelArchiveConfirm: vi.fn(),
            onMarkTaskAsUnread: vi.fn(),
            onSelectTask: vi.fn(),
            onStartRenameTask: vi.fn(),
            onTogglePinTask: vi.fn(),
            task: createTask(),
            workspacePath: "/workspace",
          }),
        );
      });

      const indicatorNode = findByAttributeValue(container, attribute, value);
      expect(indicatorNode).not.toBeNull();
      // At rest the phone marker owns the slot, so the run-state node is only invisible.
      expect(indicatorNode?.parentNode?.__attrs.get("class")).toContain("invisible");

      const row = findByAttribute(container, "data-task-item-key");
      act(() => {
        row?.dispatchEvent({ bubbles: true, relatedTarget: null, type: "mouseover" });
      });

      const slotClass = findByAttributeValue(container, attribute, value)?.parentNode?.__attrs.get(
        "class",
      );
      expect(slotClass).not.toContain("invisible");
      expect(slotClass).not.toContain("hidden");

      act(() => {
        root.unmount();
      });
    },
  );

  it.each([
    { name: "error", indicatorAttribute: "data-error-indicator", indicator: "error" },
    { name: "unread", indicatorAttribute: "data-unread-indicator", indicator: "unread" },
  ] as const)(
    "keeps the $name run-state indicator visible in the leading slot on hover, with actions",
    async ({ indicatorAttribute, indicator }) => {
      const { MemoTaskItem } = await import("@/TaskListItem.js");
      const container = installMinimalDom();
      const root: Root = createRoot(container);
      leadingIndicatorState.value = indicator;

      act(() => {
        root.render(
          createElement(MemoTaskItem, {
            intl: stableIntl,
            isActive: false,
            isArchiveConfirming: false,
            isPinned: false,
            onArchiveTask: vi.fn(),
            onArchiveTaskInline: vi.fn(),
            onCancelArchiveConfirm: vi.fn(),
            onMarkTaskAsUnread: vi.fn(),
            onSelectTask: vi.fn(),
            onStartRenameTask: vi.fn(),
            onTogglePinTask: vi.fn(),
            task: createTask(),
            workspacePath: "/workspace",
          }),
        );
      });

      const row = findByAttribute(container, "data-task-item-key");
      act(() => {
        row?.dispatchEvent({ bubbles: true, relatedTarget: null, type: "mouseover" });
      });

      const indicatorNode = findByAttribute(container, indicatorAttribute);
      expect(indicatorNode).not.toBeNull();
      const slotClass = indicatorNode?.parentNode?.__attrs.get("class") ?? "";
      expect(slotClass).not.toContain("hidden");
      expect(slotClass).not.toContain("invisible");
      // The Pin action must not take the slot away from the status; it moves into the action cluster.
      expect(findByAttribute(container, "data-task-row-actions")).not.toBeNull();
      expect(findByAttributeValue(container, "aria-label", "taskList.pin")).not.toBeNull();

      act(() => {
        root.unmount();
      });
    },
  );

  it("keeps the running spinner visible in the leading slot on hover, with actions", async () => {
    const { MemoTaskItem } = await import("@/TaskListItem.js");
    const container = installMinimalDom();
    const root: Root = createRoot(container);
    leadingIndicatorState.value = "loading";

    act(() => {
      root.render(
        createElement(MemoTaskItem, {
          intl: stableIntl,
          isActive: false,
          isArchiveConfirming: false,
          isPinned: false,
          onArchiveTask: vi.fn(),
          onArchiveTaskInline: vi.fn(),
          onCancelArchiveConfirm: vi.fn(),
          onMarkTaskAsUnread: vi.fn(),
          onSelectTask: vi.fn(),
          onStartRenameTask: vi.fn(),
          onTogglePinTask: vi.fn(),
          task: createTask(),
          workspacePath: "/workspace",
        }),
      );
    });

    const row = findByAttribute(container, "data-task-item-key");
    act(() => {
      row?.dispatchEvent({ bubbles: true, relatedTarget: null, type: "mouseover" });
    });

    const spinner = findByAttributeValue(container, "data-icon", "loader");
    expect(spinner).not.toBeNull();
    const slotClass = spinner?.parentNode?.__attrs.get("class") ?? "";
    expect(slotClass).toContain("animate-spin");
    expect(slotClass).not.toContain("hidden");
    expect(findByAttribute(container, "data-task-row-actions")).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("keeps default rows in the compact layout without idle dots", async () => {
    const { MemoTaskItem } = await import("@/TaskListItem.js");
    const container = installMinimalDom();
    const root: Root = createRoot(container);

    act(() => {
      root.render(
        createElement(MemoTaskItem, {
          intl: stableIntl,
          isActive: false,
          isArchiveConfirming: false,
          isPinned: false,
          onArchiveTask: vi.fn(),
          onArchiveTaskInline: vi.fn(),
          onCancelArchiveConfirm: vi.fn(),
          onMarkTaskAsUnread: vi.fn(),
          onSelectTask: vi.fn(),
          onStartRenameTask: vi.fn(),
          onTogglePinTask: vi.fn(),
          task: {
            ...createTask(),
            workspacePath: "/Users/demo/.zcode/workspace/default",
          },
          variant: "default",
          workspacePath: "/Users/demo/.zcode/workspace/default",
        }),
      );
    });

    const row = container.querySelector("[data-task-item-key]");
    expect(row?.getAttribute("class")).toContain("items-center");
    expect(row?.getAttribute("class")).not.toContain("items-start");
    expect(container.querySelector("[data-idle-indicator]")).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("does not re-render when task meta is replaced with equivalent display fields", async () => {
    const { MemoTaskItem } = await import("@/TaskListItem.js");
    const root: Root = createRoot(installMinimalDom());
    const task = createTask();
    const props = {
      intl: stableIntl,
      isActive: false,
      isArchiveConfirming: false,
      isPinned: false,
      onArchiveTask: vi.fn(),
      onArchiveTaskInline: vi.fn(),
      onCancelArchiveConfirm: vi.fn(),
      onMarkTaskAsUnread: vi.fn(),
      onSelectTask: vi.fn(),
      onStartRenameTask: vi.fn(),
      onTogglePinTask: vi.fn(),
      task,
      workspacePath: "/workspace",
    };

    act(() => {
      root.render(createElement(MemoTaskItem, props));
    });
    expect(formatRelativeTimeCalls).toHaveLength(2);

    act(() => {
      root.render(
        createElement(MemoTaskItem, {
          ...props,
          task: { ...task },
        }),
      );
    });

    expect(formatRelativeTimeCalls).toHaveLength(2);

    act(() => {
      root.unmount();
    });
  });

  it("re-renders when a task receives automation identity", async () => {
    const { MemoTaskItem } = await import("@/TaskListItem.js");
    const container = installMinimalDom();
    const root: Root = createRoot(container);
    const task = createTask();
    const props = {
      intl: stableIntl,
      isActive: false,
      isArchiveConfirming: false,
      isPinned: false,
      onArchiveTask: vi.fn(),
      onArchiveTaskInline: vi.fn(),
      onCancelArchiveConfirm: vi.fn(),
      onMarkTaskAsUnread: vi.fn(),
      onSelectTask: vi.fn(),
      onStartRenameTask: vi.fn(),
      onTogglePinTask: vi.fn(),
      task,
      workspacePath: "/workspace",
    };

    act(() => {
      root.render(createElement(MemoTaskItem, props));
    });
    expect(container.querySelector("[data-cron-task-icon]")).toBeNull();

    act(() => {
      root.render(
        createElement(MemoTaskItem, {
          ...props,
          task: {
            ...task,
            automationId: "automation-1",
          } as ZCodeTaskMeta & { automationId: string },
        }),
      );
    });

    expect(container.querySelector("[data-cron-task-icon]")).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("renders cron icon in the timeline time metadata", async () => {
    const { MemoTaskItem } = await import("@/TaskListItem.js");
    const container = installMinimalDom();
    const root: Root = createRoot(container);

    act(() => {
      root.render(
        createElement(MemoTaskItem, {
          intl: stableIntl,
          isActive: false,
          isArchiveConfirming: false,
          isPinned: false,
          onArchiveTask: vi.fn(),
          onArchiveTaskInline: vi.fn(),
          onCancelArchiveConfirm: vi.fn(),
          onMarkTaskAsUnread: vi.fn(),
          onSelectTask: vi.fn(),
          onStartRenameTask: vi.fn(),
          onTogglePinTask: vi.fn(),
          task: {
            ...createTask(),
            cronAutomationId: "automation-1",
          },
          variant: "timeline",
          workspacePath: "/workspace",
        }),
      );
    });

    expect(container.querySelector("[data-cron-task-icon]")).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("keeps archive confirmation active after the pointer leaves the row", async () => {
    const { MemoTaskItem } = await import("@/TaskListItem.js");
    const container = installMinimalDom();
    const root: Root = createRoot(container);
    const onCancelArchiveConfirm = vi.fn();

    act(() => {
      root.render(
        createElement(MemoTaskItem, {
          intl: stableIntl,
          isActive: false,
          isArchiveConfirming: true,
          isPinned: false,
          onArchiveTask: vi.fn(),
          onArchiveTaskInline: vi.fn(),
          onCancelArchiveConfirm,
          onMarkTaskAsUnread: vi.fn(),
          onSelectTask: vi.fn(),
          onStartRenameTask: vi.fn(),
          onTogglePinTask: vi.fn(),
          task: createTask(),
          workspacePath: "/workspace",
        }),
      );
    });

    const row = container.querySelector("[data-task-item-key]") as TestElement | null;
    expect(row).not.toBeNull();

    act(() => {
      row?.dispatchEvent({
        bubbles: true,
        relatedTarget: null,
        type: "mouseout",
      });
    });

    expect(onCancelArchiveConfirm).not.toHaveBeenCalled();
    const confirmButton = findByAttributeValue(container, "aria-label", "common.confirm");
    expect(confirmButton?.__attrs.get("class")).toContain("flex");
    expect(confirmButton?.__attrs.get("class")).not.toContain("hidden");

    act(() => {
      root.unmount();
    });
  });
});
