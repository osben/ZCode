// @vitest-environment jsdom

// The **interaction** of the artifact chips at the tail of terminal notification rows
// (docs/dynamic-workflow/authoring.md "How the user sees them").
//
// Chip presence and the "+N" live in v4ConversationTurnGroup.test.ts (that is the static rendering surface of the
// whole notification row); clicking and "not expanding the row along the way" need a real DOM, hence this dedicated jsdom file.
//
// ⚠ Terminology: the artifact on a chip is an output the script delivered to the user via `artifact.*`, not the
// engine-internal synonym for "the script's top-level return value" (the spec's terminology table).
import { createElement } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TID_CHAT_WORKFLOW_ARTIFACT_CHIP } from "@zcode/shared";
import type { IPlatformService } from "@zcode/shared";
import type { AssistantTextRow, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowNotificationMeta } from "@zcode/shared/zcode-protocol-v4";

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServices: () => ({}),
}));

// eslint-disable-next-line import/first -- The component under test must be imported after the mocks.
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
// eslint-disable-next-line import/first
import { TooltipProvider } from "@/components/ui/tooltip.js";
// eslint-disable-next-line import/first
import { PlatformProvider } from "@/hooks/usePlatform.js";
// eslint-disable-next-line import/first
import { WorkflowNotificationToolRow } from "@/v4/WorkflowNotificationToolRow.js";
// eslint-disable-next-line import/first
import { ConversationTurnGroup } from "@/v4/ConversationTurnGroup.js";
// eslint-disable-next-line import/first
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
// eslint-disable-next-line import/first
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";

const onOpenArtifact = vi.fn();

function terminal(
  artifacts: NonNullable<Extract<WorkflowNotificationMeta, { kind: "terminal" }>["artifacts"]>,
): WorkflowNotificationMeta {
  return {
    kind: "terminal",
    status: "completed",
    summary: "Workflow run completed.",
    durationMs: 1000,
    result: "done",
    resultForm: "prose",
    artifacts,
  };
}

// ToolLayout records its expanded state by `persistOpenKey` in a module-level Map that is not cleared across cases;
// give each case its own key, otherwise one case expanding the row would hide the chips on the collapsed header from the next case.
let rowSeq = 0;

function renderRow(notification: WorkflowNotificationMeta, options: { openable?: boolean } = {}) {
  rowSeq += 1;
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        TooltipProvider,
        null,
        createElement(WorkflowNotificationToolRow, {
          notification,
          runName: "flaky-test-triage",
          testIdKey: `unit-${rowSeq}`,
          theme: "system",
          ...(options.openable === false ? {} : { onOpenArtifact }),
        }),
      ),
    ),
  );
}

beforeEach(() => {
  cleanup();
  onOpenArtifact.mockClear();
  // Assistant-body code blocks pick a color scheme via matchMedia; jsdom lacks it and the whole tree would explode on render.
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
});

