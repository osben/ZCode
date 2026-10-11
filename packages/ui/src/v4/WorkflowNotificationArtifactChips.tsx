import { TID_CHAT_WORKFLOW_ARTIFACT_CHIP } from "@zcode/shared";
import type { WorkflowNotificationMeta } from "@zcode/shared/zcode-protocol-v4";
import { WorkflowArtifactStrip } from "@/components/workflow-timeline/WorkflowArtifactStrip.js";

/**
 * Artifact strip in the collapsed header/footer of a terminal notification row: small artifact pills, up to 3 plus `+N`.
 *
 * ⚠ Terminology: an artifact on this strip is an output published for the user by the script through `artifact.*`, distinct from
 * `result` (the script's top-level return value) in the same notification.
 *
 * Missing payload (batch turn / old transcript / old CLI) ⇒ omit the entire strip, leaving the notification row pixel-identical to today.
 * Missing callback (not found during cold recovery, readonly session) ⇒ disable the pill instead of hiding it: what the run delivered is a fact,
 * while whether it can be opened is a capability. Events stop at the strip; the whole header toggles collapse, and the pills are not part of it.
 */
export function WorkflowNotificationArtifactChips({
  artifacts,
  truncated,
  onOpenArtifact,
}: {
  artifacts: NonNullable<Extract<WorkflowNotificationMeta, { kind: "terminal" }>["artifacts"]>;
  /** The emitter truncated the list (over 8 or filtered), so `+N` may undercount; use "…" instead of a number. */
  truncated?: boolean;
  onOpenArtifact?: (artifactId: string) => void;
}) {
  return (
    <WorkflowArtifactStrip
      artifacts={artifacts}
      moreTestId="workflow-notification-artifacts-more"
      pillTestId={TID_CHAT_WORKFLOW_ARTIFACT_CHIP}
      size="sm"
      variant="link"
      testId="workflow-notification-artifacts"
      {...(truncated === undefined ? {} : { truncated })}
      {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
    />
  );
}
