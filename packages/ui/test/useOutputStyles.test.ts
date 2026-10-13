// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutputStyle } from "@zcode/shared";

const mocks = vi.hoisted(() => ({
  useBaseWorkspaceServices: vi.fn(),
  useWorkspaceServicesResolution: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/components/ui/toast.js", () => ({ toast: mocks.toast }));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: mocks.useBaseWorkspaceServices,
  useWorkspaceServicesResolution: mocks.useWorkspaceServicesResolution,
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/logger.js", () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));

import { useOutputStyles } from "@/hooks/useOutputStyles.js";

const style: OutputStyle = {
  id: "custom-x",
  name: "X",
  isBuiltIn: false,
  enabled: true,
} as OutputStyle;

/** Tracks the persisted active id so getActiveStyle mirrors setActiveStyle, like the real service. */
function makeService(initialActive = "custom-x") {
  let activeStyleId: string | null = initialActive;
  return {
    listStyles: vi.fn(async () => ({ styles: [style] })),
    addStyle: vi.fn(async () => undefined),
    updateStyle: vi.fn(async () => undefined),
    deleteStyle: vi.fn(async () => undefined),
    getUserStylesDirectory: vi.fn(async () => ({ path: "/home/.zcode/output-styles" })),
    setActiveStyle: vi.fn(async ({ styleId }: { styleId: string }) => {
      activeStyleId = styleId;
    }),
    getActiveStyle: vi.fn(async () => ({ styleId: activeStyleId })),
  };
}

const targetA = { workspacePath: "/a", workspaceIdentity: "ssh:a" };
const targetB = { workspacePath: "/b", workspaceIdentity: "ssh:b" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  mocks.toast.mockReset();
  mocks.useBaseWorkspaceServices.mockReturnValue({
    outputStyleService: makeService(),
  });
});

afterEach(() => {
  cleanup();
});

describe("useOutputStyles deleteStyle", () => {
  it("resets the active id first, reloads after a successful delete", async () => {
    const service = makeService();
    mocks.useWorkspaceServicesResolution.mockReturnValue({
      isRemoteTarget: true,
      rpcReady: true,
      services: { outputStyleService: service },
    });
    const { result } = renderHook(({ target }) => useOutputStyles(target), {
      initialProps: { target: targetA },
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.activeStyleId).toBe("custom-x");

    await act(() => result.current.deleteStyle(style));

    expect(service.setActiveStyle).toHaveBeenCalledTimes(1);
    expect(service.setActiveStyle).toHaveBeenCalledWith({ styleId: "default" });
    expect(service.deleteStyle).toHaveBeenCalledWith({ id: "custom-x" });
    // The post-delete reload refreshed list and active id.
    expect(service.listStyles).toHaveBeenCalledTimes(2);
    expect(result.current.activeStyleId).toBe("default");
    expect(mocks.toast).toHaveBeenCalledWith("settings.outputStyles.deleted");
  });

  it("keeps every step and the rollback on the initiating service despite a host switch", async () => {
    const serviceA = makeService();
    const serviceB = makeService();
    let active = serviceA;
    mocks.useWorkspaceServicesResolution.mockImplementation(() => ({
      isRemoteTarget: true,
      rpcReady: true,
      services: { outputStyleService: active },
    }));
    const { result, rerender } = renderHook(({ target }) => useOutputStyles(target), {
      initialProps: { target: targetA },
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const failingDelete = deferred<void>();
    serviceA.deleteStyle.mockImplementation(() => failingDelete.promise);

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.deleteStyle(style);
    });
    // Mid-flight host switch: serviceRef now points at serviceB and the host key changed.
    active = serviceB;
    rerender({ target: targetB });

    await act(async () => {
      failingDelete.reject(new Error("EACCES"));
      await pending;
    });

    // Reset, delete, and rollback all stayed on service A; the swapped-in service is untouched.
    expect(serviceA.setActiveStyle).toHaveBeenNthCalledWith(1, { styleId: "default" });
    expect(serviceA.setActiveStyle).toHaveBeenNthCalledWith(2, { styleId: "custom-x" });
    expect(serviceA.deleteStyle).toHaveBeenCalledTimes(1);
    expect(serviceB.setActiveStyle).not.toHaveBeenCalled();
    expect(serviceB.deleteStyle).not.toHaveBeenCalled();
  });
});
