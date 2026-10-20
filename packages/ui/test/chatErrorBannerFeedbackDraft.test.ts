import type { IPlatformService } from "@zcode/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatErrorBanner } from "@/ChatErrorBanner.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { expectedCopy } from "./helpers/uiCopy.js";

const buttonMock = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/components/ui/button.js", async () => {
  const React = await import("react");
  return {
    Button: (props: Record<string, unknown>) => {
      buttonMock.props.push(props);
      const { children, size, variant, ...domProps } = props;
      void size;
      void variant;
      return React.createElement("button", domProps, children);
    },
  };
});

vi.mock("@/components/ui/toast.js", () => ({
  toast: vi.fn(),
}));

const mockPlatform = {
  captureWindowScreenshot: vi.fn(async () => null),
} as unknown as IPlatformService;

function resetFeedbackStore() {
  useFeedbackStore.setState({
    open: false,
    featureRequestOpen: false,
    tab: "submit",
    submitDraft: null,
    selectedTicketId: null,
  });
}

function renderErrorBanner() {
  renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(
        PlatformProvider,
        { platform: mockPlatform },
        createElement(ChatErrorBanner, {
          error: {
            code: "PROVIDER_AUTH_FAILED",
            message: "Provider authentication failed.",
            traceId: "trace-auth-failed",
          },
          onDismiss: vi.fn(),
        }),
      ),
    ),
  );
}

async function openFeedbackFromBanner() {
  const feedbackButton = buttonMock.props.find(
    (props) => props["aria-label"] === expectedCopy("chat.error.feedback"),
  );
  expect(feedbackButton).toBeDefined();
  if (!feedbackButton) {
    throw new Error("Feedback issue button was not rendered");
  }

  (feedbackButton.onClick as () => void)();
  await Promise.resolve();
  await Promise.resolve();
}

describe("ChatErrorBanner feedback draft", () => {
  beforeEach(() => {
    buttonMock.props = [];
    vi.clearAllMocks();
    resetFeedbackStore();
  });

  it("uses a compact one-line error summary without the generic investigation heading", async () => {
    renderErrorBanner();

    await openFeedbackFromBanner();

    expect(mockPlatform.captureWindowScreenshot).not.toHaveBeenCalled();
    expect(useFeedbackStore.getState().submitDraft?.includeLogs).toBe(true);
    const description = useFeedbackStore.getState().submitDraft?.description;
    expect(description).toContain(
      expectedCopy("feedback.submit.template.section.errorSummaryLine", {
        message: "Provider authentication failed.",
      }),
    );
    expect(description).toContain(
      expectedCopy("feedback.submit.template.section.errorTraceId", {
        traceId: "trace-auth-failed",
      }),
    );
    expect(description).not.toContain(
      expectedCopy("feedback.submit.template.section.errorHeading"),
    );
    expect(description).not.toContain(
      `${expectedCopy("feedback.submit.template.section.errorSummary")}\nProvider authentication failed.`,
    );
  });

  it("does not offer an unavailable upgrade action without an upgrade handler", () => {
    renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          PlatformProvider,
          { platform: mockPlatform },
          createElement(ChatErrorBanner, {
            error: {
              code: "model_config_missing",
              message: "Model config is missing.",
            },
            onOpenModelSettings: vi.fn(),
          }),
        ),
      ),
    );

    expect(
      buttonMock.props.some(
        (props) => props["aria-label"] === expectedCopy("chat.quota.action.upgrade"),
      ),
    ).toBe(false);
    expect(
      buttonMock.props.some(
        (props) => props["aria-label"] === expectedCopy("chat.error.setModels"),
      ),
    ).toBe(true);
  });

  it("remote workspace without a model only changes wording; actions stay local config and upgrade", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          PlatformProvider,
          { platform: mockPlatform },
          createElement(ChatErrorBanner, {
            error: {
              code: "model_config_missing",
              message: "Model config is missing.",
            },
            modelConfigTarget: "remote",
            onOpenModelSettings: vi.fn(),
            onOpenUpgrade: vi.fn(),
          }),
        ),
      ),
    );

    expect(html).toContain(expectedCopy("chat.error.remoteNoAvailableModel"));
    expect(html).not.toContain(expectedCopy("chat.error.noAvailableModel"));
    expect(
      buttonMock.props.some(
        (props) => props["aria-label"] === expectedCopy("chat.error.setModels"),
      ),
    ).toBe(true);
    expect(
      buttonMock.props.some(
        (props) => props["aria-label"] === expectedCopy("chat.quota.action.upgrade"),
      ),
    ).toBe(true);
    expect(buttonMock.props.some((props) => props["aria-label"] === "Sync now")).toBe(false);
  });
});

it("remote send race offers reconnect; feedback is attributed to connection failure, not model calls", async () => {
  const reconnect = vi.fn();
  renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(
        PlatformProvider,
        { platform: mockPlatform },
        createElement(ChatErrorBanner, {
          error: {
            code: "ZCODE_REMOTE_WORKSPACE_DISCONNECTED",
            message: "ZCODE_REMOTE_WORKSPACE_DISCONNECTED",
          },
          remoteKind: "ssh",
          onReconnect: reconnect,
        }),
      ),
    ),
  );
  const button = buttonMock.props.find(
    (props) => props.children === expectedCopy("remote.conversation.reconnect"),
  );
  expect(button).toBeDefined();
  (button!.onClick as () => void)();
  expect(reconnect).toHaveBeenCalledOnce();
  await openFeedbackFromBanner();
  expect(useFeedbackStore.getState().submitDraft?.module).toBe("SSH连接失败");
});
