// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { useSystemPromptOverrides } from "../src/hooks/useSystemPromptOverrides.js";

function makeService(content = "default:cli-prefix") {
  return {
    listSections: vi.fn(async () => ({
      sections: [
        {
          key: "cli-prefix",
          defaultContent: content,
          overrideContent: null,
          filePath: "/host/.zcode/system-prompt/cli-prefix.md",
          isOverridden: false,
        },
      ],
    })),
    writeOverride: vi.fn(async () => undefined),
    deleteOverride: vi.fn(async () => undefined),
    getOverridesDirectory: vi.fn(async () => ({ path: "/host/.zcode/system-prompt" })),
  };
}

const localTarget = { workspacePath: "/local/repo" };
const remoteTargetA = { workspacePath: "/remote/a", workspaceIdentity: "ssh:a" };
const remoteTargetB = { workspacePath: "/remote/b", workspaceIdentity: "ssh:b" };

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
  mocks.useBaseWorkspaceServices.mockReturnValue({ systemPromptService: makeService() });
  mocks.useWorkspaceServicesResolution.mockReturnValue({
    isRemoteTarget: false,
    rpcReady: true,
    services: { systemPromptService: makeService() },
  });
});

afterEach(() => cleanup());

describe("useSystemPromptOverrides", () => {
  it("loads and writes through the local service for a local workspace", async () => {
    const service = makeService();
    mocks.useBaseWorkspaceServices.mockReturnValue({ systemPromptService: service });
    const { result } = renderHook(() => useSystemPromptOverrides(localTarget));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.openEditor("cli-prefix", "default:cli-prefix");
      result.current.setDraft("custom local prefix");
    });
    await act(() => result.current.saveEditor());

    expect(service.listSections).toHaveBeenCalledTimes(2);
    expect(service.writeOverride).toHaveBeenCalledWith({
      key: "cli-prefix",
      content: "custom local prefix",
    });
  });

  it("uses the active remote service for load, save, and restore", async () => {
    const localService = makeService("local default");
    const remoteService = makeService("remote default");
    mocks.useBaseWorkspaceServices.mockReturnValue({ systemPromptService: localService });
    mocks.useWorkspaceServicesResolution.mockReturnValue({
      isRemoteTarget: true,
      rpcReady: true,
      services: { systemPromptService: remoteService },
    });
    const { result } = renderHook(() => useSystemPromptOverrides(remoteTargetA));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.sections[0]?.defaultContent).toBe("remote default");
    act(() => {
      result.current.openEditor("cli-prefix", "remote default");
      result.current.setDraft("custom remote prefix");
    });
    await act(() => result.current.saveEditor());
    await act(() => result.current.restoreDefault("cli-prefix"));

    expect(remoteService.writeOverride).toHaveBeenCalledWith({
      key: "cli-prefix",
      content: "custom remote prefix",
    });
    expect(remoteService.deleteOverride).toHaveBeenCalledWith({ key: "cli-prefix" });
    expect(localService.listSections).not.toHaveBeenCalled();
    expect(localService.writeOverride).not.toHaveBeenCalled();
    expect(localService.deleteOverride).not.toHaveBeenCalled();
  });

  it("keeps an in-flight write bound to the service it started on", async () => {
    const serviceA = makeService();
    const serviceB = makeService();
    const pendingWrite = deferred<void>();
    serviceA.writeOverride.mockImplementation(() => pendingWrite.promise);
    let currentService = serviceA;
    mocks.useWorkspaceServicesResolution.mockImplementation(() => ({
      isRemoteTarget: true,
      rpcReady: true,
      services: { systemPromptService: currentService },
    }));
    const { result, rerender } = renderHook(({ target }) => useSystemPromptOverrides(target), {
      initialProps: { target: remoteTargetA },
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => {
      result.current.openEditor("cli-prefix", "default:cli-prefix");
      result.current.setDraft("custom");
    });
    let save!: Promise<void>;
    act(() => {
      save = result.current.saveEditor();
    });

    currentService = serviceB;
    rerender({ target: remoteTargetB });
    await waitFor(() => expect(serviceB.listSections).toHaveBeenCalled());
    await act(async () => {
      pendingWrite.resolve();
      await save;
    });

    expect(serviceA.writeOverride).toHaveBeenCalledTimes(1);
    expect(serviceB.writeOverride).not.toHaveBeenCalled();
  });

  it("does not load or write through a remote service while the connection is not ready", async () => {
    const remoteService = makeService();
    mocks.useWorkspaceServicesResolution.mockReturnValue({
      isRemoteTarget: true,
      rpcReady: false,
      services: { systemPromptService: remoteService },
    });
    const { result } = renderHook(() => useSystemPromptOverrides(remoteTargetA));
    await waitFor(() => expect(result.current.status).toBe("waiting"));

    act(() => {
      result.current.openEditor("cli-prefix", "default");
      result.current.setDraft("custom");
    });
    await act(() => result.current.saveEditor());

    expect(remoteService.listSections).not.toHaveBeenCalled();
    expect(remoteService.writeOverride).not.toHaveBeenCalled();
  });
});

