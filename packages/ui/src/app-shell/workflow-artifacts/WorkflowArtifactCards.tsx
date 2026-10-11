/**
 * Three kinds of content that “cannot be rendered inline” (HTML card, metadata card for non-table types, and a one-line loading / error message).
 *
 * ⚠ Terminology: artifact = output a script publishes for users through `artifact.*`, not the identically named “script top-level return value” inside the engine.
 *
 * Split from `WorkflowArtifactBody.tsx` to meet the 400-line limit: that file is primarily **dispatch by
 * contentType**, while these three handle cases the dispatcher **cannot cover**; they should be read separately by responsibility.
 */

import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatArtifactBytes } from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { toFileUrl } from "@/lib/path.js";
import type { WorkflowRunArtifactView } from "@/hooks/useWorkflowRunArtifacts.js";

/**
 * Shared card shell for the two kinds of content that “cannot be rendered inline” (HTML and non-table types): title / type / size / source,
 * plus at most one action. Rendering them separately would eventually make one show the size while the other omits it.
 */
export function ArtifactMetadataCard({
  artifact,
  bytes,
  note,
  action,
  testId,
}: {
  artifact: WorkflowRunArtifactView;
  bytes: number;
  /** Explanation beneath the card (why it is not rendered inline / what exactly will open). */
  note?: string;
  action?: { label: string; onActivate: () => void; testId?: string };
  testId: string;
}) {
  return (
    <div className="flex h-full min-h-0 items-start justify-center overflow-auto p-6">
      <div
        className="flex w-full max-w-md flex-col gap-3 rounded-lg border border-card-border bg-card p-4"
        data-testid={testId}
      >
        <div className="min-w-0">
          <div className="truncate text-ui-base font-medium text-foreground">
            {artifact.title ?? artifact.id}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-ui-sm text-foreground-subtle">
            {artifact.contentType === undefined ? null : <span>{artifact.contentType}</span>}
            <span>{formatArtifactBytes(bytes)}</span>
          </div>
          {artifact.sourcePath === undefined ? null : (
            <div
              className="mt-0.5 truncate font-mono text-ui-xs text-foreground-subtlest"
              title={artifact.sourcePath}
            >
              {artifact.sourcePath}
            </div>
          )}
        </div>
        {note === undefined ? null : (
          <p className="text-ui-sm text-foreground-subtle" data-testid="workflow-artifact-note">
            {note}
          </p>
        )}
        {action === undefined ? null : (
          <Button
            className="self-start"
            {...(action.testId === undefined ? {} : { "data-testid": action.testId })}
            onClick={action.onActivate}
            size="sm"
            type="button"
            variant="outline"
          >
            {action.label}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Card for HTML artifacts (**do not inline an iframe**; see the file header).
 *
 * ## Why “Open in browser” uses the **original workspace path** instead of the pinned bytes in the store
 *
 * The store handle is `zcode-artifact://…`, not a filesystem path, so a browser tab cannot open it; the protocol layer
 * also intentionally does not expose the store's on-disk path to the renderer. Thus the only value that can become `file://` is
 * `sourcePath` (the original workspace-relative path). The tradeoff is explicit: that is the **current file in the workspace**, not the pinned
 * bytes for this version — so the card states this (per the spec: “the card says it opens the workspace copy”),
 * and the button appears only on the **latest version**: the original file for an older version may already have been overwritten by the same name, and presenting it as a historical version would be
 * a quiet lie.
 */
export function WorkflowArtifactHtmlCard({
  artifact,
  bytes,
  localSourcePath,
  isLatestVersion,
  onOpenBrowserUrl,
  onReveal,
}: {
  artifact: WorkflowRunArtifactView;
  bytes: number;
  localSourcePath?: string;
  isLatestVersion: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  onReveal?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const openable =
    isLatestVersion && localSourcePath !== undefined && onOpenBrowserUrl !== undefined;
  return (
    <ArtifactMetadataCard
      artifact={artifact}
      bytes={bytes}
      note={intl.formatMessage({
        id: openable
          ? "chat.toolCall.workflow.run.artifacts.openInBrowserNote"
          : "chat.toolCall.workflow.run.artifacts.localOnly",
      })}
      testId="workflow-artifact-html-card"
      {...(openable
        ? {
            action: {
              label: intl.formatMessage({
                id: "chat.toolCall.workflow.run.artifacts.openInBrowser",
              }),
              onActivate: () => onOpenBrowserUrl(toFileUrl(localSourcePath)),
              testId: "workflow-artifact-open-in-browser",
            },
          }
        : onReveal === undefined
          ? {}
          : {
              action: {
                label: intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.reveal" }),
                onActivate: onReveal,
                testId: "workflow-artifact-html-reveal",
              },
            })}
    />
  );
}

/** One-line message in the body position (loading / error / cannot preview). All three states share one shape and differ only in color. */
export function ArtifactNotice({
  text,
  detail,
  tone,
  testId,
}: {
  text: string;
  detail?: string;
  tone?: "error";
  testId?: string;
}) {
  return (
    <div
      className="flex h-full min-h-0 flex-col items-center justify-center gap-1 p-6 text-center"
      {...(testId === undefined ? {} : { "data-testid": testId })}
    >
      <p
        className={cn(
          "text-ui-base",
          tone === "error" ? "text-destructive" : "text-foreground-subtle",
        )}
      >
        {text}
      </p>
      {detail === undefined ? null : (
        <p
          className="max-w-full truncate font-mono text-ui-xs text-foreground-subtlest"
          title={detail}
        >
          {detail}
        </p>
      )}
    </div>
  );
}
