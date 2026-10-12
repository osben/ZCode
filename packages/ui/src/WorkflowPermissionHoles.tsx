import { PenIcon } from "lucide-react";
import type { ToolCallCreateWorkflowCausalityGraph } from "@zcode/shared/zcode-protocol-v4";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * The confirmation dialog's hole row (docs/dynamic-workflow/presentation.md "Holes on the timeline",
 * section "The hole station"): holes still open are laid out as a row of chips in source order
 * (pen, name; kind is not rendered), followed by "the run pauses at each hole and waits for the main
 * agent to fill it before continuing." The user is approving a run that will stop and wait for code,
 * and that sentence must be readable before Allow is pressed. The whole row is absent when there are
 * no holes. Split out of WorkflowPermissionBlock.tsx (max-lines gate).
 */
export function WorkflowPermissionHoles({
  holes,
}: {
  holes: NonNullable<ToolCallCreateWorkflowCausalityGraph["holes"]> | undefined;
}) {
  const { intl } = useZCodeIntl();
  if (holes === undefined || holes.length === 0) return null;
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
      data-testid="workflow-permission-holes"
    >
      <span className="shrink-0 text-ui-sm text-foreground-subtlest">
        {intl.formatMessage({ id: "chat.permission.workflow.holes.label" })}
      </span>
      {holes.map((hole) => (
        <span
          className="inline-flex h-6 min-w-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-ui-sm text-foreground"
          data-hole-id={hole.siteId}
          data-testid="workflow-permission-hole"
          key={hole.siteId}
          title={hole.name}
        >
          <PenIcon aria-hidden className="size-3.5 shrink-0 text-foreground-subtle" />
          <span className="min-w-0 truncate">{hole.name}</span>
        </span>
      ))}
      <span className="text-ui-sm text-foreground-subtlest">
        {intl.formatMessage({ id: "chat.permission.workflow.holes.note" })}
      </span>
    </div>
  );
}
