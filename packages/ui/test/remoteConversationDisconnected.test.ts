// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import enUS from "@/i18n/locales/en-US.js";
const ports = vi.hoisted(() => ({ reconnect: vi.fn(), details: vi.fn() }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: keyof typeof enUS }) => enUS[id] ?? id },
  }),
}));
vi.mock("@/project-sidebar/useRemoteProjectConnectionPresentation.js", () => ({
  useRemoteProjectConnectionPresentation: () => ({
    presentation: {
      status: "offline",
      icon: "cloud-off",
      tone: "neutral",
      messageId: "remote.status.offline",
      surface: "bg-surface",
      foreground: "text-foreground-subtle",
      primaryAction: "connect",
      actionMessageId: "remote.action.connect",
    },
    reconnect: ports.reconnect,
    tab: null,
    deviceName: "dev",
    error: undefined,
  }),
}));
import { expectedCopy } from "./helpers/uiCopy.js";
import { RemoteConversationDisconnected } from "@/project-sidebar/RemoteConversationDisconnected.js";
import { persistV4ComposerDraft, readV4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});
describe("disconnected session placeholder", () => {
  it("shows the reason, a read-only draft and a reconnect entry; Enter does not submit and reconnect keeps the draft", () => {
    const identity = "remote:server:dev:/repo";
    persistV4ComposerDraft("/repo", identity, "task-a", { text: "Keep this draft" });
    render(
      createElement(RemoteConversationDisconnected, {
        workspacePath: "/repo",
        workspaceIdentity: identity,
        sessionId: "task-a",
      }),
    );
    expect(screen.getByText(expectedCopy("remote.conversation.placeholder"))).toBeTruthy();
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(input.value).toBe("Keep this draft");
    expect(input.readOnly).toBe(true);
    expect(
      (screen.getByRole("button", { name: expectedCopy("chat.send") }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(ports.reconnect).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: expectedCopy("remote.conversation.reconnect") }),
    );
    expect(ports.reconnect).toHaveBeenCalledOnce();
    expect(readV4ComposerDraft("/repo", identity, "task-a")?.text).toBe("Keep this draft");
  });
});

it("the offline project placeholder has a single-line connect entry and renders no stale tasks", async () => {
  const { OfflineRemoteProjectRows } =
    await import("@/project-sidebar/OfflineRemoteProjectRows.js");
  const reconnect = vi.fn();
  render(
    createElement(OfflineRemoteProjectRows, {
      workspaceTabs: [
        {
          id: "remote",
          kind: "workspace",
          label: "Project",
          workspacePath: "/repo",
          workspaceIdentity: "remote:server:dev:/repo",
        },
      ],
      onReconnect: reconnect,
    }),
  );
  fireEvent.click(screen.getByRole("button"));
  expect(reconnect).toHaveBeenCalledWith("remote:server:dev:/repo");
  expect(screen.getAllByRole("button")).toHaveLength(1);
});
