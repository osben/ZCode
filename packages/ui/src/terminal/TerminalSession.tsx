/* eslint-disable max-lines -- Terminal resize scheduling must stay in the same component as the xterm/PTY lifecycle to avoid races from splitting drag state, fit, and the backend resize queue.*/
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { ClipboardPaste, Copy } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import type { ILink, ILinkHandler, ITheme, IWindowsPty } from "@xterm/xterm";
import type { IServiceAccessor } from "@zcode/services";
import type { IDisposable } from "@zcode/rpc";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import type { ZCodeState } from "@/store/index.js";
import { logger } from "@/logger.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import {
  createPendingTerminalInputFallback,
  consumeTerminalInputFallbackHandledData,
  createTerminalInputFallbackKeydownCandidate,
  markTerminalInputFallbackHandled,
  recordTerminalInputFallbackHandledData,
  recordTerminalInputFallbackRecentData,
  resolveTerminalInputFallbackAction,
  type PendingTerminalInputFallback,
  type TerminalInputFallbackKeydownCandidate,
  type TerminalInputFallbackHandledData,
} from "@/terminal/terminalComposedInputFallback.js";
import { normalizePowerShellReadlineRedraw } from "@/terminal/terminalDataTransform.js";
import { getHttpLinksForTerminalBufferLine } from "@/terminal/terminalLinks.js";
import { mergeTerminalTheme } from "@/terminal/terminalTheme.js";
import { setTerminalWebglRenderer } from "@/terminal/terminalWebglRenderer.js";
import {
  sidePaneTerminalSessionRegistry,
  type SidePaneTerminalSessionEntry,
} from "@/terminal/sidePaneTerminalSessionRegistry.js";

const DEFAULT_TERMINAL_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, 'Cascadia Mono', 'JetBrains Mono', 'MesloLGS NF', 'Hack Nerd Font', monospace";
const TERMINAL_RESIZE_DRAG_THROTTLE_MS = 300;
// Stable module-level selector: useZCodeStoreWithDefault requires a stable selector reference or it will rerender indefinitely.
const selectTerminalWebglEnabled = (state: ZCodeState) => state.terminalWebglEnabled;
const TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS = 150;
const TERMINAL_INPUT_FALLBACK_KEYDOWN_INPUT_MS = 40;
const TERMINAL_INPUT_FALLBACK_FLUSH_DELAY_MS = 150;

type TerminalResizeReason = "drag" | "final" | "visible" | "init" | "observer";

type TerminalSize = {
  cols: number;
  rows: number;
};

function normalizeWindowsPtyOption(windowsPty: IWindowsPty | undefined): IWindowsPty | undefined {
  if (!windowsPty) return undefined;
  return windowsPty.buildNumber
    ? { backend: windowsPty.backend, buildNumber: windowsPty.buildNumber }
    : { backend: windowsPty.backend };
}

function normalizeTerminalFontSize(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 6 || value > 72) {
    return undefined;
  }
  return value;
}

function formatShellLabel(shell: string | null): string | null {
  if (!shell) {
    return null;
  }

  const shellParts = shell.split(/[\\/]/);
  const lastPart = shellParts[shellParts.length - 1];
  const name = lastPart?.replace(/\.exe$/i, "").toLowerCase();
  if (!name) {
    return shell;
  }
  if (name === "powershell" || name === "pwsh") {
    return "PowerShell";
  }
  return name;
}

function isHttpTerminalUrl(text: string): boolean {
  return /^https?:\/\//i.test(text);
}

