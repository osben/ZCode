// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IMemoryService } from "@zcode/services";
import { PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE } from "@zcode/services";
import {
  TID_SETTINGS_MEMORY_COUNT,
  TID_SETTINGS_MEMORY_FILE,
  TID_SETTINGS_MEMORY_OPEN_FOLDER,
  TID_SETTINGS_MEMORY_FILE_EDITOR_ACTIONS,
  TID_SETTINGS_MEMORY_FILE_ICON,
  TID_SETTINGS_MEMORY_FILE_NAME,
  TID_SETTINGS_MEMORY_FILE_TYPE,
  TID_SETTINGS_MEMORY_FILE_UPDATED_AT,
  TID_SETTINGS_MEMORY_INDEX_LINES,
  TID_SETTINGS_MEMORY_PREVIEW,
  TID_SETTINGS_MEMORY_SCOPE_ICON,
  TID_SETTINGS_MEMORY_SCOPE_TRIGGER,
  TID_SETTINGS_MEMORY_SEARCH_CLEAR,
  TID_SETTINGS_MEMORY_SEARCH_INPUT,
  testId,
} from "@zcode/shared";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
        values
          ? `${id}:${Object.entries(values)
              .map(([key, value]) => `${key}=${value}`)
              .join(",")}`
          : id,
      // 与 createIntl 的契约一致：解析 `${id}.${category}` 并注入 {count}。
      formatPlural: ({ id }: { id: string }, count: number) =>
        `${id}.${count === 1 ? "one" : "other"}:count=${count}`,
    },
  }),
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/WorkspaceEditorButtonGroup.js", () => ({
  WorkspaceEditorButtonGroup: ({ workspaceAbsPath }: { workspaceAbsPath: string }) =>
    createElement("button", {
      "data-testid": `memory-editor-${workspaceAbsPath}`,
      type: "button",
    }),
}));

const platformMock = vi.hoisted(() => ({
  openInFileManager: vi.fn(async () => ({ success: true })),
}));

const userActionTelemetryMock = vi.hoisted(() => ({
  runUserActionAsync: vi.fn(async (options: { operation: () => Promise<unknown> }) =>
    options.operation(),
  ),
  runUserAction: vi.fn((options: { operation: () => unknown }) => options.operation()),
}));

vi.mock("@/lib/userActionTelemetry.js", () => userActionTelemetryMock);

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => platformMock,
}));

vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", { role: "menu" }, children),
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) =>
    createElement(
      "button",
      { role: "menuitem", type: "button", onClick: () => onSelect?.() },
      children,
    ),
}));

vi.mock("@/previewPaneMarkdownContent.js", () => ({
  MarkdownPreviewContent: ({ content }: { content: string }) =>
    createElement("div", { "data-testid": "markdown-preview-stub" }, content),
}));

vi.mock("@/settings/PluginScopeMenu.js", () => ({
  PluginScopeMenu: ({
    includeUser,
    onScopeKeyChange,
    selectedScopeKey,
    triggerIconTestId,
    triggerTestId,
    workspaceOptions,
  }: {
    includeUser: boolean;
    onScopeKeyChange: (key: string) => void;
    selectedScopeKey: string;
    triggerIconTestId: string;
    triggerTestId: string;
    workspaceOptions: Array<{ key: string; label: string }>;
  }) =>
    createElement(
      "div",
      { "data-include-user": String(includeUser) },
      createElement(
        "button",
        { "data-testid": triggerTestId, type: "button" },
        createElement("span", {
          className: "lucide-folder",
          "data-testid": triggerIconTestId,
        }),
        workspaceOptions.find((option) => option.key === selectedScopeKey)?.label,
      ),
      ...workspaceOptions.map((option) =>
        createElement(
          "button",
          {
            key: option.key,
            role: "menuitemradio",
            type: "button",
            onClick: () => onScopeKeyChange(option.key),
          },
          option.label,
        ),
      ),
    ),
}));

