// Example wiring (documentation only, not compiled into the app).
// The sessions settings section hosts the panel under the ZCode sessions table and shares its scope and search.
import type { ExternalSessionsPanelProps } from "@/external-sessions/index.js";

export function exampleExternalSessionsPanelProps(
  scope: { workspacePath: string } | undefined,
  debouncedSearch: string,
  isDesktop: boolean,
): ExternalSessionsPanelProps {
  return {
    enabled: isDesktop,
    workspacePath: scope?.workspacePath,
    search: debouncedSearch,
  };
}