function revisionedService(initialRevision: string | null = "rev-1") {
  let revision: string | null = initialRevision;
  let content: string | null = null;
  const sectionFor = () => ({
    key: "cli-prefix",
    defaultContent: "default:cli-prefix",
    overrideContent: content,
    filePath: "/host/.zcode/system-prompt/cli-prefix.md",
    isOverridden: content !== null,
    revision,
  });
  return {
    setDisk(next: { revision: string | null; content: string | null }) {
      revision = next.revision;
      content = next.content;
    },
    listSections: vi.fn(async () => ({ sections: [sectionFor()] })),
    writeOverride: vi.fn(async () => ({ kind: "ok" as const, revision: "rev-2" })),
    deleteOverride: vi.fn(async () => ({ kind: "ok" as const, revision: null })),
    getOverridesDirectory: vi.fn(async () => ({ path: "/host/.zcode/system-prompt" })),
  };
}

describe("useSystemPromptOverrides revisions and in-place refresh", () => {
  it("shows the loading state only on the first load, then refreshes in place", async () => {
    const service = revisionedService();
    mocks.useBaseWorkspaceServices.mockReturnValue({ systemPromptService: service });
    const { result } = renderHook(() => useSystemPromptOverrides(localTarget));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.openEditor("cli-prefix", "default:cli-prefix");
      result.current.setDraft("custom");
    });
    await act(() => result.current.saveEditor());
    // The saved row is patched from the write result, so no second listing is made.
    expect(service.listSections).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("ready");
    expect(result.current.sections[0]).toMatchObject({
      overrideContent: "custom",
      isOverridden: true,
      revision: "rev-2",
    });
  });

  it("relists after a save when the host does not report the written revision", async () => {
    const service = revisionedService("rev-1");
    service.writeOverride.mockResolvedValueOnce(undefined as never);
    mocks.useBaseWorkspaceServices.mockReturnValue({ systemPromptService: service });
    const { result } = renderHook(() => useSystemPromptOverrides(localTarget));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.openEditor("cli-prefix", "default:cli-prefix");
      result.current.setDraft("custom");
    });
    await act(() => result.current.saveEditor());
    await waitFor(() => expect(service.listSections).toHaveBeenCalledTimes(2));
  });

  it("sends the editor's captured revision and skips the check on hosts without revisions", async () => {
    const service = revisionedService("rev-1");
    mocks.useBaseWorkspaceServices.mockReturnValue({ systemPromptService: service });
    const { result } = renderHook(() => useSystemPromptOverrides(localTarget));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.openEditor("cli-prefix", "default:cli-prefix");
      result.current.setDraft("custom");
    });
    await act(() => result.current.saveEditor());
    expect(service.writeOverride).toHaveBeenCalledWith({
      key: "cli-prefix",
      content: "custom",
      expectedRevision: "rev-1",
    });
  });

  it("detects a disk change on refresh, blocks Save, and lets Reload rebase the draft", async () => {
    const service = revisionedService("rev-1");
    mocks.useBaseWorkspaceServices.mockReturnValue({ systemPromptService: service });
    const { result } = renderHook(() => useSystemPromptOverrides(localTarget));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => {
      result.current.openEditor("cli-prefix", "default:cli-prefix");
      result.current.setDraft("my draft");
    });

    service.setDisk({ revision: "rev-external", content: "edited elsewhere" });
    await act(() => result.current.reload());
    await waitFor(() => expect(result.current.editorDiskChanged).toBe(true));
    expect(result.current.canSaveEditor).toBe(false);
    expect(result.current.editor?.draft).toBe("my draft");

    act(() => result.current.reloadEditor("edited elsewhere"));
    expect(result.current.editorDiskChanged).toBe(false);
    expect(result.current.editorDirty).toBe(false);
  });

  it("turns a save conflict into the disk-changed state without writing, and Overwrite saves with the current revision", async () => {
    const service = revisionedService("rev-1");
    mocks.useBaseWorkspaceServices.mockReturnValue({ systemPromptService: service });
    const { result } = renderHook(() => useSystemPromptOverrides(localTarget));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => {
      result.current.openEditor("cli-prefix", "default:cli-prefix");
      result.current.setDraft("mine");
    });

    service.setDisk({ revision: "rev-external", content: "theirs" });
    service.writeOverride.mockResolvedValueOnce({
      kind: "conflict",
      currentRevision: "rev-external",
    });
    await act(() => result.current.saveEditor());
    expect(result.current.editor?.draft).toBe("mine");
    await waitFor(() => expect(result.current.editorDiskChanged).toBe(true));

    await act(() => result.current.saveEditor({ overwrite: { reviewedRevision: "rev-external" } }));
    expect(service.writeOverride).toHaveBeenLastCalledWith({
      key: "cli-prefix",
      content: "mine",
      expectedRevision: "rev-external",
    });
    expect(mocks.toast).toHaveBeenCalledWith("settings.systemPrompt.saved");
  });

  it("overwrites against the reviewed revision, not a newer disk revision read at click time", async () => {
    const service = revisionedService("rev-1");
    mocks.useBaseWorkspaceServices.mockReturnValue({ systemPromptService: service });
    const { result } = renderHook(() => useSystemPromptOverrides(localTarget));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => {
      result.current.openEditor("cli-prefix", "default:cli-prefix");
      result.current.setDraft("mine");
    });
    service.setDisk({ revision: "rev-external", content: "theirs" });
    await act(() => result.current.reload());
    await waitFor(() => expect(result.current.editorDiskChanged).toBe(true));

    // A newer external edit lands before the user presses Overwrite.
    service.setDisk({ revision: "rev-newer", content: "even newer" });
    await act(() => result.current.reload());
    service.writeOverride.mockResolvedValueOnce({
      kind: "conflict",
      currentRevision: "rev-newer",
    });
    await act(() => result.current.saveEditor({ overwrite: { reviewedRevision: "rev-external" } }));
    expect(service.writeOverride).toHaveBeenLastCalledWith({
      key: "cli-prefix",
      content: "mine",
      expectedRevision: "rev-external",
    });
    expect(result.current.editor?.draft).toBe("mine");
    expect(mocks.toast).toHaveBeenCalledWith("settings.systemPrompt.changedOnDisk");
  });

  it("treats an undefined write result from an older host as success", async () => {
    const service = makeService();
    mocks.useBaseWorkspaceServices.mockReturnValue({ systemPromptService: service });
    const { result } = renderHook(() => useSystemPromptOverrides(localTarget));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => {
      result.current.openEditor("cli-prefix", "default:cli-prefix");
      result.current.setDraft("custom");
    });
    await act(() => result.current.saveEditor());
    expect(result.current.editor).toBeNull();
    expect(mocks.toast).toHaveBeenCalledWith("settings.systemPrompt.saved");
  });

  it("restores with the revision the user confirmed and reports a conflict without deleting", async () => {
    const service = revisionedService("rev-1");
    service.deleteOverride.mockResolvedValueOnce({ kind: "conflict", currentRevision: "rev-9" });
    mocks.useBaseWorkspaceServices.mockReturnValue({ systemPromptService: service });
    const { result } = renderHook(() => useSystemPromptOverrides(localTarget));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(() => result.current.restoreDefault("cli-prefix", "rev-1"));
    expect(service.deleteOverride).toHaveBeenCalledWith({
      key: "cli-prefix",
      expectedRevision: "rev-1",
    });
    expect(mocks.toast).toHaveBeenCalledWith("settings.systemPrompt.changedOnDisk");
  });

  it("reset-all deletes each entry with its confirmed revision and reports partial conflicts", async () => {
    const service = revisionedService("rev-1");
    service.deleteOverride
      .mockResolvedValueOnce({ kind: "ok", revision: null })
      .mockResolvedValueOnce({ kind: "conflict", currentRevision: "rev-x" });
    mocks.useBaseWorkspaceServices.mockReturnValue({ systemPromptService: service });
    const { result } = renderHook(() => useSystemPromptOverrides(localTarget));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(() =>
      result.current.resetAllCustomized([
        { key: "cli-prefix", expectedRevision: "rev-1" },
        { key: "harness", expectedRevision: "rev-h" },
      ]),
    );
    expect(service.deleteOverride).toHaveBeenNthCalledWith(1, {
      key: "cli-prefix",
      expectedRevision: "rev-1",
    });
    expect(service.deleteOverride).toHaveBeenNthCalledWith(2, {
      key: "harness",
      expectedRevision: "rev-h",
    });
    expect(mocks.toast).toHaveBeenCalledWith("settings.systemPrompt.resetAllPartial");
  });

  it("throttles focus refreshes to one per two seconds", async () => {
    const service = revisionedService("rev-1");
    mocks.useBaseWorkspaceServices.mockReturnValue({ systemPromptService: service });
    const { result } = renderHook(() => useSystemPromptOverrides(localTarget));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const before = service.listSections.mock.calls.length;

    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(service.listSections.mock.calls.length).toBe(before + 1));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.listSections.mock.calls.length).toBe(before + 1);
  });

  it("counts a rejected reset entry as failed and still deletes the others", async () => {
    const service = revisionedService("rev-1");
    service.deleteOverride
      .mockRejectedValueOnce(new Error("disk gone"))
      .mockResolvedValueOnce({ kind: "ok", revision: null });
    mocks.useBaseWorkspaceServices.mockReturnValue({ systemPromptService: service });
    const { result } = renderHook(() => useSystemPromptOverrides(localTarget));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(() =>
      result.current.resetAllCustomized([
        { key: "cli-prefix", expectedRevision: "rev-1" },
        { key: "harness", expectedRevision: "rev-h" },
      ]),
    );
    expect(service.deleteOverride).toHaveBeenCalledTimes(2);
    expect(mocks.toast).toHaveBeenCalledWith("settings.systemPrompt.resetAllPartial");
  });

  it("refreshes silently when the window regains focus", async () => {
    const service = revisionedService("rev-1");
    mocks.useBaseWorkspaceServices.mockReturnValue({ systemPromptService: service });
    const { result } = renderHook(() => useSystemPromptOverrides(localTarget));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const before = service.listSections.mock.calls.length;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(service.listSections.mock.calls.length).toBe(before + 1));
    expect(result.current.status).toBe("ready");
  });
});
