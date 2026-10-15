import type { ZCodeTaskGroupColor } from "@zcode/services";

/** Text colors for tinting a workspace row icon with the chosen project color. */
const WORKSPACE_ICON_COLOR_CLASS: Record<ZCodeTaskGroupColor, string> = {
  gray: "text-zinc-500 dark:text-zinc-400",
  red: "text-rose-500 dark:text-rose-400",
  orange: "text-orange-500 dark:text-orange-400",
  yellow: "text-amber-500 dark:text-amber-400",
  green: "text-emerald-500 dark:text-emerald-400",
  blue: "text-sky-500 dark:text-sky-400",
  purple: "text-violet-500 dark:text-violet-400",
};

export { WORKSPACE_ICON_COLOR_CLASS };
