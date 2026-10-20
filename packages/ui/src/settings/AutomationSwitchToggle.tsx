import { cn } from "@/components/lib/utils.js";

interface AutomationSwitchToggleProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  ariaLabel: string;
  color?: "green" | "blue";
  size?: "default" | "sm";
}

// Scheduled used to implement its own switch, so its off-state track and thumb were misaligned with Automations; both pages render it here.
// When home-page templates opened the create page, the switch responded only to click and focus, so hover did not identify it as interactive.
export function AutomationSwitchToggle({
  checked,
  onChange,
  ariaLabel,
  color = "green",
  size = "default",
}: AutomationSwitchToggleProps) {
  const activeColor = color === "blue" ? "bg-brand" : "bg-success";
  const isSmall = size === "sm";

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      data-testid="automation-switch-toggle"
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex shrink-0 items-center rounded-full transition-[background-color,box-shadow] hover:ring-2 hover:ring-border-hover focus-visible:ring-2 focus-visible:ring-input-border-focused/30",
        checked ? activeColor : "bg-input",
        isSmall ? "h-4 w-8" : "h-5 w-9",
      )}
    >
      <span
        className={cn(
          "absolute inline-block size-3.5 rounded-full shadow transition-all duration-200",
          checked
            ? color === "blue"
              ? "bg-foreground-inverse"
              : "bg-success-foreground"
            : "bg-primary",
          checked ? (isSmall ? "left-[17px]" : "left-[18px]") : "left-px",
        )}
      />
    </button>
  );
}
