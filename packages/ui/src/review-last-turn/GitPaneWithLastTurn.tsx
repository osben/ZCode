import { type ComponentProps, useEffect, useMemo, useState } from "react";
import { GitPane } from "@/GitPane.js";
import type { LastTurnGitDataset } from "./contract.js";
import { useLastTurnGitDataset, withLastTurnDataset } from "./useLastTurnGitDataset.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";

type GitPaneProps = ComponentProps<typeof GitPane>;

function LastTurnSourceBridge({
  sessionId,
  workspacePath,
  workspaceKey,
  enabled,
  onChange,
}: {
  sessionId: string;
  workspacePath: string;
  workspaceKey: string;
  enabled: boolean;
  onChange: (value: LastTurnGitDataset | null) => void;
}) {
  const lastTurn = useLastTurnGitDataset({ sessionId, workspacePath, workspaceKey, enabled });
  useEffect(() => {
    onChange(lastTurn);
  }, [lastTurn, onChange]);
  // The provider unmounts this bridge when the connection is unavailable; fall back to the empty state.
  useEffect(() => () => onChange(null), [onChange]);
  return null;
}

/**
 * GitPane plus the v4-backed "Last turn" source (specs/review-last-turn-source.md, ISSUE-056).
 * Only the read-only bridge sits inside the conversation provider, so GitPane keeps the shell's
 * services for its Git calls exactly as before.
 */
export function GitPaneWithLastTurn({
  sessionId,
  conversationScope,
  gitState,
  ...gitPaneProps
}: GitPaneProps & {
  sessionId: string | null;
  /** Workspace that owns the conversation (not the execution worktree the Git pane may target). */
  conversationScope: PaneWorkspaceScope;
}) {
  const [lastTurn, setLastTurn] = useState<LastTurnGitDataset | null>(null);
  const workspaceKey =
    conversationScope.workspaceIdentity?.trim() || conversationScope.workspacePath;
  const mergedState = useMemo(
    () => withLastTurnDataset(gitState, sessionId ? lastTurn : null),
    [gitState, lastTurn, sessionId],
  );

  return (
    <>
      {sessionId ? (
        <V4PaneConversationProvider scope={conversationScope} sessionId={sessionId}>
          <LastTurnSourceBridge
            key={sessionId}
            sessionId={sessionId}
            workspacePath={gitPaneProps.workspacePath}
            workspaceKey={workspaceKey}
            enabled={gitPaneProps.selectedSourceId === "last-turn"}
            onChange={setLastTurn}
          />
        </V4PaneConversationProvider>
      ) : null}
      <GitPane {...gitPaneProps} gitState={mergedState} />
    </>
  );
}
