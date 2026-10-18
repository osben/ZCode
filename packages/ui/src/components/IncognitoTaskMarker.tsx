import type { ZCodeTaskMeta } from "@zcode/shared";
import { VenetianMask } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * Sidebar marker for incognito sessions (specs/incognito-session.md "Sidebar marker"). Like the
 * worktree marker it uses the row's muted meta color; the label carries the meaning.
 */
export function IncognitoTaskMarker({ task }: { task: ZCodeTaskMeta }) {
  const { intl } = useZCodeIntl();
  if (!task.incognito) return null;
  const label = intl.formatMessage({ id: "taskList.incognitoTaskLabel" });
  return (
    <span data-incognito-task-icon="true" title={label}>
      <VenetianMask aria-label={label} className="size-3.5 shrink-0" />
    </span>
  );
}
