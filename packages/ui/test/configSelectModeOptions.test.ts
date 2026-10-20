import { createElement, forwardRef, type ForwardedRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Locale } from "@zcode/shared";

const mockSelectContentProps: Array<{
  onCloseAutoFocus?: (event: { preventDefault: () => void }) => void;
}> = [];

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: unknown }) =>
    createElement("div", { "data-testid": "control-hint-tooltip" }, children),
}));

vi.mock("@/components/ai-elements/context.js", () => ({
  Context: ({ children }: { children: unknown }) => createElement("div", null, children),
  ContextContent: ({ children }: { children: unknown }) => createElement("div", null, children),
  ContextContentBody: ({ children }: { children: unknown }) => createElement("div", null, children),
  ContextContentHeader: () => createElement("div"),
  ContextTrigger: () => createElement("button"),
}));

vi.mock("@/components/ui/select.js", () => ({
  Select: ({ children }: { children: unknown }) =>
    createElement("div", { "data-testid": "select-root" }, children),
  SelectContent: ({
    children,
    onCloseAutoFocus,
  }: {
    children: unknown;
    onCloseAutoFocus?: (event: { preventDefault: () => void }) => void;
  }) => {
    mockSelectContentProps.push({ onCloseAutoFocus });
    return createElement("div", { "data-testid": "select-content" }, children);
  },
  SelectItem: forwardRef(function MockSelectItem(
    {
      children,
      value,
      className,
    }: {
      children: unknown;
      value: string;
      className?: string;
    },
    ref: ForwardedRef<HTMLDivElement>,
  ) {
    return createElement(
      "div",
      {
        ref,
        "data-slot": "select-item",
        "data-value": value,
        className,
      },
      children,
    );
  }),
  SelectTrigger: ({
    children,
    className,
    indicator,
  }: {
    children: unknown;
    className?: string;
    indicator?: unknown;
  }) =>
    createElement(
      "button",
      {
        "data-testid": "select-trigger",
        className,
      },
      children,
      indicator,
    ),
  SelectValue: () => createElement("span", null, "value"),
}));

vi.mock("@/components/ui/tooltip.js", () => ({
  TooltipProvider: ({ children }: { children: unknown }) =>
    createElement("div", { "data-testid": "tooltip-provider" }, children),
  Tooltip: ({ children }: { children: unknown }) =>
    createElement("div", { "data-testid": "tooltip-root" }, children),
  TooltipTrigger: ({ children }: { children: unknown }) => children,
  TooltipContent: ({ children, side }: { children: unknown; side?: string }) =>
    createElement(
      "div",
      {
        "data-testid": "tooltip-content",
        "data-side": side,
      },
      children,
    ),
}));

import { ConfigSelect, isHighPermissionModeValue } from "@/chat-input-toolbar/display.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { expectedCopy } from "./helpers/uiCopy.js";

beforeEach(() => {
  mockSelectContentProps.length = 0;
});

function renderConfigSelect(locale: Locale, props: Parameters<typeof ConfigSelect>[0]) {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, { initialLocale: locale }, createElement(ConfigSelect, props)),
  );
}

