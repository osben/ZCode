// @vitest-environment jsdom

import type { IPlatformService } from "@zcode/shared";
import { createElement, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationPinnedBar, selectPinnedRows } from "@/v4/ConversationPinnedBar.js";
import { ConversationAssistantTextActions, ConversationRowView } from "@/v4/ConversationRowView.js";

const actionCapture = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
}));
const reportAppTelemetryEvent = vi.hoisted(() => vi.fn());

vi.mock("@/components/ai-elements/message.js", async () => {
  const React = await import("react");
  return {
    MessageAction: (props: Record<string, unknown>) => {
      actionCapture.props.push(props);
      return React.createElement("button", { type: "button" }, props.children);
    },
    MessageActions: (props: Record<string, unknown>) =>
      React.createElement("div", null, props.children),
    MessageResponse: (props: Record<string, unknown>) =>
      React.createElement("div", null, props.children),
  };
});

vi.mock("@/lib/appTelemetry.js", () => ({ reportAppTelemetryEvent }));

const platform = {
  reportTelemetryEvent: vi.fn(async () => undefined),
} as unknown as IPlatformService;

function providers(children: ReactNode) {
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: "zh-CN" },
    createElement(PlatformProvider, { platform }, children),
  );
}

function pinAction(): Record<string, unknown> {
  const action = [...actionCapture.props]
    .reverse()
    .find((props) => String(props["data-testid"] ?? "") === "v4-pin-9");
  if (!action) throw new Error("missing pin action v4-pin-9");
  return action;
}

const assistantRowBase = {
  rowId: 9,
  turnId: "t-1",
  entityId: "assistant-entity-9",
  createdAt: 1000,
  createdAtSeq: 1,
  kind: "assistantText",
  text: "answer",
  state: "complete",
} as const;

const userInputRow = {
  rowId: 3,
  turnId: "t-1",
  entityId: "user-entity-3",
  createdAt: 900,
  createdAtSeq: 1,
  kind: "userInput",
  text: "old question",
  origin: "realUser",
  pinnedAt: 100,
} as const;

const assistantPinnedRow = {
  ...assistantRowBase,
  text: "new answer",
  pinnedAt: 200,
};

