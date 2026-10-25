// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { resolveToolCallRenderer } from "@/ToolCallBlocks/resolveRenderer.js";
import {
  formatContextWindow,
  ListModelsToolCallBlock,
  readListModelsResult,
} from "@/ToolCallBlocks/renderers/list-models.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import zhCN from "@/i18n/locales/zh-CN.js";

// The team plan's providerId is a UUID. It is this card's most important negative assertion: not a single character of it should appear on screen.
const TEAM_PROVIDER_UUID = "4fc7f541-2382-4c32-be11-f021b8d7ed1d";
const BUILTIN_BIGMODEL_PROVIDER_ID = BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan;

const CURRENT_MODEL_ID = `${BUILTIN_BIGMODEL_PROVIDER_ID}/GLM-5.3-Flash`;

const LIST_MODELS_DISPLAY = {
  kind: "list_models",
  current: CURRENT_MODEL_ID,
  models: [
    {
      id: CURRENT_MODEL_ID,
      providerId: BUILTIN_BIGMODEL_PROVIDER_ID,
      modelId: "GLM-5.3-Flash",
      reasoningLevels: ["low", "medium", "high"],
      defaultReasoningLevel: "high",
      contextWindow: 128_000,
    },
    {
      id: `${BUILTIN_BIGMODEL_PROVIDER_ID}/GLM-5.3`,
      providerId: BUILTIN_BIGMODEL_PROVIDER_ID,
      modelId: "GLM-5.3",
      reasoningLevels: ["low", "medium", "high", "max"],
      defaultReasoningLevel: "max",
      contextWindow: 200_000,
    },
    {
      id: `${TEAM_PROVIDER_UUID}/glm-4.7`,
      providerId: TEAM_PROVIDER_UUID,
      modelId: "glm-4.7",
      providerLabel: "MyProxy",
      reasoningLevels: [],
      contextWindow: 1_000_000,
    },
    {
      id: `${TEAM_PROVIDER_UUID}/deepseek-v4`,
      providerId: TEAM_PROVIDER_UUID,
      modelId: "deepseek-v4",
      providerLabel: "MyProxy",
      reasoningLevels: [],
      disabledReason: "no API key",
      contextWindow: 128_000,
    },
  ],
} as const;

function buildContext(
  toolCall: Record<string, unknown>,
  overrides: Partial<ToolCallBlockRenderContext> = {},
): ToolCallBlockRenderContext {
  return {
    toolCallNode: { toolCall, childToolCalls: [] },
    workspacePath: "/workspace",
    displayModel: {
      inlinePreview: { type: "none" },
      planResult: null,
      viewerSource: null,
      viewerLabelId: "codeViewer.viewCode",
      showSummaryFileLink: false,
      showInput: false,
      showOutput: false,
      showKind: false,
    },
    viewerSource: null,
    rawFileSummaries: [],
    isRunning: false,
    statusLabel: "",
    childToolList: null,
    showIcon: true,
    // The card body is collapsed by default; tests force it open to assert content.
    forceOpen: true,
    canToggle: false,
    ...overrides,
  } as ToolCallBlockRenderContext;
}

function renderCard(
  component: (context: ToolCallBlockRenderContext) => unknown,
  context: ToolCallBlockRenderContext,
  locale: "en-US" | "zh-CN" = "en-US",
) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(component as never, context),
    ),
  );
}

/** Rows are found by data-model-id: model ids contain `/` and `:`, and this jsdom has no CSS.escape. */
function rowByModelId(modelId: string): Element | undefined {
  return [...document.querySelectorAll("[data-model-id]")].find(
    (element) => element.getAttribute("data-model-id") === modelId,
  );
}

/** `null` means this call has no display channel (old session / degraded path); a default parameter would swallow undefined. */
function buildListModelsToolCall(
  display: unknown = LIST_MODELS_DISPLAY,
  overrides: Record<string, unknown> = {},
) {
  return {
    toolId: "tool-list-models-1",
    toolName: "ListModels",
    kind: "ListModels",
    title: "ListModels",
    status: "completed",
    input: {},
    // On the v4 wire, output.text is the model-facing `<models>` projection; the structured catalog only travels through the display channel.
    output: '<models count="4">…</models>',
    ...(display === null ? {} : { raw: { display } }),
    ...overrides,
  };
}