describe("通知行的产物 chips", () => {
  it("点 chip 把产物 id 交给宿主", () => {
    const view = renderRow(
      terminal([
        { id: "book", kind: "file", title: "审计报告", version: 2 },
        { id: "perf", kind: "chart", title: "每轮耗时", version: 1 },
      ]),
    );
    const chips = view.getAllByTestId(TID_CHAT_WORKFLOW_ARTIFACT_CHIP);
    expect(chips).toHaveLength(2);

    fireEvent.click(chips[1]!);
    expect(onOpenArtifact).toHaveBeenCalledWith("perf");
  });

  it("点 chip 不顺带把通知行展开——头部整条是折叠开关，chip 的点击必须止步于自己", () => {
    const view = renderRow(terminal([{ id: "book", kind: "file", version: 1 }]));
    const trigger = view.container.querySelector("[aria-expanded]");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(view.getByTestId(TID_CHAT_WORKFLOW_ARTIFACT_CHIP));
    expect(onOpenArtifact).toHaveBeenCalledWith("book");
    expect(view.container.querySelector("[aria-expanded]")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("title 缺席时 chip 退回 id（facade 的缺省 title 本来就是 id）", () => {
    const view = renderRow(terminal([{ id: "book", kind: "file", version: 1 }]));
    expect(view.getByTestId(TID_CHAT_WORKFLOW_ARTIFACT_CHIP).textContent).toContain("book");
  });

  it("长标题在 chip 上截断，hover 提示里仍是完整的 kind 词 + 标题", () => {
    const long = "这是一个非常非常非常长的产物标题，长到必须在 chip 上被截断掉一部分才摆得下";
    const view = renderRow(terminal([{ id: "book", kind: "file", title: long, version: 1 }]));
    const chip = view.getByTestId(TID_CHAT_WORKFLOW_ARTIFACT_CHIP);
    expect(chip.textContent?.endsWith("…")).toBe(true);
    expect(chip.getAttribute("title")).toBe(`文件 · ${long}`);
  });

  it("宿主没注入打开能力时 chip 不可点，点了也什么都不发生", () => {
    const view = renderRow(terminal([{ id: "book", kind: "file", version: 1 }]), {
      openable: false,
    });
    const chip = view.getByTestId(TID_CHAT_WORKFLOW_ARTIFACT_CHIP);
    expect(chip.hasAttribute("disabled")).toBe(true);
    fireEvent.click(chip);
    expect(onOpenArtifact).not.toHaveBeenCalled();
  });

  it("点**禁用的** chip 同样不展开行：禁用只是把打开变成空操作，不是把 chip 交还给开关", () => {
  // Regression: before the strip, propagation was only stopped in the chip's own onClick, and React does not run
  // onClick on a disabled button, so that click bubbled all the way to the collapse toggle and expanded the whole row.
    const view = renderRow(terminal([{ id: "book", kind: "file", version: 1 }]), {
      openable: false,
    });
    expect(view.container.querySelector("[aria-expanded]")?.getAttribute("aria-expanded")).toBe(
      "false",
    );

    fireEvent.click(view.getByTestId(TID_CHAT_WORKFLOW_ARTIFACT_CHIP));

    expect(view.container.querySelector("[aria-expanded]")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(view.queryByTestId("workflow-notification-artifacts")).toBeTruthy();
    expect(onOpenArtifact).not.toHaveBeenCalled();
  });

  it("在 chip 上按 Enter 只打开产物，不顺带把行展开（键盘走的是开关的另一条通路）", () => {
    // The collapse toggle is a role=button div that listens for Enter/Space on its own keydown; keys pressed on
    // the chip bubble up to it. The strip therefore swallows both click and toggle keys.
    const view = renderRow(terminal([{ id: "book", kind: "file", version: 1 }]));
    fireEvent.keyDown(view.getByTestId(TID_CHAT_WORKFLOW_ARTIFACT_CHIP), { key: "Enter" });
    expect(view.container.querySelector("[aria-expanded]")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("展开之后 chips 收起——展开体自己在说结果，chips 再挂着只是重复", () => {
    const view = renderRow(terminal([{ id: "book", kind: "file", version: 1 }]));
    expect(view.queryByTestId("workflow-notification-artifacts")).toBeTruthy();

    fireEvent.click(view.container.querySelector("[aria-expanded]")!);
    expect(view.queryByTestId("workflow-notification-artifacts")).toBeNull();
  });
});

// ── Wiring (docs/dynamic-workflow/authoring.md "How the user sees them") ──
// The cases above pin the chip handing the **artifact id** to the layer above; here we pin what open request that
// layer turns the id into. The payload carries the latest version's `contentType`, which the host uses to open an
// html artifact directly as a browser tab instead of an artifact tab;
// the payload deliberately omits `sourcePath` (state-frame size), so the request must not invent one either.
describe("ConversationTurnGroup 把通知行的 chip 变成打开请求", () => {
  const noopPlatform = {} as IPlatformService;

  function notificationUnit(
    artifacts: NonNullable<Extract<WorkflowNotificationMeta, { kind: "terminal" }>["artifacts"]>,
  ) {
    const header: TurnHeaderRow = {
      rowId: 1,
      turnId: "turn-1",
      createdAt: 1_700_000_000_000,
      createdAtSeq: 1,
      kind: "turnHeader",
      origin: "backgroundResult",
      state: "completedSuccess",
      startedAt: 1_700_000_000_000,
      originMeta: {
        backgroundSource: "workflow",
        title: "flaky-test-triage",
        workId: "run-abc",
        workflowNotification: {
          kind: "terminal",
          status: "completed",
          summary: "Workflow run completed.",
          durationMs: 1000,
          artifacts,
        },
      },
    };
    const text: AssistantTextRow = {
      rowId: 2,
      entityId: "message-assistant-2",
      turnId: "turn-1",
      createdAt: 1_700_000_000_002,
      createdAtSeq: 2,
      kind: "assistantText",
      state: "complete",
      text: "后台总结最终段",
    };
    return buildConversationTurnRenderUnits([header, text])[0]!;
  }

  function renderTurn(
    artifacts: NonNullable<Extract<WorkflowNotificationMeta, { kind: "terminal" }>["artifacts"]>,
    onOpenWorkflowArtifact: (request: unknown) => void,
  ) {
    return render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          PlatformProvider,
          { platform: noopPlatform },
          createElement(
            TooltipProvider,
            null,
            createElement(ConversationTurnGroup, {
              unit: notificationUnit(artifacts),
              context: {
                workspacePath: "/workspace",
                theme: "system",
                sessionId: "parent-a",
                onOpenWorkflowArtifact,
              } as unknown as ConversationRowRenderContext,
            }),
          ),
        ),
      ),
    );
  }

  it("带上载荷里那一枚的 contentType（html 产物据它直接开浏览器 tab）", () => {
    const spy = vi.fn();
    const view = renderTurn(
      [
        { id: "book", kind: "file", title: "审计报告", version: 2, contentType: "text/html" },
        { id: "perf", kind: "chart", title: "每轮耗时", version: 1 },
      ],
      spy,
    );

    fireEvent.click(view.getAllByTestId(TID_CHAT_WORKFLOW_ARTIFACT_CHIP)[0]!);
    expect(spy).toHaveBeenCalledWith({
      parentSessionId: "parent-a",
      runId: "run-abc",
      artifactId: "book",
      contentType: "text/html",
    });
  });

  it("载荷上没有 contentType 的那一枚不编一个出来", () => {
    const spy = vi.fn();
    const view = renderTurn([{ id: "perf", kind: "chart", title: "每轮耗时", version: 1 }], spy);

    fireEvent.click(view.getByTestId(TID_CHAT_WORKFLOW_ARTIFACT_CHIP));
    expect(spy).toHaveBeenCalledWith({
      parentSessionId: "parent-a",
      runId: "run-abc",
      artifactId: "perf",
    });
  });
});