import { MemorySettingsSection } from "@/settings/MemorySettingsSection.js";

type MemoryCatalogService = Pick<
  IMemoryService,
  "listProjectMemories" | "readProjectMemoryFile" | "getProjectMemoryDirectory"
>;

const workspaces = [
  {
    id: "z-code-1111111111111111",
    label: "z-code",
    updatedAt: 20,
    files: [
      {
        name: "MEMORY.md",
        path: "/memory/z-code/MEMORY.md",
        kind: "index" as const,
        size: 12,
        updatedAt: 20,
      },
      {
        name: "fact-a.md",
        path: "/memory/z-code/fact-a.md",
        kind: "item" as const,
        size: 10,
        updatedAt: 10,
      },
    ],
  },
  {
    id: "second-2222222222222222",
    label: "second",
    updatedAt: 15,
    files: [
      {
        name: "fact-b.md",
        path: "/memory/second/fact-b.md",
        kind: "item" as const,
        size: 8,
        updatedAt: 15,
      },
    ],
  },
];

function createService(): MemoryCatalogService {
  return {
    listProjectMemories: vi.fn(async () => workspaces),
    readProjectMemoryFile: vi.fn(async (_params: { workspaceId: string; fileName: string }) => ({
      content: "preview body",
      updatedAt: 1,
    })),
    getProjectMemoryDirectory: vi.fn(async ({ workspaceId }: { workspaceId: string }) => ({
      path: `/memory/${workspaceId}`,
    })),
  };
}

