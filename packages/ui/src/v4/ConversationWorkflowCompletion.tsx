import { useMemo } from "react";
import type { WorkflowRunArtifactSummary } from "@zcode/shared/zcode-protocol-v4";
import {
  WorkflowCompletionCard,
  type WorkflowCompletionFigures,
} from "@/components/workflow-timeline/WorkflowCompletionCard.js";
import {
  completionArtifactLayout,
  completionPreviewIds,
} from "@/components/workflow-timeline/WorkflowCompletionArtifacts.js";
import type { WorkflowCompletionArtifact } from "@/components/workflow-timeline/WorkflowArtifactTile.js";
import {
  useWorkflowRunArtifacts,
  type WorkflowRunArtifactView,
} from "@/hooks/useWorkflowRunArtifacts.js";
import {
  WorkflowRunSaveSlotsBoundary,
  type WorkflowRunSaveSlots,
  type WorkflowRunSaveSlotsHost,
} from "@/project-workflow/WorkflowRunSaveControls.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { WorkflowArtifactTilePreview } from "@/app-shell/workflow-artifacts/WorkflowArtifactTilePreview.js";
import { useHasV4Conversation } from "@/v4/V4ConversationContext.js";
import type { WorkflowTurnCompletion } from "@/v4/workflowTurnCompletion.js";

/**
 * Completion-card binding: connect resolved completion facts to
 * host callbacks and artifact queries. Callback presence is the gate (matching `ConversationWorkflowDigests`): ⤢ requires
 * `onOpenWorkflowRun` + sessionId + joined `toolCallId`; tiles and pills require `onOpenWorkflowArtifact`
 * + sessionId (no toolCallId needed, same gate as notification rows).
 *
 * The artifact list is **based on the notification payload** (persisted with the notification and available during cold recovery). When a session is available,
 * the existing artifact hook adds byte counts / source paths / board specs / deliverable flags and provides previews for the deliverable frame. Hosts without session context (static rendering,
 * replay) draw the same card in a cold state with glyphs only—one less data layer.
 */
