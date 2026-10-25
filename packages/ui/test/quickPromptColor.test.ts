// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import type { MutableRefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QUICK_PROMPT_COLORS,
  type IQuickPromptService,
  type QuickPrompt,
  type QuickPromptSnapshot,
} from "@zcode/services";
import { QuickPromptBar } from "@/quick-prompts/QuickPromptBar.js";
import { QuickPromptColorDot } from "@/quick-prompts/QuickPromptColorDot.js";
import { QuickPromptColorPicker } from "@/quick-prompts/QuickPromptColorPicker.js";
import { QuickPromptEditorDialog } from "@/quick-prompts/QuickPromptEditorDialog.js";
import { quickPromptColorMessageId, quickPromptColorVar } from "@/quick-prompts/model.js";

// Spec: specs/composer-quick-prompts.md rules 22-24 (color label: palette, dot on the chip, editor picker).

const fake = vi.hoisted(() => ({
  handle: null as null | Record<string, unknown>,
  editorProps: null as null | Record<string, unknown>,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));
vi.mock("@/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/mobileTextInput.js", () => ({
  useIsMobileTextInputViewport: () => false,
}));
vi.mock("@/project-sidebar/index.js", () => ({
  useOptionalProjectDirectory: () => null,
}));
vi.mock("@/store/confirmDialogStore.js", () => ({
  useConfirmDialogStore: {
    getState: () => ({ requestConfirmation: vi.fn(async () => true) }),
  },
}));
vi.mock("@/prompt-editor/ChatPromptEditor.js", () => ({
  ChatPromptEditor: (props: Record<string, unknown>) => {
    fake.editorProps = props;
    (props.inputApiRef as MutableRefObject<unknown>).current = fake.handle;
    return createElement("div", { "data-testid": "editor-stub" });
  },
}));

const project = { hostId: "host-a", projectId: "proj:1" };
const nodes = JSON.stringify([
  {
    type: "paragraph",
    version: 1,
    children: [{ type: "text", text: "review", version: 1 }],
  },
]);

function prompt(overrides: Partial<QuickPrompt> = {}): QuickPrompt {
  return {
    promptId: "p1",
    scope: "project",
    project,
    name: "Review",
    body: { markdown: "review", nodes },
    color: null,
    pinned: true,
    position: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  fake.handle = null;
  fake.editorProps = null;
});

describe("quick prompt color model (rules 22-23)", () => {
  it("maps every palette hue to its own token and none to no dot", () => {
    const vars = QUICK_PROMPT_COLORS.map((color) => quickPromptColorVar(color));
    expect(new Set(vars).size).toBe(QUICK_PROMPT_COLORS.length);
    for (const [index, color] of QUICK_PROMPT_COLORS.entries()) {
      expect(vars[index]).toBe(`var(--color-quick-prompt-${color})`);
    }
    expect(quickPromptColorVar(null)).toBeNull();
    expect(quickPromptColorVar(undefined)).toBeNull();
    // A value outside the palette (a snapshot from a newer build) never produces a token name.
    expect(quickPromptColorVar("teal" as never)).toBeNull();
  });

  it("names every swatch, including none", () => {
    expect(quickPromptColorMessageId(null)).toBe("quickPrompts.color.none");
    expect(quickPromptColorMessageId("violet")).toBe("quickPrompts.color.violet");
  });
});

describe("QuickPromptColorDot", () => {
  it("renders a hidden decorative dot for a hue and nothing for none", () => {
    const { rerender } = render(createElement(QuickPromptColorDot, { color: "green" }));
    const dot = screen.getByTestId("quick-prompt-color-dot");
    expect(dot.getAttribute("aria-hidden")).toBe("true");
    expect(dot.getAttribute("data-color")).toBe("green");
    expect(dot.style.backgroundColor).toBe("var(--color-quick-prompt-green)");

    rerender(createElement(QuickPromptColorDot, { color: null }));
    expect(screen.queryByTestId("quick-prompt-color-dot")).toBeNull();
  });
});

describe("QuickPromptBar chip (rule 23)", () => {
  function renderBar(prompts: QuickPrompt[]) {
    const snapshot: QuickPromptSnapshot = {
      project,
      globals: [],
      projectPrompts: prompts,
    };
    render(
      createElement(QuickPromptBar, {
        snapshot,
        project,
        service: {} as IQuickPromptService,
        refresh: vi.fn(async () => undefined),
        inputApiRef: { current: null } as never,
        draftHasContent: false,
        onSendMarkdown: vi.fn(),
        workspacePath: "/repo",
      }),
    );
  }

  it("shows the dot only on colored chips and keeps the name as the chip text", () => {
    renderBar([
      prompt({ promptId: "plain", name: "Plain" }),
      prompt({ promptId: "blue", name: "Blue one", color: "blue" }),
    ]);
    const chips = screen.getAllByTestId("quick-prompt-chip");
    expect(chips.map((chip) => chip.textContent)).toEqual(["Plain", "Blue one"]);
    expect(chips[0]?.querySelector("[data-testid=quick-prompt-color-dot]")).toBeNull();
    expect(
      chips[1]?.querySelector("[data-testid=quick-prompt-color-dot]")?.getAttribute("data-color"),
    ).toBe("blue");
  });

  it("gives every chip and the add chip an opaque card fill (rule 1)", () => {
    renderBar([prompt({ promptId: "plain", name: "Plain" })]);
    const chips = [
      ...screen.getAllByTestId("quick-prompt-chip"),
      screen.getByTestId("quick-prompt-add"),
    ];
    for (const chip of chips) {
      const classes = chip.className.split(/\s+/);
      expect(classes).toContain("bg-card");
      expect(classes).toContain("hover:bg-card-selected");
      expect(classes).not.toContain("hover:bg-input/50");
    }
  });
});

describe("QuickPromptColorPicker (rule 24)", () => {
  it("offers none plus the seven hues, marks the selection and reports changes", () => {
    const onChange = vi.fn();
    render(createElement(QuickPromptColorPicker, { value: "pink", onChange }));
    const swatches = screen.getByTestId("quick-prompt-editor-color").querySelectorAll("button");
    expect(swatches).toHaveLength(8);
    expect(screen.getByTestId("quick-prompt-editor-color-pink").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByTestId("quick-prompt-editor-color-none").getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(screen.getByLabelText("quickPrompts.color.red")).toBeTruthy();

    fireEvent.click(screen.getByTestId("quick-prompt-editor-color-red"));
    expect(onChange).toHaveBeenLastCalledWith("red");
    fireEvent.click(screen.getByTestId("quick-prompt-editor-color-none"));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});

describe("QuickPromptEditorDialog color (rule 24)", () => {
  function setup(target: { mode: "create" } | { mode: "edit"; prompt: QuickPrompt }) {
    const handle = {
      loadSerializedBody: vi.fn(),
      getSerializedBody: vi.fn(() => ({ markdown: "review", nodes })),
    };
    fake.handle = handle;
    const service = {
      update: vi.fn(async () => prompt()),
      create: vi.fn(async () => prompt()),
    };
    render(
      createElement(QuickPromptEditorDialog, {
        target: target.mode === "create" ? { mode: "create", scope: "project" } : target,
        onClose: vi.fn(),
        project,
        projectName: "Demo",
        snapshot: { project, globals: [], projectPrompts: [] },
        service: service as unknown as IQuickPromptService,
        refresh: vi.fn(async () => undefined),
        workspacePath: "/repo",
      } as never),
    );
    return service;
  }
  const save = () => screen.getByTestId("quick-prompt-editor-save") as HTMLButtonElement;

  async function fillCreateForm(service: ReturnType<typeof setup>) {
    fireEvent.change(screen.getByTestId("quick-prompt-editor-name"), {
      target: { value: "N" },
    });
    const onChange = fake.editorProps?.onChange as (value: string) => void;
    act(() => onChange("review"));
    await waitFor(() => expect(save().disabled).toBe(false));
    return service;
  }

  it("creates a prompt with no color by default", async () => {
    const service = await fillCreateForm(setup({ mode: "create" }));
    fireEvent.click(save());
    await waitFor(() => expect(service.create).toHaveBeenCalledTimes(1));
    expect(service.create.mock.calls[0]?.[0]).toMatchObject({
      name: "N",
      color: null,
    });
  });

  it("creates a prompt with the picked hue", async () => {
    const service = await fillCreateForm(setup({ mode: "create" }));
    fireEvent.click(screen.getByTestId("quick-prompt-editor-color-green"));
    fireEvent.click(save());
    await waitFor(() => expect(service.create).toHaveBeenCalledTimes(1));
    expect(service.create.mock.calls[0]?.[0]).toMatchObject({ color: "green" });
  });

  it("sends color on edit only when the picker changed it", async () => {
    const service = setup({ mode: "edit", prompt: prompt({ color: "blue" }) });
    await waitFor(() => expect(save().disabled).toBe(false));

    fireEvent.change(screen.getByTestId("quick-prompt-editor-name"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(save());
    await waitFor(() => expect(service.update).toHaveBeenCalledTimes(1));
    expect(service.update.mock.calls[0]?.[0]).not.toHaveProperty("color");
  });

  it("sends the new color, and null to clear it", async () => {
    const service = setup({ mode: "edit", prompt: prompt({ color: "blue" }) });
    await waitFor(() => expect(save().disabled).toBe(false));
    expect(screen.getByTestId("quick-prompt-editor-color-blue").getAttribute("aria-pressed")).toBe(
      "true",
    );

    fireEvent.click(screen.getByTestId("quick-prompt-editor-color-none"));
    fireEvent.click(save());
    await waitFor(() => expect(service.update).toHaveBeenCalledTimes(1));
    expect(service.update.mock.calls[0]?.[0]).toMatchObject({
      promptId: "p1",
      color: null,
    });
  });
});