function renderSection(
  memoryService: MemoryCatalogService,
  memoryEnabled = true,
  workspaceDisplayNames: readonly string[] = [],
) {
  const onMemoryEnabledChange = vi.fn(async () => {});
  render(
    createElement(MemorySettingsSection, {
      memoryEnabled,
      memoryService,
      onMemoryEnabledChange,
      projectMemoryViewerAvailable: true,
      workspaceDisplayNames,
    }),
  );
  return { onMemoryEnabledChange };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MemorySettingsSection", () => {
  it("开关位于 Workspace Scope 工具栏上方，关闭时不读取 catalog", () => {
    const memoryService = createService();
    renderSection(memoryService, false);
    expect(screen.getByRole("switch", { name: "settings.memory.workspaceMemory" })).toBeTruthy();
    expect(screen.queryByText("settings.memory.viewer.disabled")).toBeNull();
    expect(screen.queryByTestId(TID_SETTINGS_MEMORY_SCOPE_TRIGGER)).toBeNull();
    expect(memoryService.listProjectMemories).not.toHaveBeenCalled();
  });

  it("默认选择首个 Workspace 并直接显示该 Scope 的文件", async () => {
    renderSection(createService(), true, ["Z Code", "Second"]);
    const scopeTrigger = await screen.findByTestId(TID_SETTINGS_MEMORY_SCOPE_TRIGGER);
    expect(scopeTrigger.textContent).toContain("Z Code");
    expect(screen.getByTestId(TID_SETTINGS_MEMORY_SCOPE_ICON)).toBeTruthy();
    expect(screen.queryByText("User")).toBeNull();
    expect(screen.getByTestId(TID_SETTINGS_MEMORY_COUNT).textContent).toBe(
      "settings.memory.viewer.memoryCount.other:count=2",
    );
    expect(screen.getByTestId(testId(TID_SETTINGS_MEMORY_FILE, "MEMORY.md"))).toBeTruthy();
    expect(screen.getByTestId(testId(TID_SETTINGS_MEMORY_FILE_ICON, "MEMORY.md"))).toBeTruthy();
    expect(
      screen.getByTestId(testId(TID_SETTINGS_MEMORY_FILE_UPDATED_AT, "MEMORY.md")).textContent,
    ).toContain("settings.memory.viewer.updated.date");
    const fileName = screen.getByTestId(testId(TID_SETTINGS_MEMORY_FILE_NAME, "MEMORY.md"));
    expect(fileName.className).toContain("font-medium");
    expect(fileName.className).not.toContain("font-mono");
    expect(screen.getByTestId("memory-editor-/memory/z-code/MEMORY.md")).toBeTruthy();
    expect(
      screen.getByTestId(testId(TID_SETTINGS_MEMORY_FILE_EDITOR_ACTIONS, "MEMORY.md")),
    ).toBeTruthy();
    expect(screen.getByTestId(testId(TID_SETTINGS_MEMORY_FILE, "fact-a.md"))).toBeTruthy();
    expect(screen.queryByTestId(testId(TID_SETTINGS_MEMORY_FILE, "fact-b.md"))).toBeNull();
    const filesHeading = screen.getByRole("heading", {
      name: "settings.memory.viewer.files",
    });
    const filesHeader = filesHeading.parentElement;
    expect(filesHeader?.querySelector('[data-testid="settings-memory-refresh"]')).toBeTruthy();
  });

  it("Workspace Scope 按 settings.json 提供的 recentProjects 顺序排列", async () => {
    renderSection(createService(), true, ["Second", "Z Code"]);

    expect((await screen.findByTestId(TID_SETTINGS_MEMORY_SCOPE_TRIGGER)).textContent).toContain(
      "Second",
    );
    expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual([
      "Second",
      "Z Code",
    ]);
    expect(screen.getByTestId(testId(TID_SETTINGS_MEMORY_FILE, "fact-b.md"))).toBeTruthy();
  });

  it("Scope 菜单只列出 Workspace，切换后替换文件列表", async () => {
    renderSection(createService());
    await screen.findByTestId(TID_SETTINGS_MEMORY_SCOPE_TRIGGER);
    expect(screen.queryByRole("menuitemradio", { name: /User/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /second/ }));
    expect(screen.getByTestId(TID_SETTINGS_MEMORY_SCOPE_TRIGGER).textContent).toContain("second");
    expect(screen.getByTestId(testId(TID_SETTINGS_MEMORY_FILE, "fact-b.md"))).toBeTruthy();
    expect(screen.queryByTestId(testId(TID_SETTINGS_MEMORY_FILE, "MEMORY.md"))).toBeNull();
  });

  it("按当前 Scope 的文件名忽略大小写搜索，无结果时隐藏文件分组", async () => {
    renderSection(createService());
    const search = await screen.findByTestId(TID_SETTINGS_MEMORY_SEARCH_INPUT);

    fireEvent.change(search, { target: { value: "FACT-A" } });
    expect(screen.getByTestId(testId(TID_SETTINGS_MEMORY_FILE, "fact-a.md"))).toBeTruthy();
    expect(screen.queryByTestId(testId(TID_SETTINGS_MEMORY_FILE, "MEMORY.md"))).toBeNull();
    expect(screen.getByTestId(TID_SETTINGS_MEMORY_SEARCH_CLEAR)).toBeTruthy();
    fireEvent.click(screen.getByTestId(TID_SETTINGS_MEMORY_SEARCH_CLEAR));
    expect(screen.getByTestId(testId(TID_SETTINGS_MEMORY_FILE, "MEMORY.md"))).toBeTruthy();

    fireEvent.change(search, { target: { value: "missing" } });
    expect(screen.getByText("settings.memory.viewer.searchEmpty")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "settings.memory.viewer.files" })).toBeNull();
  });

  it("刷新保留当前 Scope；Scope 消失时回退首项", async () => {
    const memoryService = createService();
    renderSection(memoryService);
    await screen.findByTestId(TID_SETTINGS_MEMORY_SCOPE_TRIGGER);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /second/ }));
    fireEvent.click(screen.getByRole("button", { name: "settings.memory.viewer.refresh" }));
    await waitFor(() =>
      expect(screen.getByTestId(TID_SETTINGS_MEMORY_SCOPE_TRIGGER).textContent).toContain("second"),
    );

    vi.mocked(memoryService.listProjectMemories).mockResolvedValueOnce([workspaces[0]]);
    fireEvent.click(screen.getByRole("button", { name: "settings.memory.viewer.refresh" }));
    await waitFor(() =>
      expect(screen.getByTestId(TID_SETTINGS_MEMORY_SCOPE_TRIGGER).textContent).toContain("z-code"),
    );
  });

  it("保留 loading、empty 与 error 反馈", async () => {
    let resolveCatalog: ((value: []) => void) | undefined;
    const memoryService = createService();
    vi.mocked(memoryService.listProjectMemories).mockImplementationOnce(
      () => new Promise((resolve) => (resolveCatalog = resolve)),
    );
    renderSection(memoryService);
    expect(screen.getByText("settings.memory.viewer.loading")).toBeTruthy();
    resolveCatalog?.([]);
    expect(await screen.findByText("settings.memory.viewer.empty")).toBeTruthy();
  });

  it("Web Remote / Mobile 只展示开关和本地查看提示", () => {
    const memoryService = createService();
    render(
      createElement(MemorySettingsSection, {
        memoryEnabled: true,
        memoryService,
        onMemoryEnabledChange: vi.fn(async () => {}),
        projectMemoryViewerAvailable: false,
      }),
    );
    expect(screen.getByText("settings.memory.viewer.localOnly")).toBeTruthy();
    expect(memoryService.listProjectMemories).not.toHaveBeenCalled();
  });

  it("renders the index section with a budget chip, meta rows, and a Today group", async () => {
    const now = Date.now();
    const memoryService = createService();
    vi.mocked(memoryService.listProjectMemories).mockResolvedValueOnce([
      {
        id: "z-code-1111111111111111",
        label: "z-code",
        updatedAt: now,
        files: [
          {
            name: "MEMORY.md",
            path: "/memory/z-code/MEMORY.md",
            kind: "index",
            size: 4096,
            updatedAt: now,
            lineCount: 12,
          },
          {
            name: "fact-a.md",
            path: "/memory/z-code/fact-a.md",
            kind: "item",
            size: 2048,
            updatedAt: now,
            description: "Prefers pnpm workspaces",
            type: "feedback",
          },
        ],
      },
    ]);
    renderSection(memoryService);
    await screen.findByTestId(TID_SETTINGS_MEMORY_SCOPE_TRIGGER);

    expect(
      screen.getByRole("heading", { name: "settings.memory.viewer.indexSection" }),
    ).toBeTruthy();
    expect(screen.getByTestId(TID_SETTINGS_MEMORY_INDEX_LINES).textContent).toBe("12/200");
    expect(
      screen.getByRole("heading", { name: "settings.memory.viewer.group.today" }),
    ).toBeTruthy();
    expect(screen.getByText("Prefers pnpm workspaces")).toBeTruthy();
    expect(screen.getByTestId(testId(TID_SETTINGS_MEMORY_FILE_TYPE, "fact-a.md")).textContent).toBe(
      "settings.memory.viewer.type.feedback",
    );
  });

  it("matches the description text when searching", async () => {
    const now = Date.now();
    const memoryService = createService();
    vi.mocked(memoryService.listProjectMemories).mockResolvedValueOnce([
      {
        id: "z-code-1111111111111111",
        label: "z-code",
        updatedAt: now,
        files: [
          {
            name: "unrelated.md",
            path: "/memory/z-code/unrelated.md",
            kind: "item",
            size: 10,
            updatedAt: now,
          },
          {
            name: "fact-a.md",
            path: "/memory/z-code/fact-a.md",
            kind: "item",
            size: 10,
            updatedAt: now,
            description: "Prefers pnpm workspaces",
            type: "feedback",
          },
        ],
      },
    ]);
    renderSection(memoryService);
    const search = await screen.findByTestId(TID_SETTINGS_MEMORY_SEARCH_INPUT);

    fireEvent.change(search, { target: { value: "pnpm workspaces" } });
    expect(screen.getByTestId(testId(TID_SETTINGS_MEMORY_FILE, "fact-a.md"))).toBeTruthy();
    expect(screen.queryByTestId(testId(TID_SETTINGS_MEMORY_FILE, "unrelated.md"))).toBeNull();
  });

  it("lazily loads the preview when a row expands", async () => {
    let resolveRead: ((value: { content: string; updatedAt: number }) => void) | undefined;
    const memoryService = createService();
    vi.mocked(memoryService.readProjectMemoryFile).mockImplementationOnce(
      () => new Promise((resolve) => (resolveRead = resolve)),
    );
    renderSection(memoryService);
    await screen.findByTestId(TID_SETTINGS_MEMORY_SCOPE_TRIGGER);

    fireEvent.click(screen.getByTestId(testId(TID_SETTINGS_MEMORY_FILE_NAME, "fact-a.md")));
    expect(await screen.findByText("settings.memory.viewer.fileLoading")).toBeTruthy();
    resolveRead?.({ content: "# Fact body", updatedAt: 1 });

    expect(await screen.findByText("# Fact body")).toBeTruthy();
    expect(screen.getByTestId(testId(TID_SETTINGS_MEMORY_PREVIEW, "fact-a.md"))).toBeTruthy();
    expect(memoryService.readProjectMemoryFile).toHaveBeenCalledWith({
      workspaceId: "z-code-1111111111111111",
      fileName: "fact-a.md",
    });
    expect(userActionTelemetryMock.runUserActionAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          featureId: "settings.memory",
          action: "expand_preview",
        }),
      }),
    );
  });

  it("clicking the editor control does not toggle the preview", async () => {
    const memoryService = createService();
    renderSection(memoryService);
    await screen.findByTestId(TID_SETTINGS_MEMORY_SCOPE_TRIGGER);

    fireEvent.click(screen.getByTestId("memory-editor-/memory/z-code/fact-a.md"));

    expect(memoryService.readProjectMemoryFile).not.toHaveBeenCalled();
    expect(screen.queryByText("settings.memory.viewer.fileLoading")).toBeNull();
    expect(screen.queryByTestId("markdown-preview-stub")).toBeNull();
  });

  it("maps preview read failures to localized states", async () => {
    const memoryService = createService();
    vi.mocked(memoryService.readProjectMemoryFile).mockRejectedValueOnce(
      Object.assign(new Error("gone"), { code: "ENOENT" }),
    );
    renderSection(memoryService);
    await screen.findByTestId(TID_SETTINGS_MEMORY_SCOPE_TRIGGER);
    fireEvent.click(screen.getByTestId(testId(TID_SETTINGS_MEMORY_FILE_NAME, "fact-a.md")));
    expect(await screen.findByText("settings.memory.viewer.fileDeleted")).toBeTruthy();

    vi.mocked(memoryService.readProjectMemoryFile).mockRejectedValueOnce(
      Object.assign(new Error("big"), { code: PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE }),
    );
    fireEvent.click(screen.getByTestId(testId(TID_SETTINGS_MEMORY_FILE_NAME, "MEMORY.md")));
    expect(await screen.findByText("settings.memory.viewer.fileTooLarge")).toBeTruthy();
  });

  it("retries a failed preview when its accordion row is reopened", async () => {
    const memoryService = createService();
    vi.mocked(memoryService.readProjectMemoryFile)
      .mockRejectedValueOnce(
        Object.assign(new Error("changed"), { code: "PROJECT_MEMORY_FILE_CHANGED" }),
      )
      .mockResolvedValueOnce({ content: "reloaded preview", updatedAt: 2 });
    renderSection(memoryService);
    await screen.findByTestId(TID_SETTINGS_MEMORY_SCOPE_TRIGGER);

    const row = screen.getByTestId(testId(TID_SETTINGS_MEMORY_FILE_NAME, "fact-a.md"));
    fireEvent.click(row);
    expect(await screen.findByText("settings.memory.viewer.fileChanged")).toBeTruthy();
    fireEvent.click(row);
    fireEvent.click(row);

    expect(await screen.findByText("reloaded preview")).toBeTruthy();
    expect(memoryService.readProjectMemoryFile).toHaveBeenCalledTimes(2);
  });

  it("opens the selected workspace memory folder through the platform", async () => {
    const memoryService = createService();
    renderSection(memoryService);
    await screen.findByTestId(TID_SETTINGS_MEMORY_SCOPE_TRIGGER);

    fireEvent.click(screen.getByTestId(TID_SETTINGS_MEMORY_OPEN_FOLDER));
    fireEvent.click(screen.getByRole("menuitem", { name: "z-code" }));

    await waitFor(() =>
      expect(memoryService.getProjectMemoryDirectory).toHaveBeenCalledWith({
        workspaceId: "z-code-1111111111111111",
      }),
    );
    expect(platformMock.openInFileManager).toHaveBeenCalledWith("/memory/z-code-1111111111111111");
    expect(userActionTelemetryMock.runUserActionAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ featureId: "settings.memory", action: "open_folder" }),
      }),
    );
  });

  it("keeps per-file preview requests scoped when multiple rows open", async () => {
    const memoryService = createService();
    const deferred = new Map<string, (value: { content: string; updatedAt: number }) => void>();
    vi.mocked(memoryService.readProjectMemoryFile).mockImplementation(
      ({ fileName }: { workspaceId: string; fileName: string }) =>
        new Promise((resolve) => {
          deferred.set(fileName, resolve);
        }),
    );
    renderSection(memoryService);
    await screen.findByTestId(TID_SETTINGS_MEMORY_SCOPE_TRIGGER);

    fireEvent.click(screen.getByTestId(testId(TID_SETTINGS_MEMORY_FILE_NAME, "fact-a.md")));
    fireEvent.click(screen.getByTestId(testId(TID_SETTINGS_MEMORY_FILE_NAME, "MEMORY.md")));
    expect(screen.getAllByText("settings.memory.viewer.fileLoading")).toHaveLength(2);

    deferred.get("MEMORY.md")?.({ content: "# Index body", updatedAt: 1 });
    expect(await screen.findByText("# Index body")).toBeTruthy();

    deferred.get("fact-a.md")?.({ content: "# Fact body", updatedAt: 1 });
    expect(await screen.findByText("# Fact body")).toBeTruthy();
  });

  it("clears previews and closes rows when the workspace scope changes", async () => {
    const memoryService = createService();
    renderSection(memoryService);
    await screen.findByTestId(TID_SETTINGS_MEMORY_SCOPE_TRIGGER);

    fireEvent.click(screen.getByTestId(testId(TID_SETTINGS_MEMORY_FILE_NAME, "MEMORY.md")));
    expect(await screen.findByText("preview body")).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitemradio", { name: /second/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /z-code/ }));

    expect(screen.queryByText("preview body")).toBeNull();
    // Re-expanding must issue a fresh read instead of reusing the stale entry.
    fireEvent.click(screen.getByTestId(testId(TID_SETTINGS_MEMORY_FILE_NAME, "MEMORY.md")));
    expect(await screen.findByText("preview body")).toBeTruthy();
    expect(memoryService.readProjectMemoryFile).toHaveBeenCalledTimes(2);
  });

  it("expands the row from the chevron toggle outside the trigger", async () => {
    const memoryService = createService();
    renderSection(memoryService);
    await screen.findByTestId(TID_SETTINGS_MEMORY_SCOPE_TRIGGER);

    const toggles = screen.getAllByRole("button", {
      name: "settings.memory.viewer.togglePreview",
    });
    fireEvent.click(toggles[0]!);

    await waitFor(() =>
      expect(memoryService.readProjectMemoryFile).toHaveBeenCalledWith({
        workspaceId: "z-code-1111111111111111",
        fileName: "MEMORY.md",
      }),
    );
    expect(userActionTelemetryMock.runUserActionAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          featureId: "settings.memory",
          action: "expand_preview",
        }),
      }),
    );
  });
});
