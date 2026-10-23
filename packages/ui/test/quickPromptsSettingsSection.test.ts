// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, useEffect } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuickPrompt, QuickPromptProjectRef, QuickPromptSnapshot } from "@zcode/services";

const fake = vi.hoisted(() => ({
  services: null as null | Record<string, unknown>,
  directory: null as null | Record<string, unknown>,
  draftProjectIds: {} as Record<string, string>,
  confirm: vi.fn(async () => true),
  toast: vi.fn(),
  editorProps: null as null | Record<string, unknown>,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useOptionalBaseWorkspaceServices: () => fake.services,
}));
vi.mock("@/project-sidebar/index.js", () => ({
  useOptionalProjectDirectory: () => fake.directory,
}));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      workspaces: Object.fromEntries(
        Object.entries(fake.draftProjectIds).map(([key, draftProjectId]) => [
          key,
          { draftProjectId },
        ]),
      ),
    }),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: fake.toast }));
vi.mock("@/store/confirmDialogStore.js", () => ({
  useConfirmDialogStore: { getState: () => ({ requestConfirmation: fake.confirm }) },
}));
vi.mock("@/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// The real editor mounts Lexical; these tests only check which target the section opens it with.
vi.mock("@/quick-prompts/QuickPromptEditorDialog.js", () => ({
  QuickPromptEditorDialog: (props: Record<string, unknown>) => {
    fake.editorProps = props;
    return createElement("div", { "data-testid": "editor-stub" });
  },
}));

import { QuickPromptsSettingsSection } from "@/quick-prompts/QuickPromptsSettingsSection.js";
import { useQuickPromptSettingsActions } from "@/quick-prompts/useQuickPromptSettingsActions.js";

const LOCAL = "local-host";
const ALPHA: QuickPromptProjectRef = { hostId: LOCAL, projectId: "p-alpha" };

function prompt(
  partial: Partial<QuickPrompt> & Pick<QuickPrompt, "promptId" | "name" | "scope">,
): QuickPrompt {
  return {
    project: null,
    body: { markdown: `${partial.name} body`, nodes: "[]" },
    pinned: true,
    position: 0,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

function globalsSnapshot(project: QuickPromptProjectRef | null, count = 2): QuickPromptSnapshot {
  const names = ["Review the diff", "Write tests"];
  const globals = Array.from({ length: count }, (_, index) => {
    const base = prompt({
      promptId: `g${index + 1}`,
      scope: "global",
      name: names[index] ?? `Global ${index + 1}`,
      position: index,
      pinned: index === 0,
    });
    return { ...base, hiddenInProject: index === 1 && project !== null };
  });
  const projectPrompts =
    project?.projectId === ALPHA.projectId
      ? [
          prompt({
            promptId: "p1",
            scope: "project",
            project: ALPHA,
            name: "Run e2e",
            position: 0,
          }),
        ]
      : [];
  return { project, globals, projectPrompts };
}

function makeServices(overrides: Record<string, unknown> = {}) {
  const quickPromptService = {
    read: vi.fn(async ({ project }: { project: QuickPromptProjectRef | null }) =>
      globalsSnapshot(project),
    ),
    readProjects: vi.fn(async () => []),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(async () => undefined),
    duplicate: vi.fn(async () => prompt({ promptId: "copy", scope: "global", name: "copy" })),
    setPinned: vi.fn(async () => undefined),
    setHidden: vi.fn(async () => undefined),
    reorder: vi.fn(async () => undefined),
    ...overrides,
  };
  return {
    quickPromptService,
    broadcastService: { onMessage: () => ({ dispose: () => undefined }) },
  };
}

function setDirectory() {
  fake.directory = {
    projects: [
      {
        id: "p-alpha",
        hostId: LOCAL,
        name: "Alpha",
        nameOverridden: false,
        roots: [{ rootPath: "/work/alpha", position: 0, isPrimary: true }],
        position: 0,
        pinned: false,
        deleted: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    tree: { projects: [], tasks: [] },
    availability: new Map(),
  };
}

/** Lets the reader's pending promise and the state update it triggers settle inside act. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function listScopes(): string[] {
  return screen
    .queryAllByTestId("quick-prompts-settings-list")
    .map((list) => list.getAttribute("data-scope") ?? "");
}

function rowOf(name: string): HTMLElement {
  const row = screen
    .queryAllByTestId("quick-prompts-settings-row")
    .find((candidate) => candidate.getAttribute("data-prompt-name") === name);
  if (!row) throw new Error(`row not found: ${name}`);
  return row;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  fake.draftProjectIds = {};
  fake.editorProps = null;
});

beforeEach(() => {
  setDirectory();
});

describe("QuickPromptsSettingsSection", () => {
  it("preselects the window's project and lists its quick prompts above the global ones", async () => {
    fake.draftProjectIds = { "/work/alpha": "p-alpha" };
    const { quickPromptService, broadcastService } = makeServices();
    fake.services = { quickPromptService, broadcastService };

    render(
      createElement(QuickPromptsSettingsSection, {
        workspacePath: "/work/alpha",
        readOnly: false,
      }),
    );
    await settle();

    expect(listScopes()).toEqual(["project", "global"]);
    expect(rowOf("Run e2e")).toBeTruthy();
    expect(rowOf("Review the diff")).toBeTruthy();
    expect(quickPromptService.read).toHaveBeenCalledWith({ project: ALPHA });
  });

  it("without a project shows only the global list and no Shown-in switch", async () => {
    const { quickPromptService, broadcastService } = makeServices();
    fake.services = { quickPromptService, broadcastService };

    render(createElement(QuickPromptsSettingsSection, { workspacePath: "/work/none" }));
    await settle();

    expect(listScopes()).toEqual(["global"]);
    expect(screen.queryAllByTestId("quick-prompts-settings-shown")).toHaveLength(0);
    expect(quickPromptService.read).toHaveBeenCalledWith({ project: null });
  });

  it("the Pinned switch calls setPinned with the switched value", async () => {
    const { quickPromptService, broadcastService } = makeServices();
    fake.services = { quickPromptService, broadcastService };
    render(createElement(QuickPromptsSettingsSection, { workspacePath: "/work/none" }));
    await settle();

    const pinned = rowOf("Review the diff").querySelector(
      '[data-testid="quick-prompts-settings-pinned"]',
    ) as HTMLElement;
    expect(pinned.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(pinned);
    await settle();

    expect(quickPromptService.setPinned).toHaveBeenCalledWith({ promptId: "g1", pinned: false });
  });

  it("the Shown-in switch hides or shows a global quick prompt in the selected project", async () => {
    fake.draftProjectIds = { "/work/alpha": "p-alpha" };
    const { quickPromptService, broadcastService } = makeServices();
    fake.services = { quickPromptService, broadcastService };
    render(createElement(QuickPromptsSettingsSection, { workspacePath: "/work/alpha" }));
    await settle();

    const shownForHidden = rowOf("Write tests").querySelector(
      '[data-testid="quick-prompts-settings-shown"]',
    ) as HTMLElement;
    expect(shownForHidden.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(shownForHidden);
    await settle();

    expect(quickPromptService.setHidden).toHaveBeenCalledWith({
      promptId: "g2",
      project: ALPHA,
      hidden: false,
    });
  });

  it("shows a localized toast for a service error code and never the raw code", async () => {
    const { quickPromptService, broadcastService } = makeServices({
      setPinned: vi.fn(async () => {
        throw new Error("quick-prompt.limit-reached");
      }),
    });
    fake.services = { quickPromptService, broadcastService };
    render(createElement(QuickPromptsSettingsSection, { workspacePath: "/work/none" }));
    await settle();

    fireEvent.click(
      rowOf("Review the diff").querySelector('[data-testid="quick-prompts-settings-pinned"]')!,
    );
    await settle();

    expect(fake.toast).toHaveBeenCalledWith("quickPrompts.limit.reached", expect.anything());
    for (const call of fake.toast.mock.calls) {
      expect(String(call[0])).not.toContain("quick-prompt.");
    }
  });

  it("read-only mode (web remote) disables every mutation control", async () => {
    const { quickPromptService, broadcastService } = makeServices();
    fake.services = { quickPromptService, broadcastService };
    fake.draftProjectIds = { "/work/alpha": "p-alpha" };
    render(
      createElement(QuickPromptsSettingsSection, { workspacePath: "/work/alpha", readOnly: true }),
    );
    await settle();

    expect(screen.getByText("quickPrompts.settings.readOnly")).toBeTruthy();
    expect(screen.queryAllByTestId("quick-prompts-settings-new")).toHaveLength(0);
    expect(screen.queryAllByTestId("quick-prompts-settings-menu")).toHaveLength(0);
    expect(screen.queryAllByTestId("quick-prompts-settings-drag")).toHaveLength(0);
    for (const toggle of screen.queryAllByRole("switch")) {
      expect(toggle.hasAttribute("disabled") || toggle.getAttribute("data-disabled") !== null).toBe(
        true,
      );
    }
    fireEvent.click(
      rowOf("Review the diff").querySelector('[data-testid="quick-prompts-settings-pinned"]')!,
    );
    await settle();
    expect(quickPromptService.setPinned).not.toHaveBeenCalled();
  });

  it("disables create at the 50-prompt limit and explains why", async () => {
    const { quickPromptService, broadcastService } = makeServices({
      read: vi.fn(async ({ project }: { project: QuickPromptProjectRef | null }) =>
        globalsSnapshot(project, 50),
      ),
    });
    fake.services = { quickPromptService, broadcastService };
    render(createElement(QuickPromptsSettingsSection, { workspacePath: "/work/none" }));
    await settle();

    const createButton = screen.getByTestId("quick-prompts-settings-new") as HTMLButtonElement;
    expect(createButton.disabled).toBe(true);
    expect(screen.getByText("quickPrompts.limit.reached")).toBeTruthy();
  });

  it("opens the editor for a new global quick prompt with the global scope", async () => {
    const { quickPromptService, broadcastService } = makeServices();
    fake.services = { quickPromptService, broadcastService };
    render(createElement(QuickPromptsSettingsSection, { workspacePath: "/work/none" }));
    await settle();

    fireEvent.click(screen.getByTestId("quick-prompts-settings-new"));
    await settle();

    expect(screen.getByTestId("editor-stub")).toBeTruthy();
    expect(fake.editorProps?.target).toEqual({ mode: "create", scope: "global" });
  });
});

describe("editor file mentions follow the project's root (spec rule 19)", () => {
  // jsdom lacks the pointer-capture and scroll APIs that the Radix Select opens with.
  beforeAll(() => {
    const proto = Element.prototype as unknown as Record<string, unknown>;
    proto.hasPointerCapture ??= () => false;
    proto.setPointerCapture ??= () => undefined;
    proto.releasePointerCapture ??= () => undefined;
    proto.scrollIntoView ??= () => undefined;
  });

  function addBetaProject() {
    const projects = (fake.directory as { projects: Array<Record<string, unknown>> }).projects;
    projects.push({
      id: "p-beta",
      hostId: LOCAL,
      name: "Beta",
      nameOverridden: false,
      roots: [{ rootPath: "/remote/beta", position: 0, isPrimary: true }],
      position: 1,
      pinned: false,
      deleted: false,
      createdAt: 1,
      updatedAt: 1,
    });
  }

  it("keeps the @ panel for the window's own project", async () => {
    fake.draftProjectIds = { "/work/alpha": "p-alpha" };
    const { quickPromptService, broadcastService } = makeServices();
    fake.services = { quickPromptService, broadcastService };
    render(
      createElement(QuickPromptsSettingsSection, { workspacePath: "/work/alpha", readOnly: false }),
    );
    await settle();

    fireEvent.click(screen.getAllByTestId("quick-prompts-settings-new")[0]!);
    await settle();

    expect(fake.editorProps?.mentionPanelEnabled).toBe(true);
  });

  it("disables the @ panel for another project, whose root is not on this window's filesystem", async () => {
    addBetaProject();
    fake.draftProjectIds = { "/work/alpha": "p-alpha" };
    const { quickPromptService, broadcastService } = makeServices();
    fake.services = { quickPromptService, broadcastService };
    render(
      createElement(QuickPromptsSettingsSection, { workspacePath: "/work/alpha", readOnly: false }),
    );
    await settle();

    fireEvent.keyDown(screen.getByTestId("quick-prompts-settings-project"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Beta" }));
    await settle();
    fireEvent.click(screen.getAllByTestId("quick-prompts-settings-new")[0]!);
    await settle();

    expect(fake.editorProps?.workspacePath).toBe("/remote/beta");
    expect(fake.editorProps?.mentionPanelEnabled).toBe(false);
  });
});

describe("useQuickPromptSettingsActions", () => {
  type Actions = ReturnType<typeof useQuickPromptSettingsActions>;

  function renderActions(service: unknown): { current: () => Actions } {
    const holder: { value: Actions | null } = { value: null };
    function Probe() {
      const actions = useQuickPromptSettingsActions({
        service: service as never,
        refresh: async () => undefined,
      });
      useEffect(() => {
        holder.value = actions;
      });
      return null;
    }
    render(createElement(Probe));
    return {
      current: () => {
        if (!holder.value) throw new Error("actions not mounted");
        return holder.value;
      },
    };
  }

  it("deletes only after the confirmation is accepted", async () => {
    const { quickPromptService } = makeServices();
    const actions = renderActions(quickPromptService).current();
    const target = prompt({ promptId: "g1", scope: "global", name: "Review the diff" });

    fake.confirm.mockResolvedValueOnce(false);
    await act(async () => actions.remove(target));
    expect(quickPromptService.delete).not.toHaveBeenCalled();

    fake.confirm.mockResolvedValueOnce(true);
    await act(async () => actions.remove(target));
    expect(quickPromptService.delete).toHaveBeenCalledWith({ promptId: "g1" });
  });

  it("duplicates into the same list with the same scope and project", async () => {
    const { quickPromptService } = makeServices();
    const actions = renderActions(quickPromptService).current();
    const target = prompt({
      promptId: "p1",
      scope: "project",
      project: ALPHA,
      name: "Run e2e",
    });

    await act(async () => actions.duplicate(target));

    expect(quickPromptService.duplicate).toHaveBeenCalledWith({
      promptId: "p1",
      scope: "project",
      project: ALPHA,
    });
  });

  it("reorder sends the complete ordered id list for the list's scope", async () => {
    const { quickPromptService } = makeServices();
    const actions = renderActions(quickPromptService).current();

    await act(async () => actions.reorder("global", null, ["g2", "g1"]));

    expect(quickPromptService.reorder).toHaveBeenCalledWith({
      scope: "global",
      project: null,
      orderedIds: ["g2", "g1"],
    });
  });

  it("reports a failed reorder with the mapped message and refreshes", async () => {
    const { quickPromptService } = makeServices({
      reorder: vi.fn(async () => {
        throw new Error("quick-prompt.reorder-mismatch");
      }),
    });
    const refresh = vi.fn(async () => undefined);
    const holder: { value: Actions | null } = { value: null };
    type Actions = ReturnType<typeof useQuickPromptSettingsActions>;
    function Probe() {
      const actions = useQuickPromptSettingsActions({
        service: quickPromptService as never,
        refresh,
      });
      useEffect(() => {
        holder.value = actions;
      });
      return null;
    }
    render(createElement(Probe));

    await act(async () => holder.value!.reorder("global", null, ["g1", "g2"]));

    await waitFor(() =>
      expect(fake.toast).toHaveBeenCalledWith("quickPrompts.errors.reorder", expect.anything()),
    );
    expect(refresh).toHaveBeenCalled();
  });
});
