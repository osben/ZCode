import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AcpAgentSummary } from "@zcode/services";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import {
  acpAgentNodeKey,
  ACP_DETECT_NODE_KEY,
  ACP_LOADING_NODE_KEY,
  acpProviderId,
  buildAcpDisableOverlay,
  buildAcpNavigationGroup,
  isAcpManagedProvider,
  resolveAcpAgentStatusKind,
  withoutAcpManagedProviders,
  type AcpDetectionState,
} from "@/settings/model-provider-section/acpAgentConfig.js";
import type { ModelProviderNavGroup } from "@/settings/model-provider-section/constants.js";
import { ModelProviderSectionNavigation } from "@/settings/model-provider-section/Navigation.js";
import { useModelProviderNavigation } from "@/settings/model-provider-section/useModelProviderNavigation.js";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

const OPENCODE: AcpAgentSummary = {
  agentId: "opencode",
  displayName: "opencode",
  installed: true,
  version: "2.0.31",
  commandPath: "/usr/local/bin/opencode",
  spawnArgs: ["acp"],
  loginArgs: ["auth", "login"],
  statusArgs: ["auth", "list"],
};
const CURSOR_MISSING: AcpAgentSummary = {
  agentId: "cursor",
  displayName: "Cursor",
  installed: false,
  version: null,
  commandPath: null,
  spawnArgs: ["acp"],
  loginArgs: ["login"],
  statusArgs: ["status"],
};

const READY: AcpDetectionState = {
  status: "ready",
  agents: [OPENCODE, CURSOR_MISSING],
  supported: true,
  refreshing: false,
};

type GroupInput = Parameters<typeof buildAcpNavigationGroup>[0];

function group(params: Partial<GroupInput>) {
  return buildAcpNavigationGroup({
    enabled: true,
    title: "ACP agents",
    detectLabel: "Detect agents",
    detectingLabel: "Detecting agents",
    detection: READY,
    enabledProviderIds: new Set(),
    managedAgentIds: new Set(),
    conflictAgentIds: new Set(),
    ...params,
  });
}

function customProvider(
  providerId: string,
  accessType?: "acp-agent" | "api-key",
): ProviderSettingsFormProvider {
  return {
    providerId,
    enabled: true,
    executable: true,
    config: {
      label: providerId,
      group: "standard-personal",
      builtinModelIds: [],
      ...(accessType ? { access: { type: accessType } } : {}),
    },
    models: [],
  } as unknown as ProviderSettingsFormProvider;
}

function renderWithTooltip(element: ReactElement) {
  return renderToStaticMarkup(createElement(TooltipProvider, null, element));
}

describe("ACP navigation group builder", () => {
  it("returns no group while the dev-only gate is off", () => {
    expect(group({ enabled: false })).toBeNull();
  });

  it("lists every installed agent as one acpAgent row keyed by agent id", () => {
    const built = group({ enabledProviderIds: new Set([acpProviderId("opencode")]) });
    expect(built?.id).toBe("acp");
    expect(built?.items.map((item) => item.key)).toEqual([acpAgentNodeKey("opencode")]);
    const row = built?.items[0];
    if (row?.type !== "acpAgent") throw new Error("expected acpAgent row");
    expect(row.enabled).toBe(true);
    expect(row.statusActive).toBe(true);
  });

  it("marks an enabled agent in conflict as not active", () => {
    const built = group({
      enabledProviderIds: new Set([acpProviderId("opencode")]),
      conflictAgentIds: new Set(["opencode"]),
    });
    const row = built?.items[0];
    if (row?.type !== "acpAgent") throw new Error("expected acpAgent row");
    expect(row.conflict).toBe(true);
    expect(row.statusActive).toBe(false);
  });

  it("keeps an uninstalled agent listed while it has a managed provider", () => {
    const built = group({
      detection: { status: "ready", agents: [CURSOR_MISSING], supported: true, refreshing: false },
      managedAgentIds: new Set(["cursor"]),
      enabledProviderIds: new Set([acpProviderId("cursor")]),
    });
    expect(built?.items.map((item) => item.key)).toEqual([acpAgentNodeKey("cursor")]);
    const row = built?.items[0];
    if (row?.type !== "acpAgent") throw new Error("expected acpAgent row");
    expect(row.installed).toBe(false);
    expect(row.enabled).toBe(true);
  });

  it("offers the detect entry when no agent is installed", () => {
    const built = group({
      detection: { status: "ready", agents: [CURSOR_MISSING], supported: true, refreshing: false },
    });
    expect(built?.items).toEqual([
      expect.objectContaining({ key: ACP_DETECT_NODE_KEY, type: "acpDetect", detection: "empty" }),
    ]);
  });

  it("shows the detect entry in error state when the scan failed without results", () => {
    const built = group({
      detection: { status: "error", agents: [], supported: true, refreshing: false, error: "boom" },
    });
    expect(built?.items[0]).toEqual(
      expect.objectContaining({ key: ACP_DETECT_NODE_KEY, type: "acpDetect", detection: "error" }),
    );
  });

  it("shows a non-selectable loading row during the first scan", () => {
    const built = group({
      detection: { status: "loading", agents: [], supported: true, refreshing: true },
    });
    expect(built?.items).toEqual([
      expect.objectContaining({ key: ACP_LOADING_NODE_KEY, type: "acpLoading" }),
    ]);
  });
});

