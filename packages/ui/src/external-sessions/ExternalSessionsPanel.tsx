import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { copyTextToClipboard } from "@/useTaskListItemContextActions.js";
import { logger } from "@/logger.js";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import type { OpenExistingSessionTarget } from "@/hooks/useOpenExistingSession.js";
import {
  EXTERNAL_SESSION_SOURCE_CATALOG,
  EXTERNAL_SESSION_TRANSCRIPT_UNAVAILABLE,
  type ExternalSessionSource,
  type ExternalSessionSummary,
  type ExternalSessionTranscript,
} from "./contract.js";
import { buildExternalSessionContextPack } from "./contextPack.js";
import { ExternalSessionRow } from "./ExternalSessionRow.js";
import { ExternalSessionTranscriptDialog } from "./ExternalSessionTranscriptDialog.js";
import {
  isChipUnavailable,
  type PanelViewState,
  persistViewState,
  readViewState,
  showChipCount,
  summarizeSourceSelection,
} from "./panelViewState.js";
import { useExternalSessionActions } from "./useExternalSessionActions.js";
import { useExternalSessions } from "./useExternalSessions.js";

export interface ExternalSessionsPanelProps {
  /** Desktop local Host only; false renders nothing. */
  /** Desktop local Host only, never a remote workspace scope; false renders nothing. */
  enabled: boolean;
  workspacePath?: string;
  /** Debounced search text shared with the sessions table. */
  search: string;
  onOpenSession?: (target: OpenExistingSessionTarget) => Promise<void>;
  onCreateTask?: (request: CreateTaskRequest) => void;
}

interface TranscriptDialogState {
  summary: ExternalSessionSummary;
  transcript: ExternalSessionTranscript | null;
  loading: boolean;
  error: string | null;
}

