import { memo, useEffect, useMemo } from "react";
import { HourglassIcon } from "lucide-react";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { WorkflowActorSessionSidePaneTab } from "@/lib/workspaceSidePane.js";
import { workflowActorStartState } from "@/app-shell/workflowRunPanel.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { useV4Conversation, V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";

interface WorkflowActorSessionSidePaneProps {
  tab: WorkflowActorSessionSidePaneTab;
  focused: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
}

/**
 * Not-started placeholder. This is the landing view for a tab opened from a pill whose actor has not started yet.
 *
 * The copy says only "not started yet" and explains that the view will appear automatically. This is accurate (the gate reads the live projection)
 * and avoids prompting the user to retry something that does not exist. Color is not the only status signal: icon, title, and body all convey the same state.
 */
function WorkflowActorNotStarted() {
  const { intl } = useZCodeIntl();
  return (
    <div
      className="flex h-full flex-col items-center justify-center px-6 text-center"
      data-testid="workflow-actor-not-started"
    >
      <HourglassIcon className="size-8 text-foreground-subtlest" />
      <p className="mt-3 text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.notStarted.title" })}
      </p>
      <p className="mt-1 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.notStarted.body" })}
      </p>
    </div>
  );
}

/**
 * Gate + nested read-only SessionPane.
 *
 * The gate reads the **parent session's** `workflowRuns` projection (as with `WorkflowRunSidePane`: run state is the parent's
 * authoritative projection, not a local cache in this panel). Leases are reference-counted, and the main panel usually already subscribes to the parent,
 * so this read does not create another connection.
 *
 * When `notStarted`, **do not mount the SessionPane at all**; do not render it hidden. Subscription occurs inside
 * SessionPane at `layer.acquire(actorSessionId)`, so only unmounting prevents a failed subscription
 * and avoids a projection store stuck in error waiting for manual retry.
 */
const WorkflowActorSessionContent = memo(function WorkflowActorSessionContent({
  tab,
  focused,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
}: WorkflowActorSessionSidePaneProps) {
  const { layer } = useV4Conversation();

  // Acquire the parent-session lease synchronously during render (`useMemo`, as in ReadyV4PaneConversationProvider),
  // not with `WorkflowRunSidePane`'s `useEffect` + `setLease`. The distinction matters: the effect-based version has no projection on the **first frame**,
  // so the gate can only report unknown and mounts SessionPane for one frame; it subscribes to a session that does not exist yet and fails.
  // The failed store then remains in status:"error" in SessionDataLayer's keep-warm cache for 30 seconds, and when the gate opens,
  // acquire reuses it (refCount++, no reconnect)—the stuck panel this change is meant to prevent.
  // A detail page can tolerate one frame late because it first renders an empty state; this gate cannot.
  const lease = useMemo(() => layer.acquire(tab.parentSessionId), [layer, tab.parentSessionId]);
  useEffect(() => () => lease.release(), [lease]);

  const snapshot = useConversationProjection(lease).snapshot;
  const gate = useMemo(
    () =>
      workflowActorStartState(snapshot?.workflowRuns?.runs, {
        runId: tab.runId,
        siteId: tab.siteId,
        ordinal: tab.ordinal,
        ...(tab.actorSessionId === undefined ? {} : { actorSessionId: tab.actorSessionId }),
      }),
    [snapshot?.workflowRuns, tab.actorSessionId, tab.ordinal, tab.runId, tab.siteId],
  );

  // Continue subscribing for both `unknown` and `started`: the former is normal after a run is evicted/cold-recovered, and direct subscription is
  // the only transcript path. Preserve the existing error + manual-retry panel for real failures. A slot without a session id
  // (a tab opened from a not-started pill) can only show a placeholder; the gate reads the live projection and heals as soon as the actor appears with a session.
  if (gate.state === "notStarted" || gate.sessionId === undefined) {
    return <WorkflowActorNotStarted />;
  }

  return (
    <SessionPane
      paneId={tab.id}
      sessionId={gate.sessionId}
      readOnly
      allowWorkspaceFileRewind
      focused={focused}
      telemetryVisible={focused}
      workspacePath={tab.workspacePath}
      workspaceIdentity={tab.workspaceIdentity}
      remoteSessionId={tab.remoteSessionId}
      onOpenBrowserUrl={onOpenBrowserUrl}
      onOpenCodeViewer={onOpenCodeViewer}
      onOpenFileLink={onOpenFileLink}
    />
  );
});

/**
 * Transcript for one dwf actor instance.
 *
 * Composed like `SubagentSessionSidePane`: pane scope + nested **read-only** `SessionPane`. Apart from the not-started
 * gate, this component has no data-fetching logic of its own; that is the benefit of persisting actor sessions as real sessions:
 * live streaming, cold recovery, and viewing after a run ends all use the existing SessionPane path.
 *
 * Two **intentional** differences from the subagent panel:
 *
 * - Do not pass `onOpenSubagentSession`: the subagent tool is disabled in the actor's tool surface (the engine spec's
 *   "Actor tool surface"), so there is no nested drill-down to click and no entry point should be shown.
 * - Do not pass `rootSessionId`: an actor session is not part of any subagent tree. Inventing a root would make this read-only panel
 *   subscribe to an unrelated session.
 */
export const WorkflowActorSessionSidePane = memo(function WorkflowActorSessionSidePane({
  tab,
  focused,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
}: WorkflowActorSessionSidePaneProps) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );

  return (
    <V4PaneConversationProvider scope={scope}>
      <WorkflowActorSessionContent
        tab={tab}
        focused={focused}
        onOpenBrowserUrl={onOpenBrowserUrl}
        onOpenCodeViewer={onOpenCodeViewer}
        onOpenFileLink={onOpenFileLink}
      />
    </V4PaneConversationProvider>
  );
});
