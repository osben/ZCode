import { GitMerge } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function BranchMergedBadge({ className }: { className?: string }) {
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage({ id: "taskList.branchMergedTag" });

  return (
    <Badge
      data-branch-merged-badge="true"
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "h-5 w-5 shrink-0 border-transparent bg-primary/14 p-0 text-primary dark:bg-primary/18",
        className,
      )}
    >
      <GitMerge aria-hidden="true" />
    </Badge>
  );
}
