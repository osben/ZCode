// @vitest-environment jsdom
// specs/acp-agent-runtime.md "Settings: workspace host" (WH1, WH2, WH6): the ACP group of Model
// Settings runs on the host that owns the workspace. ModelProviderSection, useAcpSettingsHost, the
// detection hook and the agent detail are real; the workspace resolution returns a host service
// that is distinct from the Local Host's, and every ACP call is asserted against both.
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpAgentSummary, ProviderSettingsView } from "@zcode/services";
import { TooltipProvider } from "@/components/ui/tooltip.js";

const REMOTE_PATH = "/srv/app";
const REMOTE_IDENTITY = "ssh:dev-box:/srv/app";

const CODEX: AcpAgentSummary = {
  agentId: "codex",
  displayName: "Codex",
  installed: true,
  version: "1.2.0",
  commandPath: "/usr/local/bin/codex-acp",
  spawnArgs: [],
  loginArgs: ["login"],
  statusArgs: ["login", "status"],
};

const MODEL_OPTION = {
  id: "model",
  name: "Model",
  description: null,
  category: "model",
  currentValue: "a",
  options: ["a", "b", "c"].map((value) => ({
    value,
    name: `Model ${value}`,
    description: null,
    group: null,
  })),
};

function acpView(enabled: boolean, command: string): ProviderSettingsView {
  return {
    revision: 1,
    providers: [
      {
        providerId: "acp:codex",
        providerName: "Codex (ACP)",
        enabled,
        effectiveConfig: { access: { type: "acp-agent", command, args: ["--host"], env: {} } },
      },
    ],
  } as unknown as ProviderSettingsView;
}

const ACP_METHODS = [
  "detectAcpAgents",
  "getAcpAgentCatalog",
  "setAcpAgentHiddenModels",
  "getAcpAgentStatus",
  "testAcpAgent",
  "startAcpAgentLogin",
  "saveAcpAgent",
  "setAcpAgentEnabled",
] as const;

function createHostService(view: ProviderSettingsView) {
  return {
    getView: vi.fn(async () => view),
    onDidChange: vi.fn(() => ({ dispose: () => {} })),
    detectAcpAgents: vi.fn(async () => ({ supported: true, agents: [CODEX], detectedAt: 0 })),
    getAcpAgentCatalog: vi.fn(async () => ({ supported: true, options: [MODEL_OPTION] })),
    setAcpAgentHiddenModels: vi.fn(async () => ({ supported: true })),
    getAcpAgentStatus: vi.fn(async () => ({ supported: true, exitCode: 0, output: "signed in" })),
    testAcpAgent: vi.fn(async () => ({ ok: true, frames: [], framesDropped: 0, durationMs: 1 })),
    startAcpAgentLogin: vi.fn(async () => ({ supported: true })),
    saveAcpAgent: vi.fn(async () => view),
    setAcpAgentEnabled: vi.fn(async () => view),
  };
}
type HostService = ReturnType<typeof createHostService>;

function acpCallCount(service: HostService): number {
  return ACP_METHODS.reduce((total, method) => total + service[method].mock.calls.length, 0);
}

const harness = vi.hoisted(() => ({
  localService: null as unknown,
  resolution: null as unknown,
  resolutionCalls: [] as unknown[][],
  localServices: null as unknown,
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServicesResolution: (...args: unknown[]) => {
    harness.resolutionCalls.push(args);
    return harness.resolution;
  },
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => harness.localServices,
  useOptionalServices: () => null,
}));

