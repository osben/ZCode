import { useMemo } from "react";
import { MessageSquare, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  externalSessionSourceLabel,
  type ExternalSessionSummary,
  type ExternalSessionTranscript,
} from "./contract.js";

export interface ExternalSessionTranscriptDialogProps {
  summary: ExternalSessionSummary;
  transcript: ExternalSessionTranscript | null;
  loading: boolean;
  error: string | null;
  canImport: boolean;
  canContinue: boolean;
  onClose: () => void;
  onResume: (summary: ExternalSessionSummary) => void;
  onContinue: (transcript: ExternalSessionTranscript) => void;
  onImport: (summary: ExternalSessionSummary) => void;
}

/** Read-only user/assistant bubbles of one external session (spec "Transcript dialog"). */
export function ExternalSessionTranscriptDialog({
  summary,
  transcript,
  loading,
  error,
  canImport,
  canContinue,
  onClose,
  onResume,
  onContinue,
  onImport,
}: ExternalSessionTranscriptDialogProps) {
  const { intl, locale } = useZCodeIntl();
  const sourceLabel = externalSessionSourceLabel(summary.source);
  const dateTimeFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    [locale],
  );
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="flex max-h-[85dvh] w-[min(56rem,calc(100vw-2rem))] max-w-none flex-col gap-0 p-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="flex items-center gap-2 truncate">
            <MessageSquare className="size-4 shrink-0 text-foreground-subtle" />
            <span className="truncate">{summary.title}</span>
          </DialogTitle>
          <DialogDescription className="truncate">
            {intl.formatMessage(
              { id: "externalSessions.transcript.meta" },
              {
                source: sourceLabel,
                count: String(transcript?.messages.length ?? summary.messageCount ?? "–"),
                path: summary.workspacePath,
              },
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-ui-base text-foreground-subtle">
              <Spinner className="size-4" />
              {intl.formatMessage({ id: "externalSessions.transcript.loading" })}
            </div>
          ) : error ? (
            <div className="flex items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-ui-base text-foreground-subtle">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
              <span className="break-words">{error}</span>
            </div>
          ) : transcript ? (
            <div className="space-y-3">
              {transcript.truncated ? (
                <div className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs text-foreground-subtle">
                  {intl.formatMessage({ id: "externalSessions.transcript.truncated" })}
                </div>
              ) : null}
              {transcript.messages.map((message, index) => (
                <div
                  key={`${index}-${message.timestamp ?? 0}`}
                  className={cn(
                    "rounded-xl border px-4 py-3",
                    message.role === "user"
                      ? "ml-auto max-w-[85%] border-border bg-surface"
                      : "mr-auto max-w-full border-transparent",
                  )}
                >
                  <div className="mb-1 flex items-center gap-2 text-ui-xs text-foreground-subtlest">
                    <span className="font-medium text-foreground-subtle">
                      {intl.formatMessage({
                        id:
                          message.role === "user"
                            ? "externalSessions.transcript.roleUser"
                            : "externalSessions.transcript.roleAssistant",
                      })}
                    </span>
                    {message.model ? <span className="font-mono">{message.model}</span> : null}
                    {message.timestamp ? (
                      <span>{dateTimeFormatter.format(message.timestamp)}</span>
                    ) : null}
                  </div>
                  <MessageResponse forceCodeWrap>{message.text}</MessageResponse>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <DialogFooter className="flex-row flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
          {summary.resumeCommand ? (
            <Button type="button" variant="outline" size="sm" onClick={() => onResume(summary)}>
              {intl.formatMessage({ id: "externalSessions.action.resume" }, { tool: sourceLabel })}
            </Button>
          ) : null}
          {canContinue && transcript ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onContinue(transcript)}
            >
              {intl.formatMessage({ id: "externalSessions.action.continue" })}
            </Button>
          ) : null}
          {canImport ? (
            <Button type="button" variant="default" size="sm" onClick={() => onImport(summary)}>
              {intl.formatMessage({ id: "externalSessions.action.import" })}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
