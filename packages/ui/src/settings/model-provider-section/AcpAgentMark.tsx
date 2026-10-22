import { useState } from "react";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { resolveTheme } from "@/useTheme.js";
import { resolveAcpAgentLogoAsset } from "./acpAgentLogo.js";

/**
 * Brand mark of an ACP agent, falling back to the agent's initial when no asset exists or the image
 * fails. Sized like the nav icon ("nav") or the detail header logo ("header").
 */
export function AcpAgentMark({
  agentId,
  name,
  size = "nav",
}: {
  agentId: string;
  name: string;
  size?: "nav" | "header";
}) {
  const theme = useZCodeStoreWithDefault((state) => state.theme, "dark");
  const src = resolveAcpAgentLogoAsset(agentId, resolveTheme(theme));
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const sizeClass = size === "header" ? "size-5 text-ui-sm" : "size-4 text-ui-xs";
  if (src && failedSrc !== src) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden="true"
        className={`${sizeClass} shrink-0 object-contain`}
        onError={() => setFailedSrc(src)}
      />
    );
  }
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden="true"
      className={`flex ${sizeClass} shrink-0 items-center justify-center rounded border border-border bg-surface font-semibold text-foreground-subtle`}
    >
      {initial}
    </span>
  );
}