describe("V4 message pins", () => {
  beforeEach(() => {
    actionCapture.props = [];
    reportAppTelemetryEvent.mockClear();
  });
  afterEach(() => cleanup());

  it("点击 pin 立即提交 setRowPinned 回调并上报 message_pin", async () => {
    const onPinChange = vi.fn(async () => true);
    render(
      providers(
        createElement(ConversationAssistantTextActions, {
          rowId: 9,
          entityId: "assistant-entity-9",
          text: "answer",
          createdAt: 1,
          sessionId: "session-1",
          onPinChange,
        }),
      ),
    );

    await act(async () => {
      (pinAction().onClick as () => void)();
    });

    expect(onPinChange).toHaveBeenCalledWith({ rowId: 9, entityId: "assistant-entity-9" }, true);
    expect(reportAppTelemetryEvent).toHaveBeenCalledWith(
      platform,
      {
        elementName: "message_pin",
        eventRegion: "chat",
        eventType: "ck",
        eventExtraDetail: { pinned: "pinned" },
        talkId: "session-1",
        messageId: "assistant-entity-9",
      },
      "ConversationRowView",
    );
  });

  it("已固定行再次点击提交 false；命令被拒绝时回滚为未固定", async () => {
    // 用 deferred 分离两个 commit：promise 挂起时先断言乐观取消固定，resolve 后断言回滚。
    let resolvePin!: (value: false) => void;
    const onPinChange = vi.fn(() => new Promise<false>((resolve) => (resolvePin = resolve)));
    render(
      providers(
        createElement(ConversationAssistantTextActions, {
          rowId: 9,
          entityId: "assistant-entity-9",
          text: "answer",
          createdAt: 1,
          sessionId: "session-1",
          pinnedAt: 123,
          onPinChange,
        }),
      ),
    );
    const sequence = () =>
      actionCapture.props
        .filter((props) => props["data-testid"] === "v4-pin-9")
        .map((props) => props["aria-pressed"]);
    expect(sequence().at(-1)).toBe(true);

    await act(async () => {
      (pinAction().onClick as () => void)();
    });
    expect(onPinChange).toHaveBeenCalledWith({ rowId: 9, entityId: "assistant-entity-9" }, false);
    // 乐观取消固定已提交，promise 仍挂起。
    expect(sequence().at(-1)).toBe(false);
    // 拒绝（返回 false）后回滚为已固定。
    await act(async () => {
      resolvePin(false);
    });
    expect(sequence().at(-1)).toBe(true);
  });

  it("只读视图未提供 onPinChange 时不展示伪 pin 入口", () => {
    render(
      providers(
        createElement(ConversationAssistantTextActions, {
          rowId: 9,
          entityId: "assistant-entity-9",
          text: "answer",
          createdAt: 1,
        }),
      ),
    );
    expect(actionCapture.props.some((props) => props["data-testid"] === "v4-pin-9")).toBe(false);
    expect(reportAppTelemetryEvent).not.toHaveBeenCalled();
  });

  it("pinned bar：按 pinnedAt 降序渲染 chip，点击定位，chip 内取消固定，空态不渲染", () => {
    const onJumpToRow = vi.fn();
    const onUnpin = vi.fn();

    const { container, rerender } = render(
      providers(
        createElement(ConversationPinnedBar, {
          rows: [userInputRow, assistantPinnedRow],
          onJumpToRow,
          onUnpin,
        }),
      ),
    );

    // 新固定在前。
    const chips = screen.getAllByTestId(/^v4-pinned-chip-\d+$/);
    expect(chips.map((chip) => chip.dataset.testid)).toEqual([
      "v4-pinned-chip-9",
      "v4-pinned-chip-3",
    ]);
    expect(chips[0]?.textContent).toContain("new answer");

    fireEvent.click(screen.getByTestId("v4-pinned-chip-9").querySelector("button")!);
    expect(onJumpToRow).toHaveBeenCalledWith(9);

    fireEvent.click(screen.getByTestId("v4-pinned-chip-unpin-3"));
    expect(onUnpin).toHaveBeenCalledWith(expect.objectContaining({ rowId: 3 }));

    // 空状态：无 pinned 行时整个 bar 不渲染。
    rerender(
      providers(
        createElement(ConversationPinnedBar, {
          rows: [{ ...userInputRow, pinnedAt: undefined }],
          onJumpToRow,
          onUnpin,
        }),
      ),
    );
    expect(container.querySelector("[data-v4-pinned-bar]")).toBeNull();
  });

  it("系统生成 user 行（非 realUser）不渲染 pin 入口；realUser 行渲染", () => {
    const rowContext = {
      codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
      messageStreamShowReasoning: true,
      sessionId: "session-1",
      theme: "system",
      workspacePath: "/workspace",
    } as const;
    const renderUserRow = (origin: "realUser" | "backgroundResult") =>
      render(
        providers(
          createElement(ConversationRowView, {
            row: {
              rowId: 42,
              entityId: "user-entity-42",
              turnId: "t-1",
              createdAt: 900,
              createdAtSeq: 1,
              kind: "userInput",
              origin,
              text: "question",
            },
            context: rowContext,
            onPinChange: () => true,
          }),
        ),
      );

    renderUserRow("backgroundResult");
    expect(actionCapture.props.some((props) => props["data-testid"] === "v4-pin-42")).toBe(false);
    cleanup();

    renderUserRow("realUser");
    expect(actionCapture.props.some((props) => props["data-testid"] === "v4-pin-42")).toBe(true);
  });

  it("selectPinnedRows 只挑 assistant/user 行并按 pinnedAt 降序", () => {
    const rows = [
      { kind: "reasoning", rowId: 1 },
      userInputRow,
      assistantPinnedRow,
      { ...assistantRowBase },
    ] as unknown as readonly { kind: string; rowId: number }[];
    const pinned = selectPinnedRows(rows as never);
    expect(pinned.map((row) => row.rowId)).toEqual([9, 3]);
  });
});