// The generic provider configuration stays on the Local Host; this case only exercises the ACP group.
const modelProviders = vi.hoisted(() => ({
  modelProviders: [],
  providerTemplates: [],
  displayOrder: [],
  loading: false,
  loadError: null,
  reload: () => {},
  refreshing: false,
  refresh: async () => {},
  saveProvider: async () => [],
  createPersonalProvider: async () => ({}),
  addPersonalModel: async () => ({}),
  savePersonalModelDraft: async () => ({}),
  setPersonalModelEnabled: async () => ({}),
  deletePersonalModel: async () => ({}),
  deleteProvider: async () => {},
  reorderProviderModels: async () => {},
  saveDisplayOrder: async () => {},
  reorderableProviderIds: [],
  testModelConnectivity: async () => ({ success: true }),
  providerSettingsView: null,
}));
vi.mock("@/hooks/useModelProviders.js", () => ({
  useModelProviders: () => modelProviders,
}));

const emptyProducts = vi.hoisted(() => ({
  snapshot: { productList: [], authenticated: true },
  products: [],
  subscribedProducts: [],
  refresh: async () => {},
  loading: false,
}));
vi.mock("@/settings/model-provider-section/useEnterpriseCodingPlanProducts.js", () => ({
  useEnterpriseCodingPlanProducts: () => emptyProducts,
}));
const settings = vi.hoisted(() => ({
  settings: {},
  loading: false,
  error: null,
  update: async () => {},
}));
vi.mock("@/hooks/useSettingService.js", () => ({ useSettings: () => settings }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
        values ? `${id}:${Object.values(values).join(",")}` : id,
    },
  }),
}));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => async () => true }));
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({ openExternal: () => {}, registerOAuthState: () => {} }),
}));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (selector: (state: { activeWorkspacePath: null; tabs: [] }) => unknown) =>
    selector({ activeWorkspacePath: null, tabs: [] }),
}));
const zcodeStore = vi.hoisted(() => ({
  user: null,
  oauthError: null,
  requestLoginEntry: () => {},
  setUser: () => {},
  setOAuthError: () => {},
}));
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (selector: (state: typeof zcodeStore) => unknown) => selector(zcodeStore),
  useZCodeStoreWithDefault: (_selector: unknown, defaultValue: unknown) => defaultValue,
}));
vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Navigation is stubbed to select the first agent of the real ACP group, so the detail shows what
// the group derived from the workspace host's detection and provider view.
vi.mock("../src/settings/model-provider-section/useModelProviderNavigation.js", () => ({
  useModelProviderNavigation: (input: { acpGroup: { items: Array<{ type: string }> } | null }) => ({
    navigationGroups: [],
    navigationItems: [],
    selectedNavItem: input.acpGroup?.items.find((item) => item.type === "acpAgent") ?? null,
    navigationUnavailable: false,
  }),
}));
const codingPlanEntitlements = vi.hoisted(() => ({ entitlements: {}, refresh: async () => {} }));
vi.mock("../src/settings/model-provider-section/useCodingPlanEntitlements.js", () => ({
  useCodingPlanAccessRefresh: () => undefined,
  useCodingPlanEntitlements: () => codingPlanEntitlements,
}));
vi.mock("../src/settings/model-provider-section/SectionLayout.js", () => ({
  ModelProviderSectionLayout: ({ children }: { children: unknown }) =>
    createElement("div", null, children),
}));
vi.mock("../src/settings/model-provider-section/Detail.js", () => ({
  ModelProviderSectionDetail: () => createElement("div"),
}));

function useHost(service: HostService, input: { remote: boolean }) {
  harness.resolution = {
    services: { providerSettingsService: service },
    remoteSessionId: input.remote ? "remote-session-1" : null,
    isRemoteTarget: input.remote,
    connectionKind: input.remote ? "remote-ready" : "local-ready",
    rpcReady: true,
  };
}

async function renderSection(props: { workspacePath: string; workspaceIdentity?: string }) {
  const { ModelProviderSection } = await import("@/settings/ModelProviderSection.js");
  render(createElement(TooltipProvider, null, createElement(ModelProviderSection, props)));
  await waitFor(() => expect(screen.getByTestId("acp-agent-enabled-switch")).toBeTruthy());
}

function modelCheckbox(value: string): HTMLElement {
  const found = screen
    .getAllByTestId("acp-agent-model-checkbox")
    .find((element) => element.getAttribute("data-model-value") === value);
  if (!found) throw new Error(`no checkbox for ${value}`);
  return found;
}