describe("model provider navigation with the ACP group", () => {
  const acpGroup: ModelProviderNavGroup | null = group({
    enabledProviderIds: new Set([acpProviderId("opencode")]),
  });

  function navigationGroupsOf(params: {
    acp: ModelProviderNavGroup | null;
    providers: ProviderSettingsFormProvider[];
  }) {
    let captured: ModelProviderNavGroup[] = [];
    function Harness() {
      const navigation = useModelProviderNavigation({
        presetProviders: [],
        modelProviders: params.providers,
        selectedNodeKey: null,
        setSelectedNodeKey: vi.fn(),
        acpGroup: params.acp,
        intl: { formatMessage: ({ id }: { id: string }) => id } as never,
      });
      captured = navigation.navigationGroups;
      return null;
    }
    renderToStaticMarkup(createElement(Harness));
    return captured;
  }

  it("places the acp group directly after the custom group", () => {
    const groups = navigationGroupsOf({
      acp: acpGroup,
      providers: [customProvider("custom-a")],
    });
    expect(groups.map((item) => item.id)).toEqual(["preset", "chatgpt", "custom", "acp"]);
  });

  it("does not list ACP-managed personal providers again under custom", () => {
    const groups = navigationGroupsOf({
      acp: acpGroup,
      providers: [
        customProvider("custom-a"),
        customProvider(acpProviderId("opencode"), "acp-agent"),
      ],
    });
    const custom = groups.find((item) => item.id === "custom");
    expect(custom?.items.map((item) => item.key)).toEqual(["custom:custom-a"]);
  });

  it("keeps a conflicting non-ACP provider under custom so its conflict stays actionable", () => {
    const groups = navigationGroupsOf({
      acp: acpGroup,
      providers: [customProvider(acpProviderId("opencode"), "api-key")],
    });
    const custom = groups.find((item) => item.id === "custom");
    expect(custom?.items.map((item) => item.key)).toEqual([`custom:${acpProviderId("opencode")}`]);
  });

  it("produces no acp group when the gate is off", () => {
    const groups = navigationGroupsOf({ acp: null, providers: [customProvider("custom-a")] });
    expect(groups.map((item) => item.id)).toEqual(["preset", "chatgpt", "custom"]);
  });
});

describe("ACP navigation rows", () => {
  function renderGroups(navigationGroups: ModelProviderNavGroup[]) {
    return renderWithTooltip(
      createElement(ModelProviderSectionNavigation, {
        navigationGroups,
        selectedNodeKey: null,
        presetLoading: false,
        customLoading: false,
        onSelectNavItem: vi.fn(),
      }),
    );
  }

  it("renders the status dot by enabled, installed and conflict state", () => {
    const enabledOpencode = group({ enabledProviderIds: new Set([acpProviderId("opencode")]) });
    const conflictOpencode = group({
      enabledProviderIds: new Set([acpProviderId("opencode")]),
      conflictAgentIds: new Set(["opencode"]),
    });
    const uninstalledEnabled = group({
      detection: { status: "ready", agents: [CURSOR_MISSING], supported: true, refreshing: false },
      managedAgentIds: new Set(["cursor"]),
      enabledProviderIds: new Set([acpProviderId("cursor")]),
    });
    expect(renderGroups([enabledOpencode!])).toContain('data-provider-status="ready"');
    // A conflicting id is never an enabled ACP provider, so the shared rule shows it disabled.
    expect(renderGroups([conflictOpencode!])).toContain('data-provider-status="disabled"');
    expect(renderGroups([uninstalledEnabled!])).toContain('data-provider-status="unavailable"');
  });

  it("shows a disabled dot for an installed agent that is not enabled", () => {
    const html = renderGroups([group({})!]);
    expect(html).toContain('data-provider-status="disabled"');
    expect(html).toContain("ACP agents");
  });

  it("renders the loading row as a non-selectable disabled button", () => {
    const html = renderGroups([
      group({ detection: { status: "loading", agents: [], supported: true, refreshing: true } })!,
    ]);
    expect(html).toContain("Detecting agents");
    expect(html).toMatch(/disabled=""/);
  });
});

describe("ACP status, ownership and disable helpers", () => {
  it("resolves one status rule for navigation and detail", () => {
    expect(resolveAcpAgentStatusKind({ enabled: true, installed: true, conflict: false })).toBe(
      "ready",
    );
    expect(resolveAcpAgentStatusKind({ enabled: true, installed: false, conflict: false })).toBe(
      "unavailable",
    );
    expect(resolveAcpAgentStatusKind({ enabled: false, installed: true, conflict: false })).toBe(
      "disabled",
    );
    expect(resolveAcpAgentStatusKind({ enabled: false, installed: false, conflict: true })).toBe(
      "disabled",
    );
  });

  it("identifies only ACP-managed providers", () => {
    expect(isAcpManagedProvider(customProvider(acpProviderId("opencode"), "acp-agent"))).toBe(true);
    expect(isAcpManagedProvider(customProvider(acpProviderId("opencode"), "api-key"))).toBe(false);
    expect(isAcpManagedProvider(customProvider("custom-a", "acp-agent"))).toBe(false);
  });

  it("keeps acp: ids out of the display order the reorder handler saves", () => {
    const providers = [
      customProvider("custom-a"),
      customProvider(acpProviderId("opencode"), "acp-agent"),
      customProvider("custom-b"),
    ];
    expect(withoutAcpManagedProviders(providers).map((item) => item.providerId)).toEqual([
      "custom-a",
      "custom-b",
    ]);
  });

  it("builds a disable overlay that carries the saved access, and none for a foreign provider", () => {
    const access = { type: "acp-agent", command: "/bin/opencode", args: ["acp"], env: {} };
    expect(buildAcpDisableOverlay(access)).toEqual({ access });
    expect(buildAcpDisableOverlay({ type: "api-key" })).toBeNull();
    expect(buildAcpDisableOverlay(undefined)).toBeNull();
  });
});
