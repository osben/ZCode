import { type ComponentProps, useEffect, useMemo, useState } from "react";
import { GitPane } from "@/GitPane.js";
import type { LastTurnGitDataset } from "./contract.js";
import { useLastTurnGitDataset, withLastTurnDataset } from "./useLastTurnGitDataset.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";

type GitPaneProps = ComponentProps<typeof GitPane>;

interface OwnedLastTurn {
  owner: string;
  value: LastTurnGitDataset | null;
}

function LastTurnSourceBridge({
  owner,
  sessionId,
  workspacePath,
  workspaceKey,
  enabled,
  onChange,
}: {
  owner: string;
  sessionId: string;
  workspacePath: string;
  workspaceKey: string;
  enabled: boolean;
  onChange: (value: OwnedLastTurn | null) => void;
}) {
  const lastTurn = useLastTurnGitDataset({ sessionId, workspacePath, workspaceKey, enabled });
  useEffect(() => {
    onChange({ owner, value: lastTurn });
  }, [lastTurn, onChange, owner]);
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
  const [lastTurn, setLastTurn] = useState<OwnedLastTurn | null>(null);
  const workspaceKey =
    conversationScope.workspaceIdentity?.trim() || conversationScope.workspacePath;
  // The bridge reports after commit, so for one render after a task or path switch the stored
  // value still belongs to the previous owner; it is applied only when the owner matches.
  const owner = JSON.stringify([
    workspaceKey,
    conversationScope.remoteSessionId ?? null,
    sessionId,
    gitPaneProps.workspacePath,
  ]);
  const mergedState = useMemo(
    () =>
      withLastTurnDataset(gitState, sessionId && lastTurn?.owner === owner ? lastTurn.value : null),
    [gitState, lastTurn, owner, sessionId],
  );

  return (
    <>
      {sessionId ? (
        // No sessionId prop: the provider must not retain a disconnected session for this side
        // pane, so the bridge unmounts and the source falls back to its empty state.
        <V4PaneConversationProvider scope={conversationScope}>
          <LastTurnSourceBridge
            key={sessionId}
            owner={owner}
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
