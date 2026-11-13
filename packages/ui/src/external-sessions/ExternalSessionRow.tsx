import {
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  MessageSquare,
  MoreHorizontal,
  TerminalSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Spinner } from "@/components/ui/spinner.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getPathLeaf } from "@/lib/path.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { copyTextToClipboard } from "@/useTaskListItemContextActions.js";
import {
  externalSessionSourceLabel,
  type ExternalSessionSource,
  type ExternalSessionSummary,
} from "./contract.js";

// Source marks use the DESIGN.md neutral surface and text tokens; the source label carries the identity, so no
// per-tool hex palette is hard-coded (DESIGN.md "Color Palette").
const SOURCE_MARK_CLASS: Record<ExternalSessionSource, string> = {
  claude: "bg-surface text-foreground-subtle border border-border",
  codex: "bg-surface text-foreground-subtle border border-border",
  opencode: "bg-surface text-foreground-subtle border border-border",
  cursor: "bg-surface text-foreground-subtle border border-border",
  gemini: "bg-surface text-foreground-subtle border border-border",
};

export function ExternalSessionRow({
  summary,
  now,
  busy,
  showPath,
  canImport,
  canContinue,
  onOpenTranscript,
  onResume,
  onContinue,
  onImport,
  onShowInFileManager,
}: {
  summary: ExternalSessionSummary;
  now: number;
  busy: boolean;
  showPath: boolean;
  canImport: boolean;
  canContinue: boolean;
  onOpenTranscript: (summary: ExternalSessionSummary) => void;
  onResume: (summary: ExternalSessionSummary) => void;
  onContinue: (summary: ExternalSessionSummary) => void;
  onImport: (summary: ExternalSessionSummary) => void;
  onShowInFileManager: (summary: ExternalSessionSummary) => void;
}) {
  const { intl } = useZCodeIntl();
  const sourceLabel = externalSessionSourceLabel(summary.source);
  const open = () => {
    if (summary.transcriptAvailable) onOpenTranscript(summary);
    else toast(intl.formatMessage({ id: "externalSessions.action.transcriptUnavailable" }));
  };
  return (
    <li
      className="grid grid-cols-[7.5rem_minmax(0,1fr)_auto_auto] items-center gap-3 px-3 py-1.5 text-ui-base hover:bg-surface/60"
      data-testid="external-session-row"
    >
      <span
        className={cn(
          "inline-flex w-fit items-center rounded-md px-1.5 py-0.5 text-ui-xs font-medium",
          SOURCE_MARK_CLASS[summary.source],
        )}
      >
        {sourceLabel}
      </span>
      <button type="button" className="min-w-0 text-left" onClick={open} title={summary.title}>
        <span className="block truncate font-medium text-foreground">{summary.title}</span>
        <span className="block truncate text-ui-xs text-foreground-subtle">
          {[
            showPath ? getPathLeaf(summary.workspacePath) : null,
            summary.gitBranch ?? null,
            summary.model ?? null,
            summary.messageCount !== undefined
              ? intl.formatMessage(
                  { id: "externalSessions.messages" },
                  { count: String(summary.messageCount) },
                )
              : null,
            summary.workspaceMissing
              ? intl.formatMessage({ id: "externalSessions.workspaceMissing" })
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </button>
      <span className="whitespace-nowrap text-ui-xs text-foreground-subtle">
        {formatTaskRelativeTime(summary.updatedAt, intl, now)}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            aria-label={intl.formatMessage({ id: "externalSessions.rowMenu.ariaLabel" })}
          >
            {busy ? <Spinner className="size-3.5" /> : <MoreHorizontal className="size-3.5" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={!summary.transcriptAvailable}
            onSelect={() => onOpenTranscript(summary)}
          >
            <MessageSquare className="size-3.5" />
            {intl.formatMessage({ id: "externalSessions.action.openTranscript" })}
          </DropdownMenuItem>
          {summary.resumeCommand ? (
            <DropdownMenuItem onSelect={() => onResume(summary)}>
              <TerminalSquare className="size-3.5" />
              {intl.formatMessage({ id: "externalSessions.action.resume" }, { tool: sourceLabel })}
            </DropdownMenuItem>
          ) : null}
          {canContinue && summary.transcriptAvailable ? (
            <DropdownMenuItem onSelect={() => onContinue(summary)}>
              <ExternalLink className="size-3.5" />
              {intl.formatMessage({ id: "externalSessions.action.continue" })}
            </DropdownMenuItem>
          ) : null}
          {canImport && summary.source === "claude" ? (
            <DropdownMenuItem
              disabled={!summary.importable}
              title={
                summary.importable
                  ? undefined
                  : intl.formatMessage({ id: "externalSessions.action.importUnavailable" })
              }
              onSelect={() => onImport(summary)}
            >
              <Download className="size-3.5" />
              {intl.formatMessage({ id: "externalSessions.action.import" })}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          {summary.resumeCommand ? (
            <DropdownMenuItem
              onSelect={() =>
                void copyTextToClipboard(
                  intl.formatMessage({ id: "externalSessions.action.copyCommand" }),
                  summary.resumeCommand,
                )
              }
            >
              <Copy className="size-3.5" />
              {intl.formatMessage({ id: "externalSessions.action.copyCommand" })}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            onSelect={() =>
              void copyTextToClipboard(
                intl.formatMessage({ id: "externalSessions.action.copySessionId" }),
                summary.sessionId,
              )
            }
          >
            <Copy className="size-3.5" />
            {intl.formatMessage({ id: "externalSessions.action.copySessionId" })}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onShowInFileManager(summary)}>
            <FolderOpen className="size-3.5" />
            {intl.formatMessage({ id: "externalSessions.action.showInFileManager" })}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
