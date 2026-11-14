export type AppShutdownKind = "normal" | "update-install";

export interface AppShutdownPolicy {
  forceKillDelayMs: number;
  waitTimeoutMs: number;
}

export interface AppShutdownPolicySelection {
  kind: AppShutdownKind;
  policy: AppShutdownPolicy;
  upgraded: boolean;
}

const STRICT_SHUTDOWN_POLICY: AppShutdownPolicy = {
  forceKillDelayMs: 7_500,
  waitTimeoutMs: 9_000,
};

export function resolveAppShutdownPolicy(
  _kind: AppShutdownKind,
  _platform: NodeJS.Platform,
): AppShutdownPolicy {
  return STRICT_SHUTDOWN_POLICY;
}

export function selectAppShutdownPolicy(
  activeKind: AppShutdownKind | null,
  requestedKind: AppShutdownKind,
  platform: NodeJS.Platform,
): AppShutdownPolicySelection {
  // Ordinary quit and update share the same strict upper bound; update intent can only increase and does not start a second quit timer.
  const kind =
    activeKind === "update-install" || requestedKind === "update-install"
      ? "update-install"
      : "normal";
  return {
    kind,
    policy: resolveAppShutdownPolicy(kind, platform),
    upgraded: activeKind === "normal" && kind === "update-install",
  };
}