export function ConversationWorkflowCompletion({
  completion,
  context,
  turnKey,
}: {
  completion: WorkflowTurnCompletion;
  context: ConversationRowRenderContext;
  turnKey: string;
}) {
  const hasConversation = useHasV4Conversation();
  const sessionId = context.sessionId ?? undefined;
  const { summary } = completion;
  const run = summary?.run;
  const candidates = context.workflowSaveCandidatesByRunId?.get(completion.runId);

  const figures: WorkflowCompletionFigures = {
    ...(completion.durationMs === undefined ? {} : { durationMs: completion.durationMs }),
    ...(run === undefined
      ? {}
      : {
          tokens: run.usage.spentTokens,
          subagents: run.actors.length,
          // Do not label this as "steps" on the card: the fourth cell is phases entered; scripts without phase markers have none and show `—`.
          ...(run.phases !== undefined && run.phases.length > 0
            ? { phases: run.phases.length }
            : {}),
        }),
  };
  const onOpenRun =
    context.onOpenWorkflowRun && sessionId && summary?.toolCallId
      ? () =>
          context.onOpenWorkflowRun?.({
            parentSessionId: sessionId,
            toolCallId: summary.toolCallId!,
            runId: completion.runId,
            workflowName: completion.name,
          })
      : undefined;
  // Build the open request from **the list available at that moment**, so this is a factory that takes the list rather than a closed-over callback:
  // cold state has only the notification payload (`contentType` present, `sourcePath` absent); on the live path,
  // `WorkflowCompletionWithData` rebuilds the callback with the enriched list so the source path is available. The host uses `contentType`
  // to decide whether to open an HTML artifact directly in a browser tab.
  const openArtifactFrom =
    context.onOpenWorkflowArtifact && sessionId
      ? (artifacts: readonly WorkflowCompletionArtifact[]) => (artifactId: string) => {
          const artifact = artifacts.find((candidate) => candidate.id === artifactId);
          context.onOpenWorkflowArtifact?.({
            parentSessionId: sessionId,
            runId: completion.runId,
            artifactId,
            ...(artifact?.title === undefined ? {} : { title: artifact.title }),
            ...(artifact?.contentType === undefined ? {} : { contentType: artifact.contentType }),
            ...(artifact?.sourcePath === undefined ? {} : { sourcePath: artifact.sourcePath }),
          });
        }
      : undefined;
  const onOpenArtifact = openArtifactFrom?.(completion.artifacts);

  // The pair of controls in the header (docs/dynamic-workflow/transcript-and-notifications.md,
  // “Saving the run, and running it again”). Both gates are applied at the same supply point as
  // Resume, `onSendWorkflowSaveRequest`. The chip is not gated; it reports whether the file exists
  // on disk, not whether this card can act on it.
  const saveHost: WorkflowRunSaveSlotsHost = {
    sessionId: sessionId ?? undefined,
    workspacePath: context.workspacePath,
    ...(context.workspaceIdentity === undefined
      ? {}
      : { workspaceIdentity: context.workspaceIdentity }),
    ...(context.workspaceRemoteSessionId === undefined
      ? {}
      : { remoteSessionId: context.workspaceRemoteSessionId }),
    runId: completion.runId,
    runName: completion.name,
    ...(candidates === undefined ? {} : { candidates }),
    canSave: context.onSendWorkflowSaveRequest !== undefined,
    ...(context.onSendWorkflowSaveRequest === undefined
      ? {}
      : { sendLead: context.onSendWorkflowSaveRequest }),
  };

  const shared = {
    artifactsTruncated: completion.artifactsTruncated,
    figures,
    name: completion.name,
    testIdKey: turnKey,
    ...(onOpenRun === undefined ? {} : { onOpenRun }),
    ...(onOpenArtifact === undefined ? {} : { onOpenArtifact }),
  };

  // Without session context (static rendering or replay), keep the original card with no controls (spec, “Gates”).
  if (!hasConversation || sessionId === undefined) {
    return <WorkflowCompletionCard {...shared} artifacts={completion.artifacts} />;
  }
  return (
    <WorkflowRunSaveSlotsBoundary host={saveHost}>
      {(slots) => (
        <WorkflowCompletionWithData
          completion={completion}
          live={run?.artifacts}
          sessionId={sessionId}
          shared={withSaveSlots(shared, slots)}
          theme={context.theme}
          {...(openArtifactFrom === undefined ? {} : { openArtifactFrom })}
        />
      )}
    </WorkflowRunSaveSlotsBoundary>
  );
}

/** Combine both slots into shared card props; omit absent slots (exactOptionalPropertyTypes). */
function withSaveSlots<T extends object>(shared: T, slots: WorkflowRunSaveSlots | null): T {
  if (slots === null) return shared;
  return {
    ...shared,
    ...(slots.leading === null ? {} : { headerLeading: slots.leading }),
    ...(slots.trailing === null ? {} : { headerTrailing: slots.trailing }),
  };
}

/**
 * Notification payload list + additions from the hook view. Order and identity come from the payload (facts at notification time, with the deliverable already first);
 * when the payload was truncated (over 8), extra journal artifacts are appended at the end and go into the index or "N more." Either source may supply the flag and caption
 * (older payloads do not have those keys, and the hook restores them from the journal).
 */