afterEach(cleanup);

describe("resolveToolCallRenderer list-models dispatch", () => {
  it("routes ListModels by name in both wire spellings", () => {
    // 前置事实：这个名字不在 shared 的已知工具表里，identity 会回 unknown。
    expect(resolveToolCallRenderer(buildContext(buildListModelsToolCall()))).toBe(
      ListModelsToolCallBlock,
    );
    const snakeCase = {
      ...buildListModelsToolCall(),
      toolName: "list_models",
      kind: "list_models",
      title: "list_models",
    };
    expect(resolveToolCallRenderer(buildContext(snakeCase))).toBe(ListModelsToolCallBlock);
  });

  it("does not steal ListSavedWorkflows", () => {
    const savedWorkflows = {
      toolId: "tool-list-saved-1",
      toolName: "ListSavedWorkflows",
      kind: "ListSavedWorkflows",
      title: "ListSavedWorkflows",
      status: "completed",
      input: {},
    };
    expect(resolveToolCallRenderer(buildContext(savedWorkflows))).not.toBe(ListModelsToolCallBlock);
  });
});

describe("formatContextWindow", () => {
  it("reads as K below a million and as M above it", () => {
    expect(formatContextWindow(128_000)).toBe("128K");
    expect(formatContextWindow(200_000)).toBe("200K");
    expect(formatContextWindow(1_000_000)).toBe("1M");
    expect(formatContextWindow(1_500_000)).toBe("1.5M");
    // 千位以下原样：一个四位数的窗口没有可缩写的东西。
    expect(formatContextWindow(512)).toBe("512");
  });
});