/** "Sessions from other tools" under the ZCode sessions table (specs/external-sessions.md "UI"). */
export function ExternalSessionsPanel({
  enabled,
  workspacePath,
  search,
  onOpenSession,
  onCreateTask,
}: ExternalSessionsPanelProps) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const [view, setView] = useState<PanelViewState>(readViewState);
  useEffect(() => persistViewState(view), [view]);
  const state = useExternalSessions({
    enabled,
    workspacePath,
    search,
    sources: view.sources,
  });
  const actions = useExternalSessionActions(state.service);
  const [dialog, setDialog] = useState<TranscriptDialogState | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const sessions = state.result?.sessions ?? [];
  const statuses = state.result?.sources;
  const now = Date.now();

  const toggleSource = useCallback((source: ExternalSessionSource) => {
    setView((current) => {
      // An empty list is the "every source" sentinel: expand it first so a click always flips the chip's own state.
      const next = new Set<ExternalSessionSource>(
        current.sources.length === 0
          ? EXTERNAL_SESSION_SOURCE_CATALOG.map((item) => item.source)
          : current.sources,
      );
      if (next.has(source)) next.delete(source);
      else next.add(source);
      const all = EXTERNAL_SESSION_SOURCE_CATALOG.length;
      return { ...current, sources: next.size === all ? [] : [...next] };
    });
  }, []);

  const resume = useCallback(
    async (summary: ExternalSessionSummary) => {
      setBusyKey(summary.key);
      try {
        const result = await actions.openInTerminal(summary);
        if (result.opened) {
          toast(
            intl.formatMessage(
              { id: "externalSessions.toast.resumeOpened" },
              { path: summary.workspacePath },
            ),
          );
        } else {
          await copyTextToClipboard("resume command", result.command);
          toast(
            intl.formatMessage(
              { id: "externalSessions.toast.resumeCopied" },
              { command: result.command },
            ),
          );
        }
      } catch (error) {
        toast(getErrorMessage(error));
      } finally {
        setBusyKey(null);
      }
    },
    [actions, intl],
  );

  const loadTranscript = useCallback(
    (summary: ExternalSessionSummary) => actions.readTranscript(summary),
    [actions],
  );

  const openTranscript = useCallback(
    (summary: ExternalSessionSummary) => {
      setDialog({ summary, transcript: null, loading: true, error: null });
      void loadTranscript(summary)
        .then((transcript) =>
          setDialog((current) =>
            current?.summary.key === summary.key
              ? { ...current, transcript, loading: false }
              : current,
          ),
        )
        .catch((error: unknown) => {
          const message =
            error instanceof Error &&
            error.message.includes(EXTERNAL_SESSION_TRANSCRIPT_UNAVAILABLE)
              ? intl.formatMessage({ id: "externalSessions.action.transcriptUnavailable" })
              : getErrorMessage(error);
          setDialog((current) =>
            current?.summary.key === summary.key
              ? { ...current, loading: false, error: message }
              : current,
          );
        });
    },
    [intl, loadTranscript],
  );

  const continueInZCode = useCallback(
    async (transcript: ExternalSessionTranscript) => {
      if (!onCreateTask || !actions.canResolveProject) return;
      const { workspacePath: sourcePath, workspaceMissing } = transcript.summary;
      if (workspaceMissing) {
        toast(
          intl.formatMessage(
            { id: "externalSessions.toast.workspaceMissing" },
            { path: sourcePath },
          ),
        );
        return;
      }
      // `targetWorkspace.workspacePath` alone does not decide the draft's cwd (prepareSession would allocate a
      // managed directory); the hook resolves the folder's local project first, like "Open folder" does.
      const target = await actions.resolveContinuation(sourcePath);
      if (target.kind === "secondary-root") {
        toast(
          intl.formatMessage(
            { id: "externalSessions.toast.secondaryRoot" },
            { project: target.projectName, primary: target.primaryRootPath },
          ),
        );
        return;
      }
      onCreateTask({
        initialPrompt: buildExternalSessionContextPack(transcript),
        projectId: target.projectId,
        hostId: "local",
        targetWorkspace: {
          workspacePath: sourcePath,
          projectId: target.projectId,
          hostId: "local",
        },
      });
      setDialog(null);
    },
    [actions, intl, onCreateTask],
  );

  const continueFromRow = useCallback(
    async (summary: ExternalSessionSummary) => {
      setBusyKey(summary.key);
      try {
        const transcript = await loadTranscript(summary);
        if (transcript) await continueInZCode(transcript);
      } catch (error) {
        toast(getErrorMessage(error));
      } finally {
        setBusyKey(null);
      }
    },
    [continueInZCode, loadTranscript],
  );

  const importToZCode = useCallback(
    async (summary: ExternalSessionSummary) => {
      if (!actions.canImport || !summary.importable) return;
      setBusyKey(summary.key);
      try {
        const outcome = await actions.importClaudeSession(summary);
        if (!outcome.imported) {
          toast(
            intl.formatMessage(
              { id: "externalSessions.toast.importFailed" },
              { error: outcome.failureReason ?? "unknown" },
            ),
          );
          return;
        }
        toast(intl.formatMessage({ id: "externalSessions.toast.imported" }));
        setDialog(null);
        if (onOpenSession) await onOpenSession(outcome.imported);
      } catch (error) {
        logger.warn("[external-sessions] import failed", error);
        toast(
          intl.formatMessage(
            { id: "externalSessions.toast.importFailed" },
            { error: getErrorMessage(error) },
          ),
        );
      } finally {
        setBusyKey(null);
      }
    },
    [actions, intl, onOpenSession],
  );

  const showInFileManager = useCallback(
    async (summary: ExternalSessionSummary) => {
      if (!platform) return;
      const result = await platform.openInFileManager(summary.sourcePath);
      if (!result.success && result.error) toast(result.error);
    },
    [platform],
  );

  // Only selected sources were scanned for this view; deselected ones carry a cached or
  // `not scanned` status that must not drive the counts or the "every source unavailable" message.
  const { totalCount, everySourceUnavailable } = useMemo(
    () => summarizeSourceSelection(statuses, view.sources),
    [statuses, view.sources],
  );

  if (!state.supported) return null;

  const canImport = actions.canImport && Boolean(onOpenSession);
  const canContinue = Boolean(onCreateTask) && actions.canResolveProject;

  return (
    <section
      aria-label={intl.formatMessage({ id: "externalSessions.title" })}
      data-testid="external-sessions-panel"
      className={cn(
        "flex shrink-0 flex-col border-t border-border",
        view.collapsed ? "" : "max-h-[45%] min-h-[9rem]",
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 text-ui-base font-medium text-foreground"
          aria-expanded={!view.collapsed}
          onClick={() => setView((current) => ({ ...current, collapsed: !current.collapsed }))}
        >
          {view.collapsed ? (
            <ChevronRight className="size-3.5" />
          ) : (
            <ChevronDown className="size-3.5" />
          )}
          <span className="truncate">{intl.formatMessage({ id: "externalSessions.title" })}</span>
          <span className="text-foreground-subtle">{sessions.length}</span>
        </button>
        {!view.collapsed ? (
          <div className="ml-2 flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {EXTERNAL_SESSION_SOURCE_CATALOG.map((item) => {
              const status = statuses?.[item.source];
              const active = view.sources.length === 0 || view.sources.includes(item.source);
              const unavailable = isChipUnavailable(statuses, view.sources, item.source);
              return (
                <button
                  key={item.source}
                  type="button"
                  title={unavailable && status?.reason ? status.reason : undefined}
                  aria-pressed={active}
                  onClick={() => toggleSource(item.source)}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-ui-xs transition-colors",
                    active
                      ? "border-border-strong bg-surface text-foreground"
                      : "border-border text-foreground-subtle hover:text-foreground",
                    unavailable ? "opacity-50" : "",
                  )}
                >
                  {item.label}
                  {showChipCount(statuses, view.sources, item.source) && status ? (
                    <span className="ml-1 text-foreground-subtlest">{status.count}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : (
          <span className="flex-1" />
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={intl.formatMessage({ id: "externalSessions.refresh" })}
          disabled={state.loading}
          onClick={state.refresh}
        >
          <RefreshCw className={cn("size-3.5", state.loading ? "animate-spin" : "")} />
        </Button>
      </div>
      {view.collapsed ? null : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {state.error ? (
            <div className="flex items-center gap-2 px-4 py-3 text-ui-base text-foreground-subtle">
              <TriangleAlert className="size-4 text-warning" />
              {state.error}
            </div>
          ) : state.loading && !state.result ? (
            <div className="flex items-center gap-2 px-4 py-3 text-ui-base text-foreground-subtle">
              <Spinner className="size-4" />
              {intl.formatMessage({ id: "externalSessions.loading" })}
            </div>
          ) : sessions.length === 0 ? (
            <div className="px-4 py-3 text-ui-base text-foreground-subtle">
              {everySourceUnavailable && totalCount === 0
                ? intl.formatMessage({ id: "externalSessions.empty.unavailable" })
                : intl.formatMessage({
                    id: workspacePath
                      ? "externalSessions.empty.scoped"
                      : "externalSessions.empty.all",
                  })}
            </div>
          ) : (
            <ul className="divide-y divide-border" role="list">
              {sessions.map((summary) => (
                <ExternalSessionRow
                  key={summary.key}
                  summary={summary}
                  now={now}
                  busy={busyKey === summary.key}
                  showPath={!workspacePath}
                  canImport={canImport}
                  canContinue={canContinue}
                  onOpenTranscript={openTranscript}
                  onResume={(item) => void resume(item)}
                  onContinue={(item) => void continueFromRow(item)}
                  onImport={(item) => void importToZCode(item)}
                  onShowInFileManager={(item) => void showInFileManager(item)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
      {dialog ? (
        <ExternalSessionTranscriptDialog
          summary={dialog.summary}
          transcript={dialog.transcript}
          loading={dialog.loading}
          error={dialog.error}
          canImport={canImport && dialog.summary.importable}
          canContinue={canContinue}
          onClose={() => setDialog(null)}
          onResume={(item) => void resume(item)}
          onContinue={(transcript) => void continueInZCode(transcript)}
          onImport={(item) => void importToZCode(item)}
        />
      ) : null}
    </section>
  );
}
