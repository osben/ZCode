import type { Locale } from "@zcode/shared";
import { FALLBACK_UI_LOCALE, PlatformChannels, resolveSystemLocale } from "@zcode/shared";
import type { PluginSandboxHandle, PluginSandboxRegisterInput } from "@zcode/shared/mcp-apps";
import {
  BrowserWindow,
  clipboard,
  ClipboardItem,
  MessageChannelMain,
  app,
  dialog,
  session as electronSession,
  webContents as electronWebContents,
  ipcMain,
  systemPreferences,
  type WebContents,
} from "electron";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { PluginSandboxRecord, PluginSandboxRegistryPort } from "./contract.js";
import { attachPluginSandboxGuest, configurePluginSandboxGuest } from "./guestPolicy.js";
import { createPluginSandboxPermissionGate } from "./permissionGate.js";
import { formatPluginSandboxPermissionDialogText } from "./permissions.js";
import type { PluginSandboxAssetSource } from "./protocol.js";
import { createPluginSandboxRegistry } from "./registry.js";
import { preparePluginSandboxSession } from "./session.js";
import { sandboxCaptureSchema, scaleCaptureRect } from "./capture.js";
import { DesktopBrowserScreenshotActivityController } from "@desktop/main/browserView/browserScreenshotActivityController.js";

export interface PluginSandboxHost {
  clearBrowserData(): Promise<void>;
  /** Registration from the host process via parentPort; partition session preparation completes before the handle is returned. */
  registerFromHost(input: PluginSandboxRegisterInput): PluginSandboxHandle;
  /** desktopWindowChrome's will-attach branch. */
  configureGuest(input: {
    webPreferences: Electron.WebPreferences;
    params: Record<string, string>;
    ownerWebContentsId: number;
  }): ReturnType<typeof configurePluginSandboxGuest>;
  /** desktopWindowChrome's did-attach branch. */
  attachGuest(input: { guest: WebContents; hostWebContents: WebContents; sandboxId: string }): void;
}

let installedHost: PluginSandboxHost | null = null;

export function getPluginSandboxHost(): PluginSandboxHost | null {
  return installedHost;
}

/**
 * Installed once after app ready: creates the registry and registers the two renderer-callable
 * IPC channels (dispose / gesture consumption, validated by sender ownership).
 * The scheme's privileged registration must happen before app ready in the same call as
 * zcode-media, not here.
 */
