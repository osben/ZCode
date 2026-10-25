import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { Checkbox } from "@/components/ui/checkbox.js";

interface GroupByDirectoryCheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  className?: string;
}

// Shared "Group by directory" control for the chat change card and the Review pane.
// Presentational only: callers own the state and its persistence.
export function GroupByDirectoryCheckbox({
  checked,
  onCheckedChange,
  label,
  className,
}: GroupByDirectoryCheckboxProps) {
  return (
    <label
      className={cn(
        "flex min-w-0 cursor-pointer items-center gap-2 px-1 text-ui-base text-foreground-subtle",
        className,
      )}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={(value) => {
          onCheckedChange(value === true);
        }}
      />
      <span className="truncate">{label}</span>
    </label>
  );
}