export function TerminalSession({
  sessionId,
  services,
  cwd,
  isVisible,
  isPanelResizing = false,
  isWindowsDesktop = false,
  onShellLabelChange,
  onExit,
  onOpenBrowserUrl,
  persistentKey,
  workspaceKey,
}: {
  sessionId: string;
  services: IServiceAccessor;
  cwd?: string;
  isVisible: boolean;
  isPanelResizing?: boolean;
  isWindowsDesktop?: boolean;
  onShellLabelChange: (sessionId: string, shellLabel: string | null) => void;
  onExit?: (sessionId: string, exitCode: number) => void;
  onOpenBrowserUrl: (url: string) => void;
  /**
   * Session reuse key across component lifecycles (for side-pane terminals only).
   * When provided, ownership of the xterm instance and PTY moves to the sidePaneTerminalSessionRegistry module-level singleton,
   * component unmount only detaches the DOM and does not dispose resources; remount reuses the key, preserving scrollback history across workspaces.
   * When omitted (bottom terminal), use the original effect path with byte-for-byte unchanged behavior.
   */
  persistentKey?: string;
  /**
   * Workspace identity isolation key (= workspaceIdentity?.trim() || workspacePath).
   * Used only with persistentKey: write to registry entry.workspaceKey,
   * so PTYs can be disposed by workspaceKey when a workspace tab is actually closed (matching bottom-terminal openWorkspaceKeys cleanup).
   * Falls back to cwd when omitted. The bottom terminal does not pass persistentKey, so this value has no effect there.
   */
  workspaceKey?: string;
}) {
  const { intl } = useZCodeIntl();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | undefined>(undefined);
  const isVisibleRef = useRef(isVisible);
  const resizeRAFRef = useRef(0);
  const resizeThrottleTimerRef = useRef<number | null>(null);
  const isPanelResizingRef = useRef(isPanelResizing);
  const resizeRequestStatsRef = useRef({ fit: 0, queued: 0, sent: 0, skipped: 0 });
  const lastSentTerminalSizeRef = useRef<TerminalSize | null>(null);
  const pendingTerminalSizeRef = useRef<TerminalSize | null>(null);
  const resizeInFlightRef = useRef(false);
  const focusRAFRef = useRef(0);
  const exitedMessageRef = useRef("");
  const exitHandlerRef = useRef(onExit);
  const openBrowserUrlRef = useRef(onOpenBrowserUrl);
  const terminalProfileThemeRef = useRef<ITheme | undefined>(undefined);
  const pendingInputFallbacksRef = useRef<PendingTerminalInputFallback[]>([]);
  const inputFallbackKeydownCandidateRef = useRef<TerminalInputFallbackKeydownCandidate | null>(
    null,
  );
  const recentInputFallbackHandledDataRef = useRef<TerminalInputFallbackHandledData[]>([]);

  exitedMessageRef.current = intl.formatMessage({ id: "terminal.exited" });
  exitHandlerRef.current = onExit;
  openBrowserUrlRef.current = onOpenBrowserUrl;
  // If there is no StoreProvider (for example, in a unit-test harness), default to closed and keep the DOM renderer.
  const terminalWebglEnabled = useZCodeStoreWithDefault(selectTerminalWebglEnabled, false);
  const terminalWebglEnabledRef = useRef(terminalWebglEnabled);
  terminalWebglEnabledRef.current = terminalWebglEnabled;

  const flushTerminalServiceResize = useCallback(() => {
    if (resizeInFlightRef.current) {
      return;
    }

    const terminalId = terminalIdRef.current;
    const pendingSize = pendingTerminalSizeRef.current;
    if (!terminalId || !pendingSize) {
      return;
    }

    pendingTerminalSizeRef.current = null;
    resizeInFlightRef.current = true;
    resizeRequestStatsRef.current.sent += 1;

    const startedAt = performance.now();
    void services.terminalService
      .resize({
        id: terminalId,
        cols: pendingSize.cols,
        rows: pendingSize.rows,
      })
      .then(() => {
        logger.debug("[Terminal] resize sent", {
          cols: pendingSize.cols,
          durationMs: Math.round(performance.now() - startedAt),
          fitCount: resizeRequestStatsRef.current.fit,
          queuedCount: resizeRequestStatsRef.current.queued,
          rows: pendingSize.rows,
          sentCount: resizeRequestStatsRef.current.sent,
          skippedCount: resizeRequestStatsRef.current.skipped,
          terminalId,
          terminalTabId: sessionId,
        });
      })
      .catch((error) => {
        logger.warn("[Terminal] resize failed:", error);
      })
      .finally(() => {
        resizeInFlightRef.current = false;
        if (pendingTerminalSizeRef.current) {
          flushTerminalServiceResize();
        }
      });
  }, [services.terminalService, sessionId]);

  const queueTerminalServiceResize = useCallback(
    (size: TerminalSize) => {
      const lastSentSize = lastSentTerminalSizeRef.current;
      const pendingSize = pendingTerminalSizeRef.current;
      if (
        (lastSentSize?.cols === size.cols && lastSentSize.rows === size.rows && !pendingSize) ||
        (pendingSize?.cols === size.cols && pendingSize.rows === size.rows)
      ) {
        resizeRequestStatsRef.current.skipped += 1;
        return;
      }

      pendingTerminalSizeRef.current = size;
      lastSentTerminalSizeRef.current = size;
      resizeRequestStatsRef.current.queued += 1;
      flushTerminalServiceResize();
    },
    [flushTerminalServiceResize],
  );

  const clearResizeThrottleTimer = useCallback(() => {
    if (resizeThrottleTimerRef.current) {
      window.clearTimeout(resizeThrottleTimerRef.current);
      resizeThrottleTimerRef.current = null;
    }
  }, []);

  const requestFitAndResize = useCallback(
    (reason: TerminalResizeReason = "observer") => {
      if (resizeRAFRef.current) {
        cancelAnimationFrame(resizeRAFRef.current);
      }

      resizeRAFRef.current = requestAnimationFrame(() => {
        resizeRAFRef.current = 0;
        const el = containerRef.current;
        const term = termRef.current;
        const fitAddon = fitAddonRef.current;
        if (
          !isVisibleRef.current ||
          !el ||
          !term ||
          !fitAddon ||
          el.clientWidth <= 0 ||
          el.clientHeight <= 0
        ) {
          return;
        }

        try {
          resizeRequestStatsRef.current.fit += 1;
          fitAddon.fit();
        } catch (error) {
          logger.warn("[Terminal] fit failed:", error);
          return;
        }

        logger.debug("[Terminal] fit requested resize", {
          cols: term.cols,
          reason,
          resizing: isPanelResizingRef.current,
          rows: term.rows,
          terminalId: terminalIdRef.current,
          terminalTabId: sessionId,
        });
        queueTerminalServiceResize({ cols: term.cols, rows: term.rows });
      });
    },
    [queueTerminalServiceResize, sessionId],
  );

  const scheduleFitAndResize = useCallback(
    (reason: TerminalResizeReason = "observer") => {
      if (!isPanelResizingRef.current || reason === "final") {
        clearResizeThrottleTimer();
        requestFitAndResize(reason);
        return;
      }

      if (resizeThrottleTimerRef.current) {
        return;
      }

      // ResizeObserver fires every layout frame while dragging the terminal height.
      // xterm fit plus PTY resize combines synchronous layout with cross-process requests; during dragging, preview at a fixed low rate and flush the final size on release.
      resizeThrottleTimerRef.current = window.setTimeout(() => {
        resizeThrottleTimerRef.current = null;
        requestFitAndResize("drag");
      }, TERMINAL_RESIZE_DRAG_THROTTLE_MS);
    },
    [clearResizeThrottleTimer, requestFitAndResize],
  );

  const requestFocus = useCallback(() => {
    if (focusRAFRef.current) {
      cancelAnimationFrame(focusRAFRef.current);
    }

    focusRAFRef.current = requestAnimationFrame(() => {
      focusRAFRef.current = 0;
      const term = termRef.current;
      if (!isVisibleRef.current || !term) {
        return;
      }

      // When opening, creating, or switching terminals, React updates only the visible tab, leaving focus on the button or input.
      // xterm creates its textarea after open, so wait one frame and confirm the current session is still visible before focusing it.
      term.focus();
      logger.debug("[Terminal] focused visible terminal", {
        terminalId: terminalIdRef.current,
        terminalTabId: sessionId,
      });
    });
  }, [sessionId]);

  useEffect(() => {
    isVisibleRef.current = isVisible;
    if (isVisible) {
      scheduleFitAndResize("visible");
      requestFocus();
    }
  }, [isVisible, requestFocus, scheduleFitAndResize]);

  useEffect(() => {
    const wasResizing = isPanelResizingRef.current;
    isPanelResizingRef.current = isPanelResizing;
    if (wasResizing && !isPanelResizing && isVisibleRef.current) {
      scheduleFitAndResize("final");
    }
  }, [isPanelResizing, scheduleFitAndResize]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // ===== persistentKey path: preserve side-pane terminal sessions across workspaces =====
    // Move xterm instance and PTY ownership into the sidePaneTerminalSessionRegistry module-level singleton,
    // unmount only detaches the DOM without disposing resources; remount reuses persistentKey and preserves scrollback across workspaces.
    // Original path (bottom terminal without persistentKey) remains byte-for-byte unchanged.
    if (persistentKey) {
      terminalProfileThemeRef.current = undefined;
      const existingEntry = sidePaneTerminalSessionRegistry.get(persistentKey);

      // --- Reuse fast path: returning to a workspace/remounting when the entry is already in the registry ---
      if (existingEntry) {
        termRef.current = existingEntry.term;
        fitAddonRef.current = existingEntry.fitAddon;
        terminalIdRef.current = existingEntry.terminalId || undefined;
        el.appendChild(existingEntry.hostEl);
        const reuseThemeObserver = new MutationObserver(() => {
          // Read from entry.profileTheme: after remount, the component-local ref has reset to undefined,
          // and the profile theme exists only in the registry entry, so it must be read there or the user-configured terminal colors are lost.
          existingEntry.term.options.theme = mergeTerminalTheme(existingEntry.profileTheme);
        });
        reuseThemeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["class"],
        });
        let reuseResizeRAF = 0;
        const reuseResizeObserver = new ResizeObserver(() => {
          if (!isVisibleRef.current) return;
          if (reuseResizeRAF) cancelAnimationFrame(reuseResizeRAF);
          reuseResizeRAF = requestAnimationFrame(() => scheduleFitAndResize("observer"));
        });
        reuseResizeObserver.observe(el);
        try {
          resizeRequestStatsRef.current.fit += 1;
          existingEntry.fitAddon.fit();
        } catch (error) {
          logger.warn("[Terminal] persistent reuse fit failed:", error);
        }
        if (isVisibleRef.current) {
          requestFocus();
        }
        logger.debug("[Terminal] persistent reuse", {
          terminalTabId: sessionId,
          persistentKey,
        });
        return () => {
          reuseThemeObserver.disconnect();
          reuseResizeObserver.disconnect();
          if (reuseResizeRAF) cancelAnimationFrame(reuseResizeRAF);
          sidePaneTerminalSessionRegistry.detachDom(persistentKey);
          // Do not dispose: keep term/PTY/subscriptions in the registry for reuse.
          termRef.current = null;
          fitAddonRef.current = null;
        };
      }

      // --- First creation: keep hostEl persistent, open term on hostEl, and put resources in the registry. ---
      const hostEl = document.createElement("div");
      hostEl.className = "terminal-xterm-shell h-full min-h-0 w-full overflow-hidden";
      el.appendChild(hostEl);

      let ptyCancelled = false;
      const registryDisposers: IDisposable[] = [];
      const localDisposers: IDisposable[] = [];

      const term = new XTerm({
        fontSize: 13,
        fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
        theme: mergeTerminalTheme(terminalProfileThemeRef.current),
        linkHandler: {
          allowNonHttpProtocols: false,
          activate(event, text) {
            if (!isHttpTerminalUrl(text)) return;
            event.preventDefault();
            logger.debug("[Terminal] open OSC 8 http link", { url: text });
            openBrowserUrlRef.current(text);
          },
        } satisfies ILinkHandler,
      });
      termRef.current = term;

      const fitAddon = new FitAddon();
      fitAddonRef.current = fitAddon;
      term.loadAddon(fitAddon);
      term.loadAddon(new ClipboardAddon());
      term.open(hostEl);
      setTerminalWebglRenderer(term, terminalWebglEnabledRef.current);

      let initialTerminalSize: TerminalSize | null = null;
      if (isVisibleRef.current && hostEl.clientWidth > 0 && hostEl.clientHeight > 0) {
        try {
          resizeRequestStatsRef.current.fit += 1;
          fitAddon.fit();
          initialTerminalSize = { cols: term.cols, rows: term.rows };
          lastSentTerminalSizeRef.current = initialTerminalSize;
          logger.debug("[Terminal] initial fit before create (persistent)", {
            cols: initialTerminalSize.cols,
            rows: initialTerminalSize.rows,
            terminalTabId: sessionId,
          });
        } catch (error) {
          logger.warn("[Terminal] persistent initial fit failed:", error);
        }
      }
      if (isVisibleRef.current) {
        requestFocus();
      }

      // Component-local customKeyEventHandler (depends on the component inputFallback ref)
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        inputFallbackKeydownCandidateRef.current =
          e.metaKey || e.ctrlKey || e.altKey
            ? null
            : createTerminalInputFallbackKeydownCandidate({
                eventTimeStamp: e.timeStamp,
                key: e.key,
                now: performance.now(),
              });
        if (!(e.metaKey || e.ctrlKey)) return true;
        const key = e.key.toLowerCase();
        if (key === "c" && term.hasSelection()) {
          void navigator.clipboard.writeText(term.getSelection()).catch((err) => {
            logger.warn("[Terminal] copy via shortcut failed:", err);
          });
          return false;
        }
        if (key === "v") {
          // attachCustomKeyEventHandler returning false only prevents xterm from handling Ctrl+V;
          // it does not cancel the native paste event dispatched by the browser afterward. After manually pasting once here,
          // xterm’s built-in listener writes the native paste again, duplicating the shortcut paste.
          // Therefore, prevent the default event first, then keep the single write from manually reading the clipboard.
          // Keep this byte-aligned with the original path (bottom terminal): the two copies drifted here before (persistentKey missed a debug log),
          // remove this comment after a future refactor consolidates both paths into one wireTerminalProcessing.
          e.preventDefault();
          e.stopPropagation();
          navigator.clipboard
            .readText()
            .then((text) => {
              logger.debug("[Terminal] paste via shortcut", { length: text.length });
              if (text) term.paste(text);
            })
            .catch((err) => logger.warn("[Terminal] paste via shortcut failed:", err));
          return false;
        }
        return true;
      });

      // Component-local theme observer
      const themeObserver = new MutationObserver(() => {
        // Read from entry.profileTheme: the registry entry owns the profile theme and persists across remounts;
        // the component-local terminalProfileThemeRef loses the profile theme after remount and cannot be the observer data source.
        term.options.theme = mergeTerminalTheme(entry.profileTheme);
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
      localDisposers.push({ dispose: () => themeObserver.disconnect() } as IDisposable);

      // Register in the registry: linkProvider (harmless to retain while detached)
      registryDisposers.push(
        term.registerLinkProvider({
          provideLinks(bufferLineNumber, callback) {
            const links = getHttpLinksForTerminalBufferLine(
              term.buffer.active,
              bufferLineNumber,
              term.cols,
            )?.map(
              (link): ILink => ({
                ...link,
                activate(event, text) {
                  event.preventDefault();
                  logger.debug("[Terminal] open plain http link", { url: text });
                  openBrowserUrlRef.current(text);
                },
              }),
            );
            callback(links);
          },
        }),
      );

      // Store a placeholder entry in the registry first (terminalId is filled asynchronously); use it to determine remount/disposal.
      const entry: SidePaneTerminalSessionEntry = {
        key: persistentKey,
        term,
        fitAddon,
        terminalId: "",
        cwd: cwd ?? "",
        // workspaceKey is used to dispose by workspace when a workspace tab is actually closed (matching bottom-terminal openWorkspaceKeys).
        workspaceKey: workspaceKey ?? cwd ?? "",
        hostEl,
        dispose: () => {}, // Complete it immediately afterward
      };
      entry.dispose = () => {
        ptyCancelled = true;
        for (const d of registryDisposers) {
          try {
            d.dispose();
          } catch (error) {
            logger.warn("[Terminal] persistent dispose disposer failed:", error);
          }
        }
        if (entry.terminalId) {
          void services.terminalService.dispose({ id: entry.terminalId });
        }
        try {
          term.dispose();
        } catch (error) {
          logger.warn("[Terminal] persistent term.dispose failed:", error);
        }
      };
      sidePaneTerminalSessionRegistry.register(persistentKey, entry);

      // Create the PTY (asynchronously)
      const initialCreateSize = initialTerminalSize ?? { cols: term.cols, rows: term.rows };
      void services.terminalService
        .create({ cols: initialCreateSize.cols, rows: initialCreateSize.rows, cwd })
        .then(({ id, shell, fontFamily, fontSize, theme, fontFamilySource, windowsPty }) => {
          if (ptyCancelled) {
            // Cleanup already ran: kill this orphan PTY instead of adding it to the entry.
            void services.terminalService.dispose({ id });
            return;
          }
          entry.terminalId = id;
          terminalIdRef.current = id;
          // Match the original path: once the id is ready, immediately flush resizes queued during creation (pendingTerminalSizeRef).
          // Otherwise scheduleFitAndResize("init") may be deduplicated by pendingSize, leaving the PTY at the wrong cols/rows.
          flushTerminalServiceResize();
          term.options.windowsPty = normalizeWindowsPtyOption(windowsPty);
          term.options.fontFamily = fontFamily || DEFAULT_TERMINAL_FONT_FAMILY;
          const nextFontSize = normalizeTerminalFontSize(fontSize);
          if (nextFontSize) {
            term.options.fontSize = nextFontSize;
          }
          terminalProfileThemeRef.current = theme as ITheme | undefined;
          // Move profile theme ownership to the registry entry,
          // so reuse across component lifecycles does not lose it (previously it was only in a component-local ref; after remount the new ref was undefined, and the reused observer merged undefined into the theme).
          entry.profileTheme = theme as ITheme | undefined;
          term.options.theme = mergeTerminalTheme(entry.profileTheme);
          const nextShellLabel = formatShellLabel(shell);
          logger.info("[Terminal] shell resolved (persistent):", {
            cwd,
            fontFamilySource,
            shell,
            shellLabel: nextShellLabel,
            terminalId: id,
            terminalTabId: sessionId,
          });
          onShellLabelChange(sessionId, nextShellLabel);
          scheduleFitAndResize("init");
          if (isVisibleRef.current) {
            requestFocus();
          }

          // Data subscription → term.write (registered in the registry, so scrollback continues accumulating while detached)
          registryDisposers.push(
            services.terminalService.onDynamicData(id)((data) => {
              term.write(normalizePowerShellReadlineRedraw(data, shell));
            }),
          );
          // Exit subscription (registered in the registry; matching the original path, call onExit when provided or write an exit notice otherwise)
          registryDisposers.push(
            services.terminalService.onDynamicExit(id)((exitCode) => {
              const exitHandler = exitHandlerRef.current;
              logger.info("[Terminal] persistent session exited", {
                autoClose: Boolean(exitHandler),
                exitCode,
                terminalId: id,
                terminalTabId: sessionId,
              });
              if (exitHandler) {
                exitHandler(sessionId, exitCode);
                return;
              }
              // Side-pane Terminal does not pass onExit, so keep the exit notice.
              term.write(`\r\n${exitedMessageRef.current}\r\n`);
            }),
          );

          // onData (registered with the registry and kept for the lifetime of the terminal):
          // Do not put it in localDisposers; cleanup(detach) would cancel it, and the reuse path does not rebind it,
          // leaving scrollback visible but input non-interactive after switching back to the workspace.
          // The input subscription lifetime must match the entry lifetime (persistent with the terminal); detach must not cancel it.
          //
          // This matches onData in the original (bottom) terminal path: maintain keydown-candidate deduplication history
          // for the Windows IME textarea fallback (the three-stage deduplication loop for committed IME composition text).
          // This block handles only deduplication of committed composition text; it is unrelated to switching input methods with Shift.
          // Shift switching is an OS-level IME action (customKeyEventHandler returns true for Shift to let it pass through).
          // The actual cause of “characters lost after switching to English with Shift” was isWindowsDesktop not being passed through (fixed in WorkspaceShellLayout).
          registryDisposers.push(
            term.onData((data) => {
              const now = performance.now();
              const inputFallbackKeydownCandidate = inputFallbackKeydownCandidateRef.current;
              const handledData = recordTerminalInputFallbackHandledData({
                candidate: inputFallbackKeydownCandidate,
                data,
                history: recentInputFallbackHandledDataRef.current,
                maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
                now,
              });
              recentInputFallbackHandledDataRef.current = handledData.usedCandidate
                ? handledData.history
                : recordTerminalInputFallbackRecentData({
                    data,
                    history: handledData.history,
                    maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
                    now,
                  });
              if (handledData.usedCandidate) {
                inputFallbackKeydownCandidateRef.current = null;
              }
              markTerminalInputFallbackHandled(pendingInputFallbacksRef.current, data);
              void services.terminalService.write({ id, data });
            }),
          );

          // Windows IME fallback (registered with the registry and persistent with the terminal, same lifetime as onData).
          // The textarea element persists with the terminal instance, so bind the listener once; detach does not cancel it and the Chinese IME fallback still works after remount.
          const textarea =
            isWindowsDesktop &&
            (term as unknown as { _core: { textarea: HTMLTextAreaElement } })._core?.textarea;
          if (textarea) {
            const handleInput = (e: InputEvent) => {
              if (e.inputType !== "insertText" || !e.data || !e.composed) return;
              const insertedText = e.data;
              const now = performance.now();
              const pendingFallback = createPendingTerminalInputFallback(insertedText);
              pendingInputFallbacksRef.current.push(pendingFallback);
              consumeTerminalInputFallbackHandledData({
                history: recentInputFallbackHandledDataRef.current,
                inputEventTimeStamp: e.timeStamp,
                maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
                maxInputDelayMs: TERMINAL_INPUT_FALLBACK_KEYDOWN_INPUT_MS,
                now,
                pending: pendingFallback,
              });
              setTimeout(() => {
                pendingInputFallbacksRef.current = pendingInputFallbacksRef.current.filter(
                  (item) => item !== pendingFallback,
                );
                // Do not check ptyCancelled: the subscription persists with the entry (registryDisposers),
                // while ptyCancelled is a per-effect closure variable that becomes true after detach and would permanently disable the fallback.
                // entry.dispose removes this listener on release; write is a no-op after the PTY is disposed, so this is safe.
                const fallbackAction = resolveTerminalInputFallbackAction({
                  pending: pendingFallback,
                  textareaValue: textarea.value,
                });
                if (fallbackAction.shouldWrite) {
                  logger.debug("[Terminal] flush composed input fallback (persistent)", {
                    length: insertedText.length,
                    terminalId: id,
                    terminalTabId: sessionId,
                  });
                  void services.terminalService.write({ id, data: insertedText });
                }
                if (fallbackAction.shouldClearTextarea) {
                  textarea.value = "";
                }
              }, TERMINAL_INPUT_FALLBACK_FLUSH_DELAY_MS);
            };
            textarea.addEventListener("input", handleInput, true);
            registryDisposers.push({
              dispose: () => textarea.removeEventListener("input", handleInput, true),
            } as IDisposable);
          }
        })
        .catch((error) => {
          if (ptyCancelled) return;
          const message = error instanceof Error ? error.message : String(error);
          logger.error("[Terminal] persistent create failed:", error);
          term.write(`\r\n[Terminal failed to start]\r\n${message}\r\n`);
          // If PTY creation fails, release the placeholder entry registered for this attempt.
          // The entry is registered above with terminalId="" (line 541), then terminalService.create() runs asynchronously.
          // If it is not released on failure, a zombie terminalId="" entry remains in the registry. A remount/workspace switch then takes
          // the reuse fast path (see existingEntry above), reuses an xterm whose startup failed, and never calls terminalService.create() again,
          // leaving that terminal permanently unable to connect to a PTY.
          //
          // Ownership check: release only if the registry's current entry is still the one created by this attempt.
          // In an unusual ordering, the component may unmount before create rejects (cleanup releases the partial entry; see the !entry.terminalId
          // branch below), then remount and have the registry entry replaced by the new attempt. An unconditional release would delete the new entry.
          // Compare the closure's entry reference with the registry's current value; each creation uses a new entry object, so reference equality distinguishes generations.
          const currentEntry = sidePaneTerminalSessionRegistry.get(persistentKey);
          if (currentEntry === entry) {
            sidePaneTerminalSessionRegistry.release(persistentKey);
          }
        });

      // Component-local resize observer.
      let resizeRAF = 0;
      const resizeObserver = new ResizeObserver(() => {
        if (!isVisibleRef.current) return;
        if (resizeRAF) cancelAnimationFrame(resizeRAF);
        resizeRAF = requestAnimationFrame(() => scheduleFitAndResize("observer"));
      });
      resizeObserver.observe(el);

      logger.debug("[Terminal] persistent create", {
        terminalTabId: sessionId,
        persistentKey,
      });

      return () => {
        ptyCancelled = true;
        themeObserver.disconnect();
        resizeObserver.disconnect();
        if (resizeRAF) cancelAnimationFrame(resizeRAF);
        for (const d of localDisposers) {
          try {
            d.dispose();
          } catch (error) {
            logger.warn("[Terminal] persistent cleanup local disposer failed:", error);
          }
        }
        // If unmounted before the PTY is ready (very rare), release the partial entry so a remount does not reuse an empty PTY.
        if (!entry.terminalId) {
          sidePaneTerminalSessionRegistry.release(persistentKey);
        } else {
          sidePaneTerminalSessionRegistry.detachDom(persistentKey);
        }
        termRef.current = null;
        fitAddonRef.current = null;
      };
    }
    // ===== End of persistentKey path =====

    let disposed = false;
    terminalProfileThemeRef.current = undefined;

    const term = new XTerm({
      fontSize: 13,
      fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
      theme: mergeTerminalTheme(terminalProfileThemeRef.current),
      linkHandler: {
        allowNonHttpProtocols: false,
        activate(event, text) {
          if (!isHttpTerminalUrl(text)) {
            return;
          }
          event.preventDefault();
          logger.debug("[Terminal] open OSC 8 http link", { url: text });
          openBrowserUrlRef.current(text);
        },
      } satisfies ILinkHandler,
    });
    termRef.current = term;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);
    // Attach ClipboardAddon to support OSC 52 and let xterm's copy event write the selection to the system clipboard.
    term.loadAddon(new ClipboardAddon());
    term.open(el);
    setTerminalWebglRenderer(term, terminalWebglEnabledRef.current);
    let initialTerminalSize: TerminalSize | null = null;
    if (isVisibleRef.current && el.clientWidth > 0 && el.clientHeight > 0) {
      try {
        // If the side-pane terminal creates its PTY with xterm's default column count on mount,
        // startup output is reflowed at the wrong width during the later fit/resize, and zsh may show a highlighted PROMPT_EOL_MARK.
        // On first visibility, run fit synchronously and then start the PTY with the actual cols/rows to avoid a race between startup output and size correction.
        resizeRequestStatsRef.current.fit += 1;
        fitAddon.fit();
        initialTerminalSize = { cols: term.cols, rows: term.rows };
        lastSentTerminalSizeRef.current = initialTerminalSize;
        logger.debug("[Terminal] initial fit before create", {
          cols: initialTerminalSize.cols,
          rows: initialTerminalSize.rows,
          terminalTabId: sessionId,
        });
      } catch (error) {
        logger.warn("[Terminal] initial fit failed:", error);
      }
    }
    if (isVisibleRef.current) {
      requestFocus();
    }

    // Intercept Ctrl/Cmd+C and Ctrl/Cmd+V:
    // - On Windows/Linux, Ctrl+C is normally sent to the PTY as SIGINT, so copy instead when text is selected.
    // - Without interception, Ctrl+V is entered as the `^V` character.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      inputFallbackKeydownCandidateRef.current =
        e.metaKey || e.ctrlKey || e.altKey
          ? null
          : createTerminalInputFallbackKeydownCandidate({
              eventTimeStamp: e.timeStamp,
              key: e.key,
              now: performance.now(),
            });
      if (!(e.metaKey || e.ctrlKey)) return true;
      const key = e.key.toLowerCase();
      if (key === "c" && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection()).catch((err) => {
          logger.warn("[Terminal] copy via shortcut failed:", err);
        });
        return false;
      }
      if (key === "v") {
        // attachCustomKeyEventHandler returning false only prevents xterm from handling Ctrl+V;
        // it does not cancel the native paste event dispatched by the browser afterward. After manually pasting once here,
        // xterm’s built-in listener writes the native paste again, duplicating the shortcut paste.
        // Therefore, prevent the default event first, then keep the single write from manually reading the clipboard.
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard
          .readText()
          .then((text) => {
            logger.debug("[Terminal] paste via shortcut", { length: text.length });
            if (text) term.paste(text);
          })
          .catch((err) => logger.warn("[Terminal] paste via shortcut failed:", err));
        return false;
      }
      return true;
    });

    // Listen for theme changes and update terminal colors in real time.
    const observer = new MutationObserver(() => {
      term.options.theme = mergeTerminalTheme(terminalProfileThemeRef.current);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    const disposables: IDisposable[] = [];
    const { terminalService } = services;
    disposables.push(
      // Interaction note: plain URLs are not part of the React DOM, so calculate clickable regions from the buffer
      // through xterm's link provider, then route them to the right-side browser pane. Do not call platform APIs directly from the terminal layer.
      term.registerLinkProvider({
        provideLinks(bufferLineNumber, callback) {
          const links = getHttpLinksForTerminalBufferLine(
            term.buffer.active,
            bufferLineNumber,
            term.cols,
          )?.map(
            (link): ILink => ({
              ...link,
              activate(event, text) {
                event.preventDefault();
                logger.debug("[Terminal] open plain http link", { url: text });
                openBrowserUrlRef.current(text);
              },
            }),
          );

          callback(links);
        },
      }),
    );

    // Prefer the workspace path as the terminal working directory; the backend falls back to HOME when it is unset.
    const initialCreateSize = initialTerminalSize ?? { cols: term.cols, rows: term.rows };
    terminalService
      .create({ cols: initialCreateSize.cols, rows: initialCreateSize.rows, cwd })
      .then(({ id, shell, fontFamily, fontSize, theme, fontFamilySource, windowsPty }) => {
        if (disposed) {
          terminalService.dispose({ id });
          return;
        }

        terminalIdRef.current = id;
        // The initial fit or ResizeObserver may run before terminal ID is ready, so buffer the resize
        // in pendingTerminalSizeRef and flush it once the ID is ready; otherwise deduplication will skip the same dimensions.
        flushTerminalServiceResize();
        // On height increases, Windows ConPTY does not return scrollback to the viewport like a traditional Unix PTY.
        // Without xterm's windowsPty compatibility, PSReadLine later redraws input at old coordinates over the previous command's output.
        term.options.windowsPty = normalizeWindowsPtyOption(windowsPty);
        term.options.fontFamily = fontFamily || DEFAULT_TERMINAL_FONT_FAMILY;
        const nextFontSize = normalizeTerminalFontSize(fontSize);
        if (nextFontSize) {
          term.options.fontSize = nextFontSize;
        }
        terminalProfileThemeRef.current = theme as ITheme | undefined;
        term.options.theme = mergeTerminalTheme(terminalProfileThemeRef.current);
        const nextShellLabel = formatShellLabel(shell);
        logger.info("[Terminal] shell resolved:", {
          cwd,
          fontFamilySource,
          shell,
          shellLabel: nextShellLabel,
          terminalId: id,
          terminalTabId: sessionId,
        });
        onShellLabelChange(sessionId, nextShellLabel);
        scheduleFitAndResize("init");
        if (isVisibleRef.current) {
          requestFocus();
        }

        disposables.push(
          terminalService.onDynamicData(id)((data) => {
            term.write(normalizePowerShellReadlineRedraw(data, shell));
          }),
        );

        disposables.push(
          terminalService.onDynamicExit(id)((exitCode) => {
            const exitHandler = exitHandlerRef.current;
            logger.info("[Terminal] terminal session exited", {
              autoClose: Boolean(exitHandler),
              exitCode,
              terminalId: id,
              terminalTabId: sessionId,
            });
            if (exitHandler) {
              exitHandler(sessionId, exitCode);
              return;
            }

            // A side-pane Terminal is not part of the bottom-tab registry; keep the exit hint when onExit is not provided.
            term.write(`\r\n${exitedMessageRef.current}\r\n`);
          }),
        );

        disposables.push(
          term.onData((data) => {
            const now = performance.now();
            const inputFallbackKeydownCandidate = inputFallbackKeydownCandidateRef.current;
            const handledData = recordTerminalInputFallbackHandledData({
              candidate: inputFallbackKeydownCandidate,
              data,
              history: recentInputFallbackHandledDataRef.current,
              maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
              now,
            });
            recentInputFallbackHandledDataRef.current = handledData.usedCandidate
              ? handledData.history
              : recordTerminalInputFallbackRecentData({
                  data,
                  history: handledData.history,
                  maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
                  now,
                });
            if (handledData.usedCandidate) {
              inputFallbackKeydownCandidateRef.current = null;
            }
            markTerminalInputFallbackHandled(pendingInputFallbacksRef.current, data);
            terminalService.write({ id, data });
          }),
        );

        // Some Windows desktop IMEs leave composed text in the textarea, and xterm may process only part of it,
        // so keep this fallback. On Linux Wayland it duplicates writes through xterm's onData path,
        // so explicitly limit it to Windows to avoid breaking the normal path.
        const textarea =
          isWindowsDesktop &&
          (term as unknown as { _core: { textarea: HTMLTextAreaElement } })._core?.textarea;
        if (textarea) {
          const handleInput = (e: InputEvent) => {
            // Handle only insertText for composed text.
            if (e.inputType !== "insertText" || !e.data || !e.composed) return;
            const insertedText = e.data;
            const now = performance.now();
            const pendingFallback = createPendingTerminalInputFallback(insertedText);
            pendingInputFallbacksRef.current.push(pendingFallback);
            // A regular space is written to the PTY by xterm onData from keydown before the browser dispatches composed input.
            // Sogou IME may also trigger xterm onData before composed input without a stable keydown candidate.
            // Consume the unconsumed onData near this input so the same composition text is not written again by the fallback.
            consumeTerminalInputFallbackHandledData({
              history: recentInputFallbackHandledDataRef.current,
              inputEventTimeStamp: e.timeStamp,
              maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
              maxInputDelayMs: TERMINAL_INPUT_FALLBACK_KEYDOWN_INPUT_MS,
              now,
              pending: pendingFallback,
            });

            // Delay the check until xterm's onData has had a chance to claim pending, then decide whether fallback writing is needed.
            setTimeout(() => {
              pendingInputFallbacksRef.current = pendingInputFallbacksRef.current.filter(
                (item) => item !== pendingFallback,
              );
              if (disposed) {
                return;
              }
              const fallbackAction = resolveTerminalInputFallbackAction({
                pending: pendingFallback,
                textareaValue: textarea.value,
              });
              if (fallbackAction.shouldWrite) {
                // A regular space also triggers composed input, after xterm has already written it to the PTY via onData.
                // Looking only at textarea.value would write the space again; use the fallback only after confirming onData did not handle it.
                logger.debug("[Terminal] flush composed input fallback", {
                  length: insertedText.length,
                  terminalId: id,
                  terminalTabId: sessionId,
                });
                terminalService.write({ id, data: insertedText });
              }
              if (fallbackAction.shouldClearTextarea) {
                textarea.value = "";
              }
            }, TERMINAL_INPUT_FALLBACK_FLUSH_DELAY_MS);
          };

          textarea.addEventListener("input", handleInput, true);
          disposables.push({
            dispose: () => textarea.removeEventListener("input", handleInput, true),
          } as IDisposable);
        }
      })
      .catch((error) => {
        // Previously, create() rejection was unhandled and terminal startup failure became an Uncaught Promise.
        // Log the error explicitly and show a terminal-area message so users can determine whether the shell or cwd caused the problem.
        if (disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[Terminal] failed to create terminal:", error);
        term.write(`\r\n[Terminal failed to start]\r\n${message}\r\n`);
      });

    let resizeRAF = 0;
    const resizeObserver = new ResizeObserver(() => {
      if (!isVisibleRef.current) return;
      if (resizeRAF) cancelAnimationFrame(resizeRAF);
      resizeRAF = requestAnimationFrame(() => scheduleFitAndResize("observer"));
    });
    resizeObserver.observe(el);

    return () => {
      disposed = true;
      observer.disconnect();
      resizeObserver.disconnect();
      clearResizeThrottleTimer();
      if (resizeRAF) cancelAnimationFrame(resizeRAF);
      if (resizeRAFRef.current) cancelAnimationFrame(resizeRAFRef.current);
      if (focusRAFRef.current) cancelAnimationFrame(focusRAFRef.current);
      pendingInputFallbacksRef.current = [];
      inputFallbackKeydownCandidateRef.current = null;
      recentInputFallbackHandledDataRef.current = [];
      pendingTerminalSizeRef.current = null;
      lastSentTerminalSizeRef.current = null;
      resizeInFlightRef.current = false;
      for (const d of disposables) d.dispose();
      if (terminalIdRef.current) {
        terminalService.dispose({ id: terminalIdRef.current });
      }
      terminalIdRef.current = undefined;
      fitAddonRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, [
    clearResizeThrottleTimer,
    cwd,
    isWindowsDesktop,
    onShellLabelChange,
    requestFocus,
    scheduleFitAndResize,
    flushTerminalServiceResize,
    services,
    sessionId,
    persistentKey,
  ]);

  // Toggle changes must apply to existing xterm instances (including registry-reused instances); declare this after the creation effect so termRef is ready.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    setTerminalWebglRenderer(term, terminalWebglEnabled);
  }, [terminalWebglEnabled]);

  const handleCopy = () => {
    const term = termRef.current;
    if (!term?.hasSelection()) return;
    void navigator.clipboard.writeText(term.getSelection()).catch((err) => {
      logger.warn("[Terminal] copy via context menu failed:", err);
    });
  };

  const handlePaste = () => {
    const term = termRef.current;
    if (!term) return;
    navigator.clipboard
      .readText()
      .then((text) => text && term.paste(text))
      .catch((err) => logger.warn("[Terminal] paste via context menu failed:", err));
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={containerRef}
          className="terminal-xterm-shell h-full min-h-0 w-full overflow-hidden"
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={handleCopy}>
          <Copy className="mr-2 h-4 w-4" />
          {intl.formatMessage({ id: "terminal.contextMenu.copy" })}
        </ContextMenuItem>
        <ContextMenuItem onSelect={handlePaste}>
          <ClipboardPaste className="mr-2 h-4 w-4" />
          {intl.formatMessage({ id: "terminal.contextMenu.paste" })}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