describe("ListModelsToolCallBlock", () => {
  it("prefers the list_models display over the model-facing text projection", () => {
    const result = readListModelsResult(buildListModelsToolCall());
    expect(result?.models).toHaveLength(4);
    expect(result?.current).toBe(CURRENT_MODEL_ID);
    // 读不懂就是 null——空目录与解析失败必须可分辨。
    expect(readListModelsResult(buildListModelsToolCall(null))).toBeNull();
  });

  it("names the count, groups by provider name, and never prints a provider id", () => {
    renderCard(ListModelsToolCallBlock, buildContext(buildListModelsToolCall()));

    expect(screen.getByText("Available models")).toBeTruthy();
    expect(screen.getByText("4 models")).toBeTruthy();
    // 内置家族 → 家族名；自定义 provider → 载荷里的 providerLabel。
    expect(screen.getByText("BigModel")).toBeTruthy();
    expect(screen.getByText("MyProxy")).toBeTruthy();
    expect(screen.getByText("GLM-5.3-Flash")).toBeTruthy();
    expect(screen.getByText("glm-4.7")).toBeTruthy();
    // 本卡最重要的负面断言：UUID 与内置 providerId 一个字符都不上屏。
    expect(document.body.textContent).not.toContain(TEAM_PROVIDER_UUID);
    expect(document.body.textContent).not.toContain(BUILTIN_BIGMODEL_PROVIDER_ID);
    // 通用兜底会打印整包 toolCall；专用卡必须没有这些结构键。
    expect(document.body.textContent).not.toContain('"toolId"');
    expect(document.body.textContent).not.toContain("models count");
  });

  it("marks only the session's own model as current and shows the context window", () => {
    renderCard(ListModelsToolCallBlock, buildContext(buildListModelsToolCall()));

    const currentTags = document.querySelectorAll('[data-model-current="true"]');
    expect(currentTags).toHaveLength(1);
    expect(currentTags[0]?.textContent).toBe("current");
    expect(rowByModelId(CURRENT_MODEL_ID)?.textContent).toContain("128K");
    // 不可选用的行把理由摆在模型名旁边。
    expect(screen.getByText("no API key")).toBeTruthy();
  });

  it("puts the thinking levels and the canonical id in the row tooltip", () => {
    renderCard(ListModelsToolCallBlock, buildContext(buildListModelsToolCall()));

    const title = rowByModelId(CURRENT_MODEL_ID)?.getAttribute("title") ?? "";
    expect(title).toContain("Thinking levels: Low · Medium · High (default High)");
    // 规范 id 只住在 tooltip 里——它是给机器回填 subagent_model 用的。
    expect(title).toContain(CURRENT_MODEL_ID);

    expect(rowByModelId(`${TEAM_PROVIDER_UUID}/glm-4.7`)?.getAttribute("title")).toContain(
      "No thinking levels",
    );
  });

  it("says the host has none rather than showing an empty body", () => {
    renderCard(
      ListModelsToolCallBlock,
      buildContext(buildListModelsToolCall({ kind: "list_models", models: [] })),
    );

    expect(screen.getByText("No models are configured on this host")).toBeTruthy();
    // 一个模型也没有时没有可展开的内容。
    expect(document.querySelector('[data-model-list="true"]')).toBeNull();
  });

  it("notes truncation without reporting a second number", () => {
    renderCard(
      ListModelsToolCallBlock,
      buildContext(buildListModelsToolCall({ ...LIST_MODELS_DISPLAY, truncated: true })),
    );

    expect(screen.getByText("Not all models are shown")).toBeTruthy();
  });

  it("shows the status word on a failed call instead of an empty list", () => {
    renderCard(
      ListModelsToolCallBlock,
      buildContext(buildListModelsToolCall(null, { status: "failed" }), {
        statusLabel: "Failed",
        errorText: "model_catalog_unavailable: this session cannot list models",
      }),
    );

    expect(screen.getByText("Available models")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    // 「读不到目录」不是「没有模型」：卡上既不画列表也不说那句空话。
    expect(document.querySelector('[data-model-list="true"]')).toBeNull();
    expect(document.body.textContent).not.toContain("No models are configured on this host");
  });

  it("falls back to the generic card when the result is unreadable", () => {
    renderCard(ListModelsToolCallBlock, buildContext(buildListModelsToolCall(null)));

    expect(document.querySelector('[data-model-list="true"]')).toBeNull();
    expect(document.body.textContent).not.toContain("No models are configured on this host");
  });

  it("renders both locales", () => {
    renderCard(ListModelsToolCallBlock, buildContext(buildListModelsToolCall()), "zh-CN");
    expect(screen.getByText(zhCN["chat.toolCall.workflow.models.listed"])).toBeTruthy();
    expect(
      screen.getByText(zhCN["chat.toolCall.workflow.models.count.other"].replace("{count}", "4")),
    ).toBeTruthy();
    expect(document.querySelector('[data-model-current="true"]')?.textContent).toBe("当前");
    expect(rowByModelId(CURRENT_MODEL_ID)?.getAttribute("title")).toContain(
      "思考强度：低 · 中 · 高（默认 高）",
    );
    cleanup();

    renderCard(
      ListModelsToolCallBlock,
      buildContext(buildListModelsToolCall(), { isRunning: true }),
      "zh-CN",
    );
    expect(screen.getByText(zhCN["chat.toolCall.workflow.models.listing"])).toBeTruthy();
  });

  it("uses the singular count for one model", () => {
    renderCard(
      ListModelsToolCallBlock,
      buildContext(
        buildListModelsToolCall({
          kind: "list_models",
          models: [LIST_MODELS_DISPLAY.models[0]],
        }),
      ),
    );

    expect(screen.getByText("1 model")).toBeTruthy();
  });

  it("falls back to the word Provider when nothing names the provider", () => {
    renderCard(
      ListModelsToolCallBlock,
      buildContext(
        buildListModelsToolCall({
          kind: "list_models",
          models: [
            {
              id: `${TEAM_PROVIDER_UUID}/mystery-model`,
              providerId: TEAM_PROVIDER_UUID,
              modelId: "mystery-model",
              reasoningLevels: [],
            },
          ],
        }),
      ),
    );

    expect(screen.getByText("Provider")).toBeTruthy();
    expect(document.body.textContent).not.toContain(TEAM_PROVIDER_UUID);
  });
});