function mergeCompletionArtifacts(
  base: readonly WorkflowCompletionArtifact[],
  views: readonly WorkflowRunArtifactView[],
): WorkflowCompletionArtifact[] {
  const byId = new Map(views.map((view) => [view.id, view] as const));
  const merged = base.map((artifact) => {
    const view = byId.get(artifact.id);
    if (view === undefined) return artifact;
    byId.delete(artifact.id);
    return {
      ...artifact,
      version: Math.max(artifact.version ?? 1, view.version),
      ...(view.contentType === undefined ? {} : { contentType: view.contentType }),
      ...(view.bytes === undefined ? {} : { bytes: view.bytes }),
      ...(view.sourcePath === undefined ? {} : { sourcePath: view.sourcePath }),
      ...(view.spec === undefined ? {} : { spec: view.spec }),
      ...(view.description === undefined ? {} : { description: view.description }),
      ...(view.primary === true ? { primary: true as const } : {}),
      itemCount: view.itemCount,
    } satisfies WorkflowCompletionArtifact;
  });
  for (const view of byId.values()) {
    merged.push({
      id: view.id,
      kind: view.kind,
      version: view.version,
      itemCount: view.itemCount,
      ...(view.title === undefined ? {} : { title: view.title }),
      ...(view.contentType === undefined ? {} : { contentType: view.contentType }),
      ...(view.bytes === undefined ? {} : { bytes: view.bytes }),
      ...(view.sourcePath === undefined ? {} : { sourcePath: view.sourcePath }),
      ...(view.spec === undefined ? {} : { spec: view.spec }),
      ...(view.description === undefined ? {} : { description: view.description }),
      ...(view.primary === true ? { primary: true as const } : {}),
    });
  }
  return merged;
}

function WorkflowCompletionWithData({
  completion,
  live,
  openArtifactFrom,
  sessionId,
  shared,
  theme,
}: {
  completion: WorkflowTurnCompletion;
  live: readonly WorkflowRunArtifactSummary[] | undefined;
  /** Factory for open requests; if absent, the host did not provide open capability (same gate as `shared.onOpenArtifact`). */
  openArtifactFrom?: (
    artifacts: readonly WorkflowCompletionArtifact[],
  ) => (artifactId: string) => void;
  sessionId: string;
  shared: Omit<Parameters<typeof WorkflowCompletionCard>[0], "artifacts" | "renderPreview">;
  theme: ConversationRowRenderContext["theme"];
}) {
  const state = useWorkflowRunArtifacts({
    sessionId,
    runId: completion.runId,
    ...(live === undefined ? {} : { live }),
  });
  const artifacts = useMemo(
    () => mergeCompletionArtifacts(completion.artifacts, state.artifacts),
    [completion.artifacts, state.artifacts],
  );
  // `artifactsTruncated` means the **notification payload** was capped at 8 artifacts, but the list rendered here may already be complete from the live projection /
  // journal (runs with many artifacts are common). If `+N` and "N more" still follow the payload flag, users see "… more" when the count is known.
  // Ignore the flag when the list is complete; retain the ellipsis only for old CLI versions (no journal lookup) or while the result is still unavailable,
  // when the count truly is unknown.
  const artifactsTruncated = shared.artifactsTruncated === true && !state.complete;
  const renderPreview = (artifact: WorkflowCompletionArtifact) => (
    <WorkflowArtifactTilePreview
      artifact={artifact}
      key={`${artifact.id}:${artifact.version ?? 1}`}
      runId={completion.runId}
      sessionId={sessionId}
      theme={theme}
    />
  );
  // Attach previews only to rendered frames—currently only the deliverable row has a frame; index rows and "N more" do not load bytes.
  const previewIds = useMemo(
    () => completionPreviewIds(completionArtifactLayout(artifacts, artifactsTruncated)),
    [artifacts, artifactsTruncated],
  );
  // Rebuild the callback with the enriched list: `sourcePath` missing from the payload and `contentType` missing from old payloads
  // are restored from the journal/live projection, so the open action has complete data.
  const onOpenArtifact = openArtifactFrom?.(artifacts);
  return (
    <WorkflowCompletionCard
      {...shared}
      {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
      artifactsTruncated={artifactsTruncated}
      artifacts={artifacts}
      renderPreview={(artifact) =>
        previewIds.has(artifact.id) ? renderPreview(artifact) : undefined
      }
    />
  );
}
