import { memo, useEffect, useState } from "react";
import type { ProjectMemoryFileSummary, ProjectMemoryItemType } from "@zcode/services";
import {
  PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE,
  PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE,
} from "@zcode/services";
import {
  TID_SETTINGS_MEMORY_FILE,
  TID_SETTINGS_MEMORY_FILE_EDITOR_ACTIONS,
  TID_SETTINGS_MEMORY_FILE_ICON,
  TID_SETTINGS_MEMORY_FILE_NAME,
  TID_SETTINGS_MEMORY_FILE_TYPE,
  TID_SETTINGS_MEMORY_FILE_UPDATED_AT,
  TID_SETTINGS_MEMORY_INDEX_LINES,
  TID_SETTINGS_MEMORY_PREVIEW,
  testId,
} from "@zcode/shared";
import { AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { cn } from "@/components/lib/utils.js";
import { MarkdownPreviewContent } from "@/previewPaneMarkdownContent.js";
import { formatMemoryUpdatedAt } from "@/settings/memoryUpdatedAt.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { WorkspaceEditorButtonGroup } from "@/WorkspaceEditorButtonGroup.js";
import { ChevronDown, Loader2 } from "lucide-react";

// MEMORY.md is truncated to this many lines at injection time; the constant lives in
// apps/zcode-cli/packages/core/src/memory/index-content.ts (MEMORY_INDEX_LINE_LIMIT) and is not
// exported through a shared package yet.
const MEMORY_INDEX_LINE_LIMIT = 200;

type MemoryPreviewErrorKind = "deleted" | "changed" | "tooLarge" | "unknown";

export type MemoryPreviewRecord =
  | { status: "loading" }
  | { status: "ready"; content: string }
  | { status: "error"; kind: MemoryPreviewErrorKind; message: string | undefined };

const MEMORY_TYPE_MESSAGE_IDS: Record<ProjectMemoryItemType, string> = {
  user: "settings.memory.viewer.type.user",
  feedback: "settings.memory.viewer.type.feedback",
  project: "settings.memory.viewer.type.project",
  reference: "settings.memory.viewer.type.reference",
};

const MEMORY_PREVIEW_ERROR_MESSAGE_IDS: Record<
  Exclude<MemoryPreviewErrorKind, "unknown">,
  string
> = {
  deleted: "settings.memory.viewer.fileDeleted",
  changed: "settings.memory.viewer.fileChanged",
  tooLarge: "settings.memory.viewer.fileTooLarge",
};

export function formatMemoryFileSize(size: number): string {
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

export function classifyMemoryPreviewError(error: unknown): MemoryPreviewErrorKind {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (code === "ENOENT") {
    return "deleted";
  }
  if (code === PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE) {
    return "changed";
  }
  if (code === PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE) {
    return "tooLarge";
  }
  return "unknown";
}

/** Self-ticking relative date so the row (and its markdown preview) never re-renders on the minute tick. */
const MemoryFileUpdatedAt = memo(function MemoryFileUpdatedAt({
  fileName,
  updatedAt,
}: {
  fileName: string;
  updatedAt: number;
}) {
  const { intl, locale } = useZCodeIntl();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);
  return (
    <span
      data-testid={testId(TID_SETTINGS_MEMORY_FILE_UPDATED_AT, fileName)}
      className="mt-0.5 block"
    >
      {formatMemoryUpdatedAt({
        formatMessage: intl.formatMessage,
        locale,
        now,
        updatedAt,
      })}
    </span>
  );
});

export const MemoryFileAccordionItem = memo(function MemoryFileAccordionItem({
  file,
  open,
  preview,
  onToggle,
}: {
  file: ProjectMemoryFileSummary;
  open: boolean;
  preview: MemoryPreviewRecord | undefined;
  onToggle: (fileName: string) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <AccordionItem value={file.name} data-testid={testId(TID_SETTINGS_MEMORY_FILE, file.name)}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center">
        {/* The built-in trigger icon is hidden so the editor control can sit between the row content and the chevron. */}
        <AccordionTrigger className="min-w-0 px-4 py-3 text-left text-ui-base hover:no-underline [&_[data-slot=accordion-trigger-icon]]:hidden">
          <span className="flex min-w-0 flex-1 items-center gap-3">
            <span
              data-testid={testId(TID_SETTINGS_MEMORY_FILE_ICON, file.name)}
              className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-background"
            >
              <FileDisplayIcon
                src={resolveFileDisplayDescriptor(file.path).fileIconSrc}
                size={16}
                className="size-4 shrink-0"
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  data-testid={testId(TID_SETTINGS_MEMORY_FILE_NAME, file.name)}
                  className="min-w-0 truncate font-medium text-foreground"
                >
                  {file.name}
                </span>
                {file.type ? (
                  <Badge
                    variant="secondary"
                    data-testid={testId(TID_SETTINGS_MEMORY_FILE_TYPE, file.name)}
                    className="shrink-0"
                  >
                    {intl.formatMessage({ id: MEMORY_TYPE_MESSAGE_IDS[file.type] })}
                  </Badge>
                ) : null}
                {file.lineCount !== undefined ? (
                  <Badge
                    variant="outline"
                    className="shrink-0"
                    data-testid={TID_SETTINGS_MEMORY_INDEX_LINES}
                    aria-label={intl.formatMessage(
                      { id: "settings.memory.viewer.indexLinesAriaLabel" },
                      { used: file.lineCount, limit: MEMORY_INDEX_LINE_LIMIT },
                    )}
                  >
                    {file.lineCount}/{MEMORY_INDEX_LINE_LIMIT}
                  </Badge>
                ) : null}
              </span>
              {file.description ? (
                <span className="mt-0.5 block truncate text-ui-sm text-foreground-subtle">
                  {file.description}
                </span>
              ) : null}
            </span>
            <span className="shrink-0 whitespace-nowrap text-right text-ui-sm text-foreground-subtle">
              <span className="block">{formatMemoryFileSize(file.size)}</span>
              <MemoryFileUpdatedAt fileName={file.name} updatedAt={file.updatedAt} />
            </span>
          </span>
        </AccordionTrigger>
        <span
          data-testid={testId(TID_SETTINGS_MEMORY_FILE_EDITOR_ACTIONS, file.name)}
          className="flex items-center"
        >
          {/* Sits outside the accordion trigger so opening an editor never toggles the row. */}
          <WorkspaceEditorButtonGroup workspaceAbsPath={file.path} />
        </span>
        {/* Chevron lives outside the trigger so it can sit to the right of the editor control;
            it is a real toggle button because clicks outside the trigger never reach Radix. */}
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          aria-expanded={open}
          aria-label={intl.formatMessage({ id: "settings.memory.viewer.togglePreview" })}
          className="mr-3 ml-1.5 text-foreground-subtle"
          onClick={() => onToggle(file.name)}
        >
          <ChevronDown
            aria-hidden="true"
            className={cn("transition-transform", open && "rotate-180")}
          />
        </Button>
      </div>
      {/* h-auto overrides the base content height pin: Radix measures --radix-accordion-content-height
          at open time, before the lazy preview resolves, so the pinned height would clip the preview. */}
      <AccordionContent className="h-auto px-4 pb-4">
        {preview ? <MemoryFilePreview file={file} preview={preview} /> : null}
      </AccordionContent>
    </AccordionItem>
  );
});

function MemoryFilePreview({
  file,
  preview,
}: {
  file: ProjectMemoryFileSummary;
  preview: MemoryPreviewRecord;
}) {
  const { intl } = useZCodeIntl();
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const codePreviewSettings = useZCodeStoreWithDefault(
    (state) => state.codePreviewSettings,
    DEFAULT_CODE_PREVIEW_SETTINGS,
  );
  if (preview.status === "loading") {
    return (
      <div className="flex min-h-24 items-center justify-center gap-2 rounded-lg border border-border text-ui-sm text-foreground-subtle">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {intl.formatMessage({ id: "settings.memory.viewer.fileLoading" })}
      </div>
    );
  }
  if (preview.status === "error") {
    return (
      <p className="text-ui-sm text-foreground-subtle">
        {preview.kind === "unknown"
          ? (preview.message ?? "")
          : intl.formatMessage({ id: MEMORY_PREVIEW_ERROR_MESSAGE_IDS[preview.kind] })}
      </p>
    );
  }
  return (
    <div className="space-y-2" data-testid={testId(TID_SETTINGS_MEMORY_PREVIEW, file.name)}>
      <div className="rounded-lg border border-border">
        <MarkdownPreviewContent
          content={preview.content}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
        />
      </div>
    </div>
  );
}