describe("ACP Settings on the workspace host", () => {
  let local: HostService;

  beforeEach(() => {
    harness.resolutionCalls = [];
    local = createHostService(acpView(false, "/usr/local/bin/codex-acp"));
    harness.localServices = {
      providerSettingsService: local,
      modelSelectionService: { getView: async () => ({ revision: 1, providers: [] }) },
      oauthService: { getActiveProvider: async () => null },
      credentialService: { load: async () => null },
      settingService: { get: async () => ({}), update: async () => {} },
    };
  });

  afterEach(cleanup);

  it("WH1/WH6: a remote workspace's ACP reads and writes reach the remote host only", async () => {
    const remote = createHostService(acpView(true, "/remote/bin/codex-acp"));
    useHost(remote, { remote: true });

    await renderSection({ workspacePath: REMOTE_PATH, workspaceIdentity: REMOTE_IDENTITY });

    // The identity is the third argument; the second is the preferred remote session id.
    expect(harness.resolutionCalls[0]).toEqual([REMOTE_PATH, null, REMOTE_IDENTITY]);
    // WH6: enabled comes from the remote host's provider view, not the desktop's.
    expect(screen.getByTestId("acp-agent-enabled-switch").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(document.querySelector('[data-acp-remote-host="true"]')).not.toBeNull();
    await waitFor(() => expect(screen.getAllByTestId("acp-agent-model-checkbox")).toHaveLength(3));
    expect(remote.detectAcpAgents).toHaveBeenCalledTimes(1);
    expect(remote.getView).toHaveBeenCalled();
    expect(remote.getAcpAgentCatalog).toHaveBeenCalledWith({ agentId: "codex" });
    await waitFor(() =>
      expect(remote.getAcpAgentStatus).toHaveBeenCalledWith({
        agentId: "codex",
        command: "/remote/bin/codex-acp",
      }),
    );

    await act(async () => {
      fireEvent.click(modelCheckbox("b"));
    });
    expect(remote.setAcpAgentHiddenModels).toHaveBeenCalledWith({
      agentId: "codex",
      hiddenModels: ["b"],
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("acp-agent-test-button"));
    });
    expect(remote.testAcpAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "codex", command: "/remote/bin/codex-acp" }),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("acp-agent-enabled-switch"));
    });
    expect(remote.setAcpAgentEnabled).toHaveBeenCalledWith({ agentId: "codex", enabled: false });

    expect(acpCallCount(local)).toBe(0);
    expect(local.getView).not.toHaveBeenCalled();
  });

  it("WH1: enabling saves the remote host's launch config on the remote host", async () => {
    const remote = createHostService(acpView(false, "/remote/bin/codex-acp"));
    useHost(remote, { remote: true });

    await renderSection({ workspacePath: REMOTE_PATH, workspaceIdentity: REMOTE_IDENTITY });
    expect(screen.getByTestId("acp-agent-enabled-switch").getAttribute("aria-checked")).toBe(
      "false",
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("acp-agent-enabled-switch"));
    });
    expect(remote.saveAcpAgent).toHaveBeenCalledWith({
      agentId: "codex",
      providerName: "Codex (ACP)",
      command: "/remote/bin/codex-acp",
      args: ["--host"],
      env: {},
      enabled: true,
    });
    expect(acpCallCount(local)).toBe(0);
  });

  it("WH2: a local workspace keeps the ACP group on the Local Host", async () => {
    useHost(local, { remote: false });

    await renderSection({ workspacePath: "/Users/dev/app" });

    expect(harness.resolutionCalls[0]).toEqual(["/Users/dev/app", null, undefined]);
    expect(local.detectAcpAgents).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(local.getAcpAgentCatalog).toHaveBeenCalledWith({ agentId: "codex" }),
    );
    expect(document.querySelector('[data-acp-remote-host="true"]')).toBeNull();
  });
});
