// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZCodePermissionRequest } from "@zcode/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { PermissionDialog } from "@/PermissionDialog.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { V4InteractionDialogs } from "@/v4/V4InteractionDialogs.js";
import { expectedCopy } from "./helpers/uiCopy.js";

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({ sendCommand: vi.fn() }),
}));

function installAnimationFrameController() {
  let nextFrameId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    const frameId = nextFrameId;
    nextFrameId += 1;
    callbacks.set(frameId, callback);
    return frameId;
  });
  const cancelAnimationFrame = vi.fn((frameId: number) => {
    callbacks.delete(frameId);
  });
  vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);

  return {
    flush() {
      const pendingCallbacks = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pendingCallbacks) {
        callback(performance.now());
      }
    },
  };
}

function permissionSnapshot(interactionId: string): ConversationSnapshot {
  return {
    sessionId: "task-focus",
    pendingInteractions: [
      {
        interactionId,
        kind: "permission",
        anchorRowId: null,
        createdAt: 1,
        payload: {
          kind: "permission",
          toolCallId: `tool-${interactionId}`,
          toolName: "Bash",
          summary: "Run ls",
          detail: { command: "ls" },
          freeText: true,
          options: [
            { optionId: "allowOnce", kind: "allowOnce", label: "Allow once" },
            { optionId: "deny", kind: "deny", label: "Deny" },
          ],
        },
      },
    ],
  } as ConversationSnapshot;
}

