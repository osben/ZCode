import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  TID_V4_ATTACHMENT_UPLOAD_PROGRESS,
  TID_V4_ATTACHMENT_UPLOAD_RETRY,
  TID_V4_COMPOSER_SEND,
  testId,
} from "@zcode/shared/test-ids";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationComposer } from "@/v4/ConversationComposer.js";
import { expectedCopy } from "./helpers/uiCopy.js";

const attachmentState = vi.hoisted(() => ({
  attachments: [] as Array<Record<string, unknown>>,
  hookOptions: [] as Array<Record<string, unknown>>,
  retryAttachment: vi.fn(),
}));

const cuaEntryProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@/ControlHintTooltip.js", async () => {
  const React = await import("react");
  return {
    ControlHintTooltip: ({ children }: { children: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

vi.mock("@/prompt-editor/ChatPromptEditor.js", async () => {
  const React = await import("react");
  return {
    ChatPromptEditor: (props: Record<string, unknown>) =>
      React.createElement(
        "form",
        null,
        props.topContent as ReactNode,
        props.leadingActions as ReactNode,
        props.submitControl as ReactNode,
      ),
  };
});

vi.mock("@/components/ai-elements/attachments.js", async () => {
  const React = await import("react");
  const Container = ({
    children,
    data,
    openLabel: _openLabel,
    ...props
  }: { children?: ReactNode; data?: { url?: string } } & Record<string, unknown>) =>
    React.createElement(
      "div",
      { ...props, "data-composer-attachment-url": data?.url ?? "" },
      children,
    );
  return {
    Attachment: Container,
    AttachmentHoverCard: Container,
    AttachmentHoverCardContent: Container,
    AttachmentHoverCardTrigger: ({ children }: { children?: ReactNode }) => children,
    AttachmentInfo: (props: Record<string, unknown>) => React.createElement("span", props),
    AttachmentPreview: ({ fallbackIcon: _fallbackIcon, ...props }: Record<string, unknown>) =>
      React.createElement("span", props),
    AttachmentRemove: (props: Record<string, unknown>) => React.createElement("button", props),
    Attachments: Container,
  };
});

vi.mock("@/components/ai-elements/image-preview-dialog.js", async () => {
  const React = await import("react");
  return {
    ImagePreviewDialog: ({ items }: { items: Array<{ filename?: string }> }) =>
      React.createElement("div", {
        "data-composer-image-preview": items.map((item) => item.filename).join(","),
      }),
  };
});

vi.mock("@/v4/composer/useComposerAttachments.js", () => ({
  useComposerAttachments: (options: Record<string, unknown>) => {
    attachmentState.hookOptions.push(options);
    return {
      attachmentError: null,
      adoptSentAttachments: vi.fn(async () => {}),
      attachmentInputRef: { current: null },
      attachments: attachmentState.attachments,
      clearAttachments: vi.fn(),
      handleAttachmentInputChange: vi.fn(),
      handleDragLeaveComposer: vi.fn(),
      handleDragOverComposer: vi.fn(),
      handleDropComposer: vi.fn(),
      handlePaste: vi.fn(),
      handleWhiteboardMentionSelected: vi.fn(),
      hasAttachments: attachmentState.attachments.length > 0,
      hasUnreadyAttachments: attachmentState.attachments.some(
        (item) => item.uploadStatus !== "ready",
      ),
      isDraggingOverComposer: false,
      openAttachmentPicker: vi.fn(),
      prepareForSend: vi.fn(async () => null),
      removeAttachment: vi.fn(),
      retryAttachment: attachmentState.retryAttachment,
      setAttachmentError: vi.fn(),
    };
  },
}));

vi.mock("@/v4/composer/V4ComposerCuaEntry.js", async () => {
  const React = await import("react");
  return {
    V4ComposerCuaEntry: (props: Record<string, unknown>) => {
      cuaEntryProps.push(props);
      return React.createElement("span", { "data-cua-entry": "true" });
    },
  };
});

vi.mock("@/v4/composer/V4ComposerToolbar.js", async () => {
  const React = await import("react");
  return {
    V4ComposerModeSwitch: () => React.createElement("span"),
    V4ComposerModelControls: () => React.createElement("span"),
  };
});

const AnyConversationComposer = ConversationComposer as unknown as ComponentType<
  Record<string, unknown>
>;

function renderComposer(overrides: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(AnyConversationComposer, {
        draftMode: true,
        onSelectModel: vi.fn(),
        onSelectThought: vi.fn(),
        onSendText: vi.fn(async () => {}),
        onStop: vi.fn(),
        onSwitchMode: vi.fn(),
        sessionId: null,
        snapshot: null,
        workspacePath: "/workspace",
        ...overrides,
      }),
    ),
  );
}

describe("ConversationComposer attachment upload progress", () => {
  it("only lets a focused, enabled composer listen to add-to-chat and keeps the persistent CUA entry", () => {
    const html = renderComposer({
      disabled: true,
      isWebRemoteControl: true,
      listenAddToChatEvents: false,
      remoteSessionId: "remote-1",
    });

    expect(attachmentState.hookOptions.at(-1)).toMatchObject({
      listenAddToChatEvents: false,
    });
    expect(html).toContain('data-cua-entry="true"');
    expect(cuaEntryProps.at(-1)).toMatchObject({
      currentSessionBusy: false,
      isWebRemoteControl: true,
      remoteSessionId: "remote-1",
      workspacePath: "/workspace",
    });
  });

  it("images show the upload ring and percentage, and the send button is disabled while not ready", () => {
    attachmentState.attachments = [
      {
        adopted: false,
        autoRetryCount: 0,
        filename: "image.png",
        id: "image-1",
        localZeroCopy: false,
        referenceOwnership: "composer",
        mimeType: "image/png",
        objectUrl: "blob:image-1",
        operationId: "operation-image-1",
        showComplete: false,
        sizeBytes: 100,
        staged: false,
        uploadProgress: 42,
        uploadStatus: "uploading",
      },
    ];

    const html = renderComposer();

    expect(html).toContain(`data-testid="${testId(TID_V4_ATTACHMENT_UPLOAD_PROGRESS, "image-1")}"`);
    expect(html).toContain('role="status"');
    expect(html).toContain("42%");
    expect(html).toContain('stroke-dasharray="42 100"');
    expect(html).toContain('data-composer-attachment-kind="image"');
    expect(html).toContain('data-composer-image-preview="image.png"');
    expect(html).toContain(`disabled="" data-testid="${TID_V4_COMPOSER_SEND}"`);
  });

  it("composer attachments sort media (image/video) before files and keep insertion order inside the media group", () => {
    attachmentState.attachments = [
      {
        adopted: false,
        autoRetryCount: 0,
        filename: "SNAKE-ARENA.md",
        id: "file-first",
        localZeroCopy: false,
        referenceOwnership: "composer",
        mimeType: "text/markdown",
        operationId: "operation-file-first",
        showComplete: false,
        sizeBytes: 100,
        staged: false,
        uploadProgress: 100,
        uploadStatus: "ready",
      },
      {
        adopted: false,
        autoRetryCount: 0,
        filename: "avatar.png",
        id: "image-second",
        localZeroCopy: false,
        referenceOwnership: "composer",
        mimeType: "image/png",
        objectUrl: "blob:image-second",
        operationId: "operation-image-second",
        showComplete: false,
        sizeBytes: 100,
        staged: false,
        uploadProgress: 100,
        uploadStatus: "ready",
      },
      {
        adopted: false,
        autoRetryCount: 0,
        filename: "demo.mov",
        id: "video-third",
        localZeroCopy: false,
        referenceOwnership: "composer",
        mimeType: "video/quicktime",
        objectUrl: "blob:video-third",
        operationId: "operation-video-third",
        showComplete: false,
        sizeBytes: 100,
        staged: false,
        uploadProgress: 100,
        uploadStatus: "ready",
      },
    ];

    const html = renderComposer();

    expect(html.indexOf('data-composer-attachment-kind="image"')).toBeLessThan(
      html.indexOf('data-composer-attachment-kind="file"'),
    );
    expect(html.indexOf('data-composer-attachment-kind="video"')).toBeLessThan(
      html.indexOf('data-composer-attachment-kind="file"'),
    );
    // Inside the media group insertion order holds: the image added later still precedes the video added earlier.
    expect(html.indexOf('data-composer-attachment-kind="image"')).toBeLessThan(
      html.indexOf('data-composer-attachment-kind="video"'),
    );
    expect(html).toContain('data-composer-file-attachments-row="true"');
    expect(html).toContain('data-composer-attachment-kind="image"');
    expect(html).toContain('data-composer-attachment-kind="video"');
    expect(html).toContain('data-composer-attachment-kind="file"');
    // Video and image share the preview list; the original objectUrl is kept.
    expect(html).toContain('data-composer-attachment-url="blob:video-third"');
    expect(html).toContain('data-composer-image-preview="avatar.png,demo.mov"');
    expect(html).toContain("SNAKE-ARENA.md");
    expect(html).toContain('title="SNAKE-ARENA.md"');
    expect(html).toContain(">MD<");
    expect(html.match(/data-composer-attachment-remove=/gu)).toHaveLength(3);
    expect(html).toContain("opacity-0");
    expect(html).toContain("group-hover:opacity-100");
    expect(html).toContain("focus-visible:opacity-100");
    expect(html).toContain("[@media(hover:none)]:opacity-100");
  });

  it("video attachments show the upload progress ring and the raw preview URL", () => {
    attachmentState.attachments = [
      {
        adopted: false,
        autoRetryCount: 0,
        filename: "demo.mov",
        id: "video-1",
        localZeroCopy: false,
        referenceOwnership: "composer",
        mimeType: "video/quicktime",
        objectUrl: "blob:video-1",
        operationId: "operation-video-1",
        showComplete: false,
        sizeBytes: 100,
        staged: false,
        uploadProgress: 42,
        uploadStatus: "uploading",
      },
    ];

    const html = renderComposer();

    expect(html).toContain(`data-testid="${testId(TID_V4_ATTACHMENT_UPLOAD_PROGRESS, "video-1")}"`);
    expect(html).toContain('role="status"');
    expect(html).toContain("42%");
    expect(html).toContain('stroke-dasharray="42 100"');
    expect(html).toContain('data-composer-attachment-kind="video"');
    expect(html).toContain('data-composer-attachment-url="blob:video-1"');
  });

  it("failed non-image attachments expose an alert, an error hint and an accessible retry entry", () => {
    attachmentState.attachments = [
      {
        adopted: false,
        autoRetryCount: 1,
        filename: "notes.md",
        id: "file-1",
        localZeroCopy: false,
        referenceOwnership: "composer",
        mimeType: "text/markdown",
        operationId: "operation-file-1",
        showComplete: false,
        sizeBytes: 100,
        staged: false,
        uploadError: "network unavailable",
        uploadProgress: 17,
        uploadStatus: "failed",
      },
    ];

    const html = renderComposer();

    expect(html).toContain('role="alert"');
    expect(html).toContain("network unavailable");
    expect(html).toContain(`data-testid="${testId(TID_V4_ATTACHMENT_UPLOAD_RETRY, "file-1")}"`);
    expect(html).toContain(`aria-label="${expectedCopy("chat.attachments.upload.retry")}"`);
    expect(html).toContain("text-destructive");
  });
});
