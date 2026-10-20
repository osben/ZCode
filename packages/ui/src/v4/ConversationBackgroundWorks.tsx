import { memo, useCallback } from "react";
import {
  TID_V4_BACKGROUND_WORKS,
  TID_V4_BACKGROUND_WORK_CANCEL,
  TID_V4_BACKGROUND_WORK_ITEM,
  testId,
} from "@zcode/shared/test-ids";
import type { BackgroundWorkSummary } from "@zcode/shared/zcode-protocol-v4";
import { runUserAction } from "@/lib/userActionTelemetry.js";

export interface ConversationBackgroundWorksProps {
  works: readonly BackgroundWorkSummary[];
  /** M4 cancelBackgroundWork: cancel a background work (only running items can be cancelled). */
  onCancel: (workId: string) => void;
}

/**
 * M4 background works panel: renders projection.backgroundWorks with a cancel entry on running items.
 * memo: does not re-render with other pane state while works is unchanged (callbacks are stabilized
 * by the parent's useCallback).
 */
function ConversationBackgroundWorksImpl({ works, onCancel }: ConversationBackgroundWorksProps) {
  if (works.length === 0) return null;
  return (
    <div
      data-testid={TID_V4_BACKGROUND_WORKS}
      className="border-t border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
    >
      <div className="mb-1 text-ui-sm text-[var(--color-foreground-subtle)]">
        后台工作 · {works.length}
      </div>
      <ul className="flex flex-col gap-1">
        {works.map((work) => (
          <BackgroundWorkRow key={work.workId} work={work} onCancel={onCancel} />
        ))}
      </ul>
    </div>
  );
}

/** Each row is a memo component so the whole list does not fully re-render when any single item changes. */
const BackgroundWorkRow = memo(function BackgroundWorkRow({
  work,
  onCancel,
}: {
  work: BackgroundWorkSummary;
  onCancel: (workId: string) => void;
}) {
  return (
    <li
      data-testid={testId(TID_V4_BACKGROUND_WORK_ITEM, work.workId)}
      data-work-id={work.workId}
      data-work-status={work.status}
      className="flex items-center justify-between gap-2 rounded border border-[var(--color-border)] px-2 py-1 text-ui-sm"
    >
      <span className="min-w-0 flex-1 truncate text-[var(--color-foreground)]">
        {work.kind} · {work.title}
      </span>
      <span className="shrink-0 text-[var(--color-foreground-subtle)]">{work.status}</span>
      {work.status === "running" ? <CancelButton workId={work.workId} onCancel={onCancel} /> : null}
    </li>
  );
});

/** The cancel button is extracted with the workId closure inside; the parent passes a stable onCancel. */
const CancelButton = memo(function CancelButton({
  workId,
  onCancel,
}: {
  workId: string;
  onCancel: (workId: string) => void;
}) {
  const handleClick = useCallback(
    () =>
      runUserAction({
        input: { featureId: "conversation.background_work", action: "cancel", trigger: "button" },
        operation: () => onCancel(workId),
        completed: { resultSource: "optimistic_projection" },
        failureStage: "background_work_cancel",
      }),
    [onCancel, workId],
  );
  return (
    <button
      type="button"
      data-testid={testId(TID_V4_BACKGROUND_WORK_CANCEL, workId)}
      onClick={handleClick}
      className="shrink-0 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[var(--color-danger)] hover:bg-[var(--color-surface-hover)]"
    >
      取消
    </button>
  );
});

export const ConversationBackgroundWorks = memo(ConversationBackgroundWorksImpl);
