import { TID_WORKFLOW_ARTIFACT_CHIP, type ZCodeSavedWorkflowRun } from "@zcode/shared";
import type { ArtifactPillSize } from "@/components/workflow-timeline/WorkflowArtifactPill.js";
import { WorkflowArtifactStrip } from "@/components/workflow-timeline/WorkflowArtifactStrip.js";

/**
 * Artifact chips in the hub: small pills after the status label in run-history rows,
 * and regular size for the “Recent artifacts” row in the detail-page header.
 *
 * ⚠ Terminology: artifact = output a script publishes for users through `artifact.*`.
 *
 * This is the **same** component used in notification rows and beneath the timeline — the same artifact must look identical in all four places. The payload types
 * differ (legacy `workflows/runs` rows vs v4 notification meta), but both provide the four fields (id / kind / title / version),
 * and the chip reads only those.
 */
export function SavedWorkflowArtifactChips({
  artifacts,
  onOpenArtifact,
  className,
  size = "sm",
}: {
  artifacts: NonNullable<ZCodeSavedWorkflowRun["artifacts"]>;
  /** If absent, disable the pill (legacy rows have no `parentSessionId`, or the host did not provide open capability). */
  onOpenArtifact?: (artifactId: string) => void;
  size?: ArtifactPillSize;
  className?: string;
}) {
  return (
    <WorkflowArtifactStrip
      artifacts={artifacts}
      moreTestId="workflow-run-artifact-chips-more"
      pillTestId={TID_WORKFLOW_ARTIFACT_CHIP}
      size={size}
      testId="workflow-run-artifact-chips"
      {...(className === undefined ? {} : { className })}
      {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
    />
  );
}
