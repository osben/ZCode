// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import type { MutableRefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IQuickPromptService, QuickPrompt, QuickPromptSnapshot } from "@zcode/services";
import { QuickPromptEditorDialog } from "@/quick-prompts/QuickPromptEditorDialog.js";

// Spec: specs/composer-quick-prompts.md (rules 15, 19 and the file-mention scope of a non-window project).
// The real editor mounts Lexical; these tests drive the dialog through a stub whose stored-body load can fail.

const fake = vi.hoisted(() => ({
  handle: null as null | Record<string, unknown>,
  editorProps: null as null | Record<string, unknown>,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/store/confirmDialogStore.js", () => ({
  useConfirmDialogStore: { getState: () => ({ requestConfirmation: vi.fn(async () => true) }) },
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
    children: [{ type: "text", text: "review the diff", version: 1 }],
  },
]);

function storedPrompt(overrides: Partial<QuickPrompt> = {}): QuickPrompt {
  return {
    promptId: "p1",
    scope: "project",
    project,
    name: "Review",
    body: { markdown: "review the diff", nodes },
    color: null,
    pinned: true,
    position: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const snapshot: QuickPromptSnapshot = { project, globals: [], projectPrompts: [storedPrompt()] };

function setup(options: {
  loadError?: Error;
  mentionPanelEnabled?: boolean;
  prompt?: QuickPrompt;
}) {
  const handle = {
    loadSerializedBody: vi.fn(() => {
      if (options.loadError) throw options.loadError;
    }),
    getSerializedBody: vi.fn(() => ({ markdown: "review the diff", nodes })),
  };
  fake.handle = handle;
  const service = {
    update: vi.fn(async () => storedPrompt()),
    create: vi.fn(async () => storedPrompt()),
  };
  const onClose = vi.fn();
  render(
    createElement(QuickPromptEditorDialog, {
      target: { mode: "edit", prompt: options.prompt ?? storedPrompt() },
      onClose,
      project,
      projectName: "Demo",
      snapshot,
      service: service as unknown as IQuickPromptService,
      refresh: vi.fn(async () => undefined),
      workspacePath: "/repo",
      mentionPanelEnabled: options.mentionPanelEnabled,
    } as never),
  );
  return { handle, service, onClose };
}

/** Types into the stub editor the way ChatPromptEditor reports changes: through its onChange prop. */
function typeIntoEditor(markdown: string) {
  const onChange = fake.editorProps?.onChange as ((value: string) => void) | undefined;
  if (!onChange) throw new Error("editor stub not mounted");
  act(() => onChange(markdown));
}

const saveButton = () => screen.getByTestId("quick-prompt-editor-save") as HTMLButtonElement;
const nameInput = () => screen.getByTestId("quick-prompt-editor-name") as HTMLInputElement;

afterEach(() => {
  cleanup();
  fake.handle = null;
  fake.editorProps = null;
});

describe("quick prompt editor body safety (spec rule 15)", () => {
  it("enables Save only after the stored body loaded into the editor", async () => {
    const { handle } = setup({});
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    expect(handle.loadSerializedBody).toHaveBeenCalledWith(nodes);
  });

  it("reports a failed body load and never writes the empty editor back; a rename saves the name only", async () => {
    const { service } = setup({ loadError: new Error("unknown node type") });
    await waitFor(() =>
      expect(screen.getByTestId("quick-prompt-editor-load-error").textContent).toBe(
        "quickPrompts.editor.bodyLoadFailed",
      ),
    );
    // Unchanged name: nothing to save.
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(nameInput(), { target: { value: "Renamed" } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());

    await waitFor(() => expect(service.update).toHaveBeenCalledTimes(1));
    const payload = service.update.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toEqual({ promptId: "p1", name: "Renamed" });
    expect(payload).not.toHaveProperty("body");
    expect(service.create).not.toHaveBeenCalled();
  });

  it("disables Save for a blank body and enables it again once text is typed", async () => {
    const { service } = setup({});
    await waitFor(() => expect(saveButton().disabled).toBe(false));

    typeIntoEditor("   \n ");
    expect(saveButton().disabled).toBe(true);

    typeIntoEditor("review");
    expect(saveButton().disabled).toBe(false);
    expect(service.update).not.toHaveBeenCalled();
  });
});

describe("quick prompt editor file mentions for a non-window project (spec rule 19 scope)", () => {
  it("keeps the @ panel for the window's own project and shows no hint", async () => {
    setup({ mentionPanelEnabled: true });
    expect(fake.editorProps?.enableMentionPanel).toBe(true);
    expect(screen.queryByTestId("quick-prompt-editor-mentions-hint")).toBeNull();
  });

  it("disables the @ panel and explains where file mentions come from", async () => {
    setup({ mentionPanelEnabled: false });
    expect(fake.editorProps?.enableMentionPanel).toBe(false);
    expect(screen.getByTestId("quick-prompt-editor-mentions-hint").textContent).toBe(
      "quickPrompts.editor.mentionsUnavailable",
    );
  });
});