describe("ConfigSelect mode options", () => {
  it.each([
    ["zh-CN", "自主模式", "在有风险时询问"],
    ["en-US", "Autonomous mode", "Ask when there’s risk"],
  ] as const)(
    "Guarded uses the localized autonomous mode copy under %s and keeps normal permissions",
    (locale, label, description) => {
      const html = renderConfigSelect(locale, {
        provider: "glm",
        option: {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "guarded",
          options: [{ value: "guarded", name: "Guarded" }],
        },
        onValueChange: vi.fn(),
        tooltipTitle: "Mode",
      });
      expect(isHighPermissionModeValue("guarded")).toBe(false);
      expect(html).toContain(label);
      expect(html).toContain(description);
      expect(html).toContain('data-value="guarded"');

      expect(html).not.toContain("text-warning");
    },
  );

  it.each([
    ["zh-CN", "自动编辑"],
    ["en-US", "Edit automatically"],
  ] as const)(
    "the historical edit keeps its localized echo under %s without rejoining the candidates",
    (locale, label) => {
      const onValueChange = vi.fn();
      const html = renderConfigSelect(locale, {
        provider: "glm",
        option: {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "edit",
          options: [
            { value: "guarded", name: "Guarded" },
            { value: "yolo", name: "YOLO" },
          ],
        },
        onValueChange,
        tooltipTitle: "Mode",
      });
      expect(html).toContain(label);
      expect(html).not.toContain('data-value="edit"');
      expect(onValueChange).not.toHaveBeenCalled();
    },
  );

  it("closing the mode menu on a touch device does not refocus the chat input", () => {
    const focus = vi.fn();
    const preventDefault = vi.fn();
    const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        matchMedia: vi.fn(() => ({ matches: true })),
        removeEventListener: vi.fn(),
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelector: vi.fn(() => ({ focus })),
      },
    });

    try {
      renderConfigSelect("en-US", {
        provider: "codex",
        option: {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "read-only",
          options: [
            {
              value: "read-only",
              name: "read-only",
            },
          ],
        },
        onValueChange: () => {},
        tooltipTitle: "Mode",
      });

      mockSelectContentProps[0]?.onCloseAutoFocus?.({ preventDefault });

      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(document.querySelector).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
    } finally {
      if (originalWindowDescriptor) {
        Object.defineProperty(globalThis, "window", originalWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
      if (originalDocumentDescriptor) {
        Object.defineProperty(globalThis, "document", originalDocumentDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "document");
      }
    }
  });

  it("shows Chinese labels in the zh locale and displays the description in menu items", () => {
    const html = renderConfigSelect("zh-CN", {
      provider: "glm",
      option: {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "build",
        options: [
          {
            value: "build",
            name: "Build",
            description: "Require confirmation before edits.",
          },
          {
            value: "edit",
            name: "Edit",
          },
        ],
      },
      onValueChange: () => {},
      tooltipTitle: "Mode",
    });

    expect(html).toContain(zhCN["mode.label.glm.build"]);
    expect(html).toContain(zhCN["mode.label.glm.edit"]);
    expect(html).not.toContain("变更前确认 / Build");
    expect(html).toContain(zhCN["mode.description.glm.build"]);
  });

  it("the mode trigger uses the current copy instead of the SelectValue auto placeholder", () => {
    const html = renderConfigSelect("zh-CN", {
      provider: "glm",
      option: {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "build",
        options: [
          {
            value: "build",
            name: "Build",
          },
          {
            value: "edit",
            name: "Edit",
          },
        ],
      },
      onValueChange: () => {},
      tooltipTitle: "Mode",
    });

    expect(html).toContain(zhCN["mode.label.glm.build"]);
    expect(html).not.toContain(">value<");
  });

  it("shows English localized labels in the English locale", () => {
    const html = renderConfigSelect("en-US", {
      provider: "glm",
      option: {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "build",
        options: [
          {
            value: "build",
            name: "Build",
          },
          {
            value: "edit",
            name: "Edit",
          },
        ],
      },
      onValueChange: () => {},
      tooltipTitle: "Mode",
    });

    expect(html).toContain("Ask before changes");
    expect(html).toContain("Edit automatically");
    expect(html).not.toContain(expectedCopy("mode.label.glm.default"));
  });

  it("the GLM mode list renders only the modes returned by the agent", () => {
    const html = renderConfigSelect("zh-CN", {
      provider: "glm",
      option: {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "yolo",
        options: [
          { value: "build", name: "Build" },
          { value: "edit", name: "Edit" },
          { value: "plan", name: "Plan" },
          { value: "yolo", name: "Yolo" },
        ],
      },
      onValueChange: () => {},
      tooltipTitle: "Mode",
    });

    expect(html).toContain(zhCN["mode.label.glm.build"]);
    expect(html).toContain(zhCN["mode.label.glm.edit"]);
    expect(html).toContain(zhCN["mode.label.glm.plan"]);
    expect(html).toContain(zhCN["mode.label.glm.yolo"]);
    expect(html).toContain(zhCN["mode.description.glm.edit"]);
    expect(html).not.toContain("Auto");
  });

  it("selecting the edit mode does not show the high-permission warning color", () => {
    const html = renderConfigSelect("en-US", {
      provider: "glm",
      option: {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "edit",
        options: [
          {
            value: "edit",
            name: "Edit",
          },
        ],
      },
      onValueChange: () => {},
      tooltipTitle: "Mode",
      triggerClassName: "rounded-full text-ui-base/relaxed pl-3 pr-2",
    });

    expect(html).toContain('data-testid="select-trigger"');
    expect(html).not.toContain("text-warning");
  });

  it.each([
    ["claude", "bypassPermissions"],
    ["codex", "full-access"],
    ["codex", "agent-full-access"],
    ["gemini", "yolo"],
    ["glm", "yolo"],
  ] as const)(
    "selecting the high-permission mode %s/%s shows the warning color on the trigger text",
    (provider, currentValue) => {
      const html = renderConfigSelect("en-US", {
        provider,
        option: {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue,
          options: [
            {
              value: currentValue,
              name: currentValue,
            },
          ],
        },
        onValueChange: () => {},
        tooltipTitle: "Mode",
        triggerClassName: "rounded-full text-ui-base/relaxed pl-3 pr-2",
      });

      expect(html).toContain('data-testid="select-trigger"');
      expect(html).toContain("text-warning");
    },
  );

  it("a null restoreFocusSelector keeps Radix default refocusing (no preventDefault)", () => {
    // Bugfix regression: the Automations permission selector has no chat input to restore
    // focus to; previously onCloseAutoFocus unconditionally preventDefault'ed, and with null it
    // also swallowed Radix's default "refocus the trigger", dropping focus onto body.
    const focus = vi.fn();
    const preventDefault = vi.fn();
    const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        // Desktop pointer environment (not touch): the scenario where a non-null selector
        // should restore the input's focus.
        matchMedia: vi.fn(() => ({ matches: false })),
        removeEventListener: vi.fn(),
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelector: vi.fn(() => ({ focus })),
      },
    });

    try {
      renderConfigSelect("en-US", {
        provider: "glm",
        option: {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "build",
          options: [
            {
              value: "build",
              name: "build",
            },
          ],
        },
        onValueChange: () => {},
        tooltipTitle: "Mode",
        restoreFocusSelector: null,
      });

      mockSelectContentProps[0]?.onCloseAutoFocus?.({ preventDefault });

      expect(preventDefault).not.toHaveBeenCalled();
      expect(document.querySelector).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
    } finally {
      if (originalWindowDescriptor) {
        Object.defineProperty(globalThis, "window", originalWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
      if (originalDocumentDescriptor) {
        Object.defineProperty(globalThis, "document", originalDocumentDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "document");
      }
    }
  });

  it("without a provider, label/description falls back to the pre-localized entry", () => {
    // ConfigSelect still supports callers without a provider vocabulary supplying localized
    // names and descriptions directly.
    const html = renderConfigSelect("zh-CN", {
      option: {
        id: "mode",
        name: "Permission",
        category: "mode",
        type: "select",
        currentValue: "yolo",
        options: [
          { value: "build", name: "自定义确认", description: "自定义确认说明。" },
          { value: "yolo", name: "完全访问", description: "更少确认地执行。" },
        ],
      },
      onValueChange: () => {},
      tooltipTitle: "Permission",
    });

    expect(html).toContain("自定义确认");
    expect(html).toContain("完全访问");
    expect(html).toContain("自定义确认说明。");
    expect(html).toContain("更少确认地执行。");
    expect(html).not.toContain(zhCN["mode.label.glm.build"]);
    // High-privilege warning semantics depend only on entry.value, not on the provider.
    expect(html).toContain("text-warning");
  });
});