export function installPluginSandboxHost(input: {
  preloadPath: string;
  rendererDir: string;
  aliasDir: string;
  /** Vite dev server URL; when set, shell assets are proxied from it (see PluginSandboxAssetSource). */
  devServerUrl?: string;
  logger?: { warn: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
  registry?: PluginSandboxRegistryPort;
  /** Registry capacity (default 64); e2e L05 uses 1 to verify quota rejection. */
  registryMaxEntries?: number;
  /** App language (same source as resolveEffectiveConfirmationLocale in index.ts); read each time a dialog opens. Defaults to the system language. */
  getLocale?: () => Locale;
}): PluginSandboxHost {
  if (installedHost) return installedHost;
  const detachByKey = new Map<string, () => void>();
  const watchedOwners = new Set<number>();
  const guests = new Map<string, WebContents>();
  const activity = new DesktopBrowserScreenshotActivityController({
    fromId: (id) => BrowserWindow.fromId(id),
    fromWebContentsId: (id) => electronWebContents.fromId(id) ?? null,
    log: (message) => input.logger?.warn(message),
  });
  const executions = new Map<string, { lease?: ReturnType<typeof activity.acquire> }>();
  const releaseExecution = (sandboxId: string) => {
    executions.get(sandboxId)?.lease?.release();
    executions.delete(sandboxId);
  };
  const syncExecution = (sandboxId: string) => {
    const state = executions.get(sandboxId);
    const guest = guests.get(sandboxId);
    if (!state || state.lease || !guest || guest.isDestroyed() || guest.isLoadingMainFrame())
      return;
    const owner = guest.hostWebContents;
    const win = owner && BrowserWindow.fromWebContents(owner);
    if (!win) return;
    state.lease = activity.acquire({
      windowId: win.id,
      webContentsId: guest.id,
      requestId: sandboxId,
      reason: "plugin-execution",
    });
    // Hidden pages only need low-frequency progress; backgroundThrottling must not be globally disabled or idle guests in the same window would also tick frames.
    state.lease?.markPrepared?.();
    state.lease?.invalidated?.addEventListener(
      "abort",
      () => {
        if (executions.get(sandboxId) === state) releaseExecution(sandboxId);
      },
      { once: true },
    );
  };
  const stopping = new WeakMap<WebContents, Promise<void>>();
  const partitions = new Set<string>();
  let clearing = false;
  const assets: PluginSandboxAssetSource = {
    rendererDir: input.rendererDir,
    aliasDir: input.aliasDir,
    ...(input.devServerUrl ? { devServerUrl: input.devServerUrl } : {}),
  };
  const stopGuest = (guest: WebContents): Promise<void> => {
    if (guest.isDestroyed()) return Promise.resolve();
    const existing = stopping.get(guest);
    if (existing) return existing;
    // In Electron 41, attached guest.close only destroys the wrapper object; the iframe can still write storage.
    // Complete a native blank-page navigation first to really remove the old document; do not guess the page stopped from destroyed events or delays.
    const stopped = Promise.resolve().then(async () => {
      if (guest.isDestroyed()) return;
      const allowUnload = (event: Electron.Event) => event.preventDefault();
      guest.on("will-prevent-unload", allowUnload);
      try {
        await guest.loadURL("about:blank");
      } catch (error) {
        // The renderer removing the webview / the owner closing aborts the navigation; at that point the real document is already released.
        if (!guest.isDestroyed()) throw error;
      } finally {
        guest.removeListener("will-prevent-unload", allowUnload);
      }
      if (guest.isDestroyed()) return;
      const destroyed = new Promise<void>((resolve) => guest.once("destroyed", resolve));
      guest.close({ waitForBeforeUnload: false });
      await destroyed;
    });
    stopping.set(guest, stopped);
    return stopped;
  };
  // Partitions are persistent and isolated per trusted app identity: dispose closes the guest
  // and ports, but does not unregister the protocol handler or clear storage; storage cleanup
  // goes through the existing clear-all-data entry.
  const onDispose = (record: PluginSandboxRecord) => {
    releaseExecution(record.sandboxId);
    detachByKey.get(record.sandboxId)?.();
    detachByKey.delete(record.sandboxId);
    const guest = guests.get(record.sandboxId);
    // Keep the guest until it truly stops: clearing data must be able to wait for old instances already in dispose.
    if (guest)
      void stopGuest(guest).catch((error: unknown) =>
        input.logger?.warn("[plugin-sandbox] guest stop failed", String(error)),
      );
  };
  const registry =
    input.registry ??
    createPluginSandboxRegistry({
      onDispose,
      ...(input.registryMaxEntries !== undefined ? { maxEntries: input.registryMaxEntries } : {}),
    });

  // Page browser-permission gate: the confirmation dialog is popped natively by main, and the
  // parent window is the host window that registered the sandbox, so the page cannot fake it.
  // The default language shares its source with desktopApplicationMenu's
  // resolveSystemApplicationLocale (system language first).
  const resolveLocale = (): Locale =>
    input.getLocale?.() ??
    resolveSystemLocale(
      app.getPreferredSystemLanguages?.()[0] ?? app.getLocale(),
      FALLBACK_UI_LOCALE,
    );
  const permissions = createPluginSandboxPermissionGate({
    registry,
    async prompt({ record, permissions: pending }) {
      const text = formatPluginSandboxPermissionDialogText(
        { serverName: record.serverName ?? "ZCode Gen UI", permissions: pending },
        resolveLocale(),
      );
      const owner = electronWebContents.fromId(record.ownerWebContentsId);
      const parent = owner ? BrowserWindow.fromWebContents(owner) : null;
      const options = {
        type: "question" as const,
        buttons: [text.allowButton, text.denyButton],
        defaultId: 1,
        cancelId: 1,
        title: text.title,
        message: text.message,
        detail: text.detail,
        noLink: true,
      };
      const { response } =
        parent && !parent.isDestroyed()
          ? await dialog.showMessageBox(parent, options)
          : await dialog.showMessageBox(options);
      return response === 0;
    },
    ...(process.platform === "darwin"
      ? {
          async requestSystemMediaAccess(kind: "camera" | "microphone") {
            const status = systemPreferences.getMediaAccessStatus(kind);
            if (status === "granted") return true;
            if (status !== "not-determined") return false;
            return systemPreferences.askForMediaAccess(kind);
          },
        }
      : {}),
    ...(input.logger ? { logger: input.logger } : {}),
  });

  const host: PluginSandboxHost = {
    async clearBrowserData() {
      clearing = true;
      for (const owner of watchedOwners) registry.disposeOwner(owner);
      await Promise.all([...guests.values()].map(stopGuest));
      guests.clear();
      const names = await readdir(join(app.getPath("sessionData"), "Partitions")).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      );
      for (const name of names)
        if (/^plugin-sandbox-v[12]-[a-f0-9]+$/.test(name)) partitions.add(`persist:${name}`);
      await Promise.all(
        [...partitions].map(async (partition) => {
          const session = electronSession.fromPartition(partition);
          await session.clearStorageData();
          await session.clearCache();
        }),
      );
    },
    registerFromHost(registerInput) {
      if (clearing) throw new Error("MCP App browser data is being cleared");
      const owner = electronWebContents.fromId(registerInput.ownerWebContentsId);
      if (!owner || owner.isDestroyed()) throw new Error("MCP App window is no longer available");
      const handle = registry.register(registerInput);
      partitions.add(handle.partition);
      // Registrations prepared but not yet attached also belong to the window; close and clear-data must not miss them.
      if (!watchedOwners.has(owner.id)) {
        watchedOwners.add(owner.id);
        owner.once("destroyed", () => {
          watchedOwners.delete(owner.id);
          registry.disposeOwner(owner.id);
        });
      }
      preparePluginSandboxSession({
        session: electronSession.fromPartition(handle.partition),
        registry,
        assets,
        permissions,
        logger: input.logger,
      });
      // One record per sandbox registration, for debugging the renderer / host / main three-way handshake.
      input.logger?.info?.("[plugin-sandbox] registered", {
        sandboxId: handle.sandboxId,
        initId: handle.initId,
        scopeId: registerInput.scopeId,
        ownerWebContentsId: registerInput.ownerWebContentsId,
      });
      return handle;
    },
    configureGuest(guestInput) {
      return configurePluginSandboxGuest({
        ...guestInput,
        registry,
        preloadPath: input.preloadPath,
      });
    },
    attachGuest({ guest, hostWebContents, sandboxId }) {
      if (clearing) {
        void stopGuest(guest).catch((error: unknown) =>
          input.logger?.warn("[plugin-sandbox] late guest stop failed", String(error)),
        );
        return;
      }
      guests.set(sandboxId, guest);
      // At dom-ready / did-finish-load the page may still be loading; early activity requests get
      // skipped by the guard above. Carry pending requests on the real load-stopped event; do not
      // rely on the plugin or session re-sending an activity request.
      guest.on("did-stop-loading", () => syncExecution(sandboxId));
      guest.once("destroyed", () => {
        if (guests.get(sandboxId) === guest) {
          releaseExecution(sandboxId);
          guests.delete(sandboxId);
        }
      });
      // H14: when the host webContents is destroyed (window closed / crash), release all its registrations; attach only once per owner.
      if (!watchedOwners.has(hostWebContents.id)) {
        watchedOwners.add(hostWebContents.id);
        const ownerId = hostWebContents.id;
        hostWebContents.once("destroyed", () => {
          watchedOwners.delete(ownerId);
          registry.disposeOwner(ownerId);
        });
      }
      detachByKey.get(sandboxId)?.();
      detachByKey.set(
        sandboxId,
        attachPluginSandboxGuest({
          guest,
          hostWebContents,
          registry,
          sandboxId,
          createMessageChannel: () => new MessageChannelMain(),
          logger: input.logger,
        }),
      );
    },
  };

  ipcMain.handle(PlatformChannels.PluginSandboxOwnerWebContentsId, (event) => event.sender.id);
  ipcMain.handle(
    PlatformChannels.PluginSandboxExecutionActive,
    (event, sandboxId: unknown, initId: unknown, active: unknown) => {
      if (
        typeof sandboxId !== "string" ||
        typeof initId !== "number" ||
        typeof active !== "boolean"
      )
        throw new Error("Invalid sandbox execution request");
      const record = registry.get(sandboxId);
      if (
        !record ||
        record.ownerWebContentsId !== event.sender.id ||
        record.initId !== initId ||
        record.contentKind === "gen-ui"
      )
        throw new Error("Sandbox execution is no longer available");
      if (!active) {
        releaseExecution(sandboxId);
        return;
      }
      if (!executions.has(sandboxId)) executions.set(sandboxId, {});
      syncExecution(sandboxId);
    },
  );
  ipcMain.handle(PlatformChannels.PluginSandboxCopyImage, async (event, value: unknown) => {
    const request = sandboxCaptureSchema.parse(value);
    const record = registry.get(request.sandboxId);
    const guest = guests.get(request.sandboxId);
    const isCurrent = () =>
      record &&
      registry.get(request.sandboxId) === record &&
      record.ownerWebContentsId === event.sender.id &&
      record.initId === request.initId &&
      !event.sender.isDestroyed() &&
      guest &&
      !guest.isDestroyed() &&
      guests.get(request.sandboxId) === guest;
    if (!isCurrent() || !guest) throw new Error("Sandbox capture is no longer available");
    const captured = await guest.capturePage();
    // The page may be released or replaced during capture; a stale request must not write the wrong page's image to the clipboard.
    if (!isCurrent()) throw new Error("Sandbox capture is no longer available");
    const cropped = captured.crop(scaleCaptureRect(request, captured.getSize()));
    // Electron 44 removed synchronous writeImage; keep the image encoded as PNG and confirm the copy only after the native write completes.
    await clipboard.write([
      new ClipboardItem({
        "image/png": new Blob([Uint8Array.from(cropped.toPNG())], { type: "image/png" }),
      }),
    ]);
  });
  ipcMain.handle(
    PlatformChannels.PluginSandboxDispose,
    (event, sandboxId: unknown, initId: unknown) => {
      if (typeof sandboxId !== "string") return;
      const record = registry.get(sandboxId);
      // Only the host window that registered can release its own sandbox; other senders are silently ignored.
      if (!record || record.ownerWebContentsId !== event.sender.id) return;
      input.logger?.info?.("[plugin-sandbox] dispose requested", {
        sandboxId,
        initId,
        currentInitId: record.initId,
      });
      registry.dispose(sandboxId, typeof initId === "number" ? initId : undefined);
      const guest = guests.get(sandboxId);
      // A late dispose with an old initId must not stop a still-valid registration.
      if (guest && !registry.get(sandboxId)) return stopGuest(guest);
    },
  );
  ipcMain.handle(PlatformChannels.PluginSandboxConsumeUserGesture, (event, sandboxId: unknown) => {
    if (typeof sandboxId !== "string") return false;
    const record = registry.get(sandboxId);
    if (!record || record.ownerWebContentsId !== event.sender.id) return false;
    return registry.consumeUserGesture(sandboxId);
  });

  installedHost = host;
  return host;
}