describe("PermissionDialog focus", () => {
  beforeEach(() => {
    // jsdom does not provide ResizeObserver; focus tests do not depend on layout,
    // and real command overflow is covered by browser E2E.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const request: ZCodePermissionRequest = {
    type: "permission_request",
    taskId: "task-focus",
    traceId: "trace-focus",
    requestId: "request-focus",
    description: "Run ls",
    kind: "Bash",
    freeText: true,
    options: [
      {
        optionId: "allow_once",
        kind: "allow_once",
        name: "Allow once",
        response: { decision: "allow" },
      },
      {
        optionId: "allow_project",
        kind: "allow_project",
        name: "Allow project",
        response: { decision: "allow" },
      },
      { optionId: "deny", kind: "deny", name: "Deny", response: { decision: "deny" } },
    ],
    raw: { command: "ls" },
  };

  function renderPermission(freeText = true, fullAccess = false) {
    const animationFrame = installAnimationFrameController();
    const onRespond = vi.fn();
    const view = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(PermissionDialog, {
          request: {
            ...request,
            freeText,
            options: fullAccess
              ? [
                  request.options[0]!,
                  {
                    ...request.options[1]!,
                    kind: "allow_always",
                    name: "Always allow in this project",
                  },
                  {
                    optionId: "fullAccess",
                    kind: "custom",
                    name: "Full access",
                    response: { decision: "deny" },
                  },
                  request.options[2]!,
                ]
              : request.options,
          },
          onRespond,
          workspacePath: "/tmp/workspace",
        }),
      ),
    );
    const flush = () => act(() => animationFrame.flush());
    flush();
    return {
      ...view,
      onRespond,
      flush,
      options: view.getAllByRole("option"),
      input: view.queryByRole("textbox") as HTMLTextAreaElement | null,
      confirm: view.getByRole("button", {
        name: expectedCopy("common.confirm"),
      }) as HTMLButtonElement,
    };
  }

  it("places full access third, digit 5 focuses only feedback, and the third option submits with its original optionId", () => {
    const { input, options, flush, onRespond, confirm } = renderPermission(true, true);
    expect(options).toHaveLength(4);
    expect(options[2]!.textContent).toContain(expectedCopy("chat.permission.fullAccess"));
    expect(input!.previousElementSibling?.textContent).toBe("5.");
    fireEvent.keyDown(options[0]!, { key: "5" });
    flush();
    expect(document.activeElement).toBe(input);
    expect(onRespond).not.toHaveBeenCalled();
    fireEvent.keyDown(input!, { key: "ArrowUp" });
    flush();
    expect(document.activeElement).toBe(options[3]);
    fireEvent.keyDown(options[3]!, { key: "ArrowUp" });
    flush();
    expect(document.activeElement).toBe(options[2]);
    fireEvent.click(confirm);
    expect(onRespond).toHaveBeenCalledWith(
      "request-focus",
      expect.objectContaining({ optionId: "fullAccess" }),
      undefined,
    );
  });

  it("binds every numbered row to its digit, so 4 selects Deny and 4 + Enter denies (ISSUE-057)", () => {
    const { options, flush, onRespond } = renderPermission(true, true);
    for (const [index, option] of options.entries()) {
      expect(option.textContent).toContain(`${index + 1}.`);
    }
    for (const [index, option] of [...options.entries()].reverse()) {
      fireEvent.keyDown(document.activeElement!, { key: String(index + 1) });
      flush();
      expect(document.activeElement).toBe(option);
      expect(option.getAttribute("aria-selected")).toBe("true");
    }
    fireEvent.keyDown(document.activeElement!, { key: "4" });
    flush();
    expect(document.activeElement).toBe(options[3]);
    expect(onRespond).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(onRespond).toHaveBeenCalledExactlyOnceWith(
      "request-focus",
      expect.objectContaining({ optionId: "deny", kind: "deny" }),
      undefined,
    );
  });

  it("gives feedback its own numbered row in the arrow and Tab focus cycle", () => {
    const { input, options, flush, onRespond, confirm } = renderPermission();
    const feedbackRow = input!.parentElement!;
    expect(feedbackRow.previousElementSibling).toBe(options[0]!.parentElement);
    expect(input!.closest('[role="listbox"]')).toBeNull();
    const key = (key: string, shiftKey = false) => {
      fireEvent.keyDown(document.activeElement!, { key, shiftKey });
      flush();
    };
    expect(document.activeElement).toBe(options[0]);
    expect(input!.previousElementSibling?.textContent).toBe("4.");
    key("ArrowUp");
    expect(document.activeElement).toBe(input);
    expect(feedbackRow.classList.contains("bg-selected")).toBe(true);
    expect(options.every((option) => option.getAttribute("aria-selected") === "false")).toBe(true);
    expect(confirm.disabled).toBe(true);
    key("Enter");
    expect(onRespond).not.toHaveBeenCalled();

    fireEvent.change(input!, { target: { value: " keep feedback " } });
    key("ArrowUp");
    expect(document.activeElement).toBe(options[2]);
    expect(options[2]!.getAttribute("aria-selected")).toBe("true");
    expect(feedbackRow.classList.contains("bg-selected")).toBe(false);
    key("Tab");
    expect(document.activeElement).toBe(input);
    key("Tab", true);
    expect(document.activeElement).toBe(options[2]);
    key("ArrowDown");
    expect(document.activeElement).toBe(input);
    key("ArrowDown");
    expect(document.activeElement).toBe(options[0]);
    key("4");
    expect(document.activeElement).toBe(input);
    key("Tab");
    expect(document.activeElement).toBe(options[0]);
    key("Tab", true);
    expect(document.activeElement).toBe(input);
    expect(input!.value).toBe(" keep feedback ");
    expect(onRespond).not.toHaveBeenCalled();
  });

  it.each(["Enter", "confirm"])(
    "submits feedback as Deny via %s without selecting the Deny row",
    (method) => {
      const { input, options, flush, confirm, onRespond } = renderPermission();
      act(() => input!.focus());
      fireEvent.change(input!, { target: { value: "  explain first\nthen fix  " } });
      flush();
      expect(options[2]!.getAttribute("aria-selected")).toBe("false");
      expect(confirm.disabled).toBe(false);
      if (method === "Enter") fireEvent.keyDown(input!, { key: "Enter" });
      else fireEvent.click(confirm);
      expect(onRespond).toHaveBeenCalledExactlyOnceWith(
        request.requestId,
        request.options[2],
        "explain first\nthen fix",
      );
    },
  );

  it("keeps IME navigation and Escape local to feedback, and ignores the draft when allowing", () => {
    const { input, options, flush, confirm, onRespond } = renderPermission();
    act(() => input!.focus());
    fireEvent.change(input!, { target: { value: "explain first" } });
    for (const key of ["ArrowUp", "ArrowDown", "Enter"]) {
      fireEvent.keyDown(input!, { key, isComposing: true });
      flush();
      expect(document.activeElement).toBe(input);
    }
    fireEvent.compositionStart(input!);
    fireEvent.keyDown(input!, { key: "ArrowUp" });
    flush();
    expect(document.activeElement).toBe(input);
    fireEvent.compositionEnd(input!);
    fireEvent.keyDown(input!, { key: "Escape" });
    expect(document.activeElement).not.toBe(input);
    expect(onRespond).not.toHaveBeenCalled();
    act(() => options[0]!.focus());
    fireEvent.click(confirm);
    expect(onRespond).toHaveBeenCalledExactlyOnceWith(
      request.requestId,
      request.options[0],
      undefined,
    );
  });

  it("preserves three-option navigation and plain Deny without feedback capability", () => {
    const { input, options, flush, confirm, onRespond } = renderPermission(false);
    expect(input).toBeNull();
    fireEvent.keyDown(options[0]!, { key: "ArrowUp" });
    flush();
    expect(document.activeElement).toBe(options[2]);
    fireEvent.click(confirm);
    expect(onRespond).toHaveBeenCalledExactlyOnceWith(
      request.requestId,
      request.options[2],
      undefined,
    );
  });

  it("does not steal feedback input focus from a queued option focus frame", () => {
    const animationFrame = installAnimationFrameController();

    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(PermissionDialog, {
          request: {
            type: "permission_request",
            taskId: "task-focus",
            traceId: "trace-focus",
            requestId: "request-focus",
            description: "Run ls",
            kind: "Bash",
            freeText: true,
            options: [
              {
                optionId: "allow_once",
                kind: "allow_once",
                name: "Allow once",
                response: { decision: "allow" },
              },
              {
                optionId: "deny",
                kind: "deny",
                name: "Deny",
                response: { decision: "deny" },
              },
            ],
            raw: { command: "ls" },
          },
          onRespond: () => {},
          workspacePath: "/tmp/workspace",
        }),
      ),
    );

    const feedbackInput = document.querySelector<HTMLTextAreaElement>(
      `textarea[aria-label="${expectedCopy("chat.permission.feedback.ariaLabel")}"]`,
    );
    expect(feedbackInput).not.toBeNull();

    act(() => {
      feedbackInput?.focus();
      animationFrame.flush();
    });

    expect(document.activeElement).toBe(feedbackInput);
  });

  it("remounts the dialog when the pending permission changes", () => {
    installAnimationFrameController();
    const renderDialog = (interactionId: string) =>
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(V4InteractionDialogs, {
          sessionId: "task-focus",
          workspacePath: "/tmp/workspace",
          snapshot: permissionSnapshot(interactionId),
        }),
      );
    const view = render(renderDialog("permission-a"));
    const firstInput = document.querySelector<HTMLTextAreaElement>(
      `textarea[aria-label="${expectedCopy("chat.permission.feedback.ariaLabel")}"]`,
    );
    expect(firstInput).not.toBeNull();

    act(() => firstInput?.focus());
    view.rerender(renderDialog("permission-b"));

    const secondInput = document.querySelector<HTMLTextAreaElement>(
      `textarea[aria-label="${expectedCopy("chat.permission.feedback.ariaLabel")}"]`,
    );
    expect(secondInput).not.toBe(firstInput);
  });
});
