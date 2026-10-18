import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZCodeLspServerStatus, ZCodeLspStatusResult } from "@zcode/shared";
import type { IPluginManagementService } from "@zcode/services";
import { useLspStore } from "../src/store/lspStore.js";

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const TARGET = { workspacePath: "/repo", workspaceIdentity: "remote:ssh:host:/repo" };
const SERVER: ZCodeLspServerStatus = {
  serverId: "typescript-lsp@zcode-plugins-official/typescript",
  pluginId: "typescript-lsp@zcode-plugins-official",
  serverName: "typescript",
  command: "typescript-language-server",
  extensions: [".ts", ".tsx"],
  installed: true,
  state: "ready",
  diagnosticsMode: "attributed",
  diagnosticsAfterEdit: true,
  restarts: 0,
};

function snapshot(overrides: Partial<ZCodeLspStatusResult> = {}): ZCodeLspStatusResult {
  return { enabled: true, servers: [SERVER], ...overrides };
}

function createService(
  overrides: Partial<Record<"getLspStatus" | "setLspPreferences", unknown>> = {},
) {
  return {
    getLspStatus: vi.fn(async () => snapshot()),
    setLspPreferences: vi.fn(async () => ({ enabled: true, diagnosticsAfterEdit: {} })),
    ...overrides,
  } as unknown as IPluginManagementService & {
    getLspStatus: ReturnType<typeof vi.fn>;
    setLspPreferences: ReturnType<typeof vi.fn>;
  };
}

describe("lsp store", () => {
  beforeEach(() => {
    useLspStore.setState({
      targetKey: null,
      enabled: null,
      servers: [],
      loading: false,
      loadError: null,
      saveError: null,
      saveErrorKey: null,
      pendingKey: null,
    });
  });

  it("mirrors the status snapshot and keys the target by identity", async () => {
    const service = createService();
    await useLspStore.getState().refresh(service, TARGET);

    expect(service.getLspStatus).toHaveBeenCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: "remote:ssh:host:/repo",
    });
    expect(useLspStore.getState()).toMatchObject({
      targetKey: "remote:ssh:host:/repo",
      enabled: true,
      servers: [SERVER],
      loading: false,
      loadError: null,
    });
  });

  it("records a load failure without throwing", async () => {
    const service = createService({
      getLspStatus: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    await useLspStore.getState().refresh(service, TARGET);
    expect(useLspStore.getState()).toMatchObject({ loading: false, loadError: "offline" });
  });

  it("drops a slower response from an older refresh", async () => {
    let resolveFirst: (value: ZCodeLspStatusResult) => void = () => undefined;
    const service = createService({
      getLspStatus: vi
        .fn()
        .mockImplementationOnce(
          () => new Promise<ZCodeLspStatusResult>((resolve) => (resolveFirst = resolve)),
        )
        .mockImplementationOnce(async () => snapshot({ enabled: false, servers: [] })),
    });
    const first = useLspStore.getState().refresh(service, TARGET);
    await useLspStore.getState().refresh(service, { workspacePath: "/other" });
    resolveFirst(snapshot({ enabled: true, servers: [SERVER] }));
    await first;

    expect(useLspStore.getState()).toMatchObject({ enabled: false, servers: [] });
  });

  it("writes the global switch then re-reads the snapshot", async () => {
    const service = createService();
    await useLspStore.getState().refresh(service, TARGET);
    service.getLspStatus.mockResolvedValueOnce(snapshot({ enabled: false, servers: [] }));

    const ok = await useLspStore.getState().setEnabled(service, TARGET, false);

    expect(ok).toBe(true);
    expect(service.setLspPreferences).toHaveBeenCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: "remote:ssh:host:/repo",
      patch: { enabled: false },
    });
    expect(useLspStore.getState()).toMatchObject({ enabled: false, pendingKey: null });
  });

  it("sends a per-server diagnostics override and reports which write failed", async () => {
    const service = createService({
      setLspPreferences: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    const ok = await useLspStore
      .getState()
      .setDiagnosticsAfterEdit(service, TARGET, SERVER.serverId, false);

    expect(ok).toBe(false);
    expect(service.setLspPreferences).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: { diagnosticsAfterEdit: { [SERVER.serverId]: false } },
      }),
    );
    expect(useLspStore.getState()).toMatchObject({
      pendingKey: null,
      saveError: "disk full",
      saveErrorKey: `diagnostics:${SERVER.serverId}`,
    });
  });

  it("rejects a second write while one is pending", async () => {
    let release: () => void = () => undefined;
    const service = createService({
      setLspPreferences: vi.fn(() => new Promise<void>((resolve) => (release = resolve))),
    });
    const first = useLspStore.getState().setEnabled(service, TARGET, false);
    const second = await useLspStore.getState().setEnabled(service, TARGET, true);

    expect(second).toBe(false);
    expect(service.setLspPreferences).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
});
