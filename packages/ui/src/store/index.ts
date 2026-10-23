/** Zustand Store — global state management. State that must sync across windows is broadcast through BroadcastService. The `state:` channel prefix identifies state-synchronization messages. */
import { create } from "zustand";
import type { IBroadcastService } from "@zcode/services";
import type { OAuthProviderId, UserInfo } from "@zcode/shared";
import type { CodingPlanResetType } from "@zcode/shared";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type {
  CodingPlanQuotaResetUiEntries,
  CodingPlanQuotaResetUiEntry,
} from "@/lib/codingPlanQuotaResetUi.js";
import {
  createCodingPlanQuotaResetStoreActions,
  type CodingPlanQuotaResetAutomaticObservations,
  type CodingPlanQuotaResetAutoPlayReservation,
  type CodingPlanQuotaResetAutoPlayReservationAttempt,
  type CodingPlanQuotaResetAutoPlayedSlot,
} from "@/store/codingPlanQuotaResetState.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { readSafeLocalStorage, writeSafeLocalStorage } from "@/lib/browserEnvironment.js";
import {
  applyUiFontSizePx,
  loadUiFontSizePx,
  normalizeUiFontSizePx,
  UI_FONT_SIZE_STORAGE_KEY,
} from "@/lib/uiFontSize.js";
import { createFontPreferencesSlice, type FontPreferencesState } from "@/store/fontPreferences.js";
import { wireStateBroadcast } from "@/store/stateBroadcast.js";
import {
  isTaskNotificationEnabled,
  isTaskNotificationSoundPreferenceEnabled,
  persistTaskNotificationEnabled,
  persistTaskNotificationSoundEnabled,
} from "@/lib/taskNotificationPreferences.js";
import type { Theme, ThemePalette } from "../useTheme.js";
import {
  THEME_PALETTE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  applyTheme,
  readStoredThemeSelection,
} from "../useTheme.js";
import { createSystemThemeSync } from "./systemThemeSync.js";

import {
  INTERFACE_MODE_STORAGE_KEY,
  normalizeInterfaceMode,
  type InterfaceMode,
} from "@/lib/interfaceMode.js";
import { logger } from "@/logger.js";

export type LoginEntryPurpose = "app-login";

// v4 refactor: types and defaults moved to @/lib/codePreviewSettings.ts,
// so pure display components do not depend on the store; keep re-exports here for existing import paths.
export type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
export { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";

export type LoginEntryAttemptStatus =
  | "requested"
  | "waiting"
  | "succeeded"
  | "cancelled"
  | "failed";

export interface LoginEntryAttempt {
  id: number;
  providerId?: OAuthProviderId;
  purpose?: LoginEntryPurpose;
  status: LoginEntryAttemptStatus;
}

const CODE_PREVIEW_SETTINGS_KEY = "zcode-code-preview-settings";
const PERFORMANCE_MODE_STORAGE_KEY = "zcode-performance-mode";
const TERMINAL_WEBGL_STORAGE_KEY = "zcode-terminal-webgl";
export const FILE_MANAGER_NAVIGATION_PREFERENCES_STORAGE_KEY =
  "zcode-file-manager-navigation-preferences";

function loadFileManagerNavigationPreferences(): Record<string, boolean> {
  try {
    const raw = readSafeLocalStorage(FILE_MANAGER_NAVIGATION_PREFERENCES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, boolean] =>
          entry[0].trim().length > 0 && typeof entry[1] === "boolean",
      ),
    );
  } catch {
    return {};
  }
}

function loadCodePreviewSettings(): CodePreviewSettings {
  try {
    const raw = readSafeLocalStorage(CODE_PREVIEW_SETTINGS_KEY);
    if (!raw) {
      return DEFAULT_CODE_PREVIEW_SETTINGS;
    }

    const parsed = JSON.parse(raw) as Partial<CodePreviewSettings>;
    return {
      ...DEFAULT_CODE_PREVIEW_SETTINGS,
      ...parsed,
      fontSizePx:
        typeof parsed.fontSizePx === "number"
          ? Math.min(20, Math.max(12, Math.round(parsed.fontSizePx)))
          : DEFAULT_CODE_PREVIEW_SETTINGS.fontSizePx,
    };
  } catch {
    return DEFAULT_CODE_PREVIEW_SETTINGS;
  }
}

function loadPerformanceMode(): boolean {
  return readSafeLocalStorage(PERFORMANCE_MODE_STORAGE_KEY) === "true";
}

/** Terminal WebGL rendering is disabled by default; this is a local preference and is not synchronized with the server. */
function loadTerminalWebglEnabled(): boolean {
  return readSafeLocalStorage(TERMINAL_WEBGL_STORAGE_KEY) === "true";
}

// ============================================================================
// State definition
// ============================================================================

export interface ZCodeState extends FontPreferencesState {
  /** Display-detail preference; does not change Agent permissions or execution capabilities. */
  interfaceMode: InterfaceMode;
  setInterfaceMode: (mode: InterfaceMode) => void;

  /** Current light/dark mode. */
  theme: Theme;
  setTheme: (theme: Theme) => void;

  /** Current color scheme, independent of light/dark mode. */
  palette: ThemePalette;
  setPalette: (palette: ThemePalette) => void;

  /** Current language. */
  locale: string;
  setLocale: (locale: string) => void;

  /** Code-preview settings. */
  codePreviewSettings: CodePreviewSettings;
  setCodePreviewSettings: (patch: Partial<CodePreviewSettings>) => void;

  /** File-navigation visibility preference per workspace; expanded by default when absent. */
  fileManagerNavigationOpenByWorkspace: Record<string, boolean>;
  setFileManagerNavigationOpen: (workspaceKey: string, open: boolean) => void;

  /** Root UI font size in rem (px). */
  uiFontSizePx: number;
  setUiFontSizePx: (fontSizePx: number) => void;

  /** Whether performance mode is enabled. */
  performanceMode: boolean;
  setPerformanceMode: (enabled: boolean) => void;

  /** Whether the terminal uses WebGL rendering (falls back to DOM automatically after failure or context loss). */
  terminalWebglEnabled: boolean;
  setTerminalWebglEnabled: (enabled: boolean) => void;

  /** Whether task notifications are enabled (desktop notifications; sound is controlled by a sub-toggle). */
  notificationEnabled: boolean;
  setNotificationEnabled: (enabled: boolean) => void;

  /** Whether task notification sounds are enabled (requires the task-notification master toggle). */
  notificationSoundEnabled: boolean;
  setNotificationSoundEnabled: (enabled: boolean) => void;

  /** Current user information. */
  user: UserInfo | null;
  /** Incremented when the user moves from signed out to signed in; connecting an additional provider does not count as a new login. */
  authSessionSeq: number;
  setUser: (user: UserInfo | null) => void;

  /** Whether OAuth login restoration is still in progress during startup. */
  isRestoringOAuthSession: boolean;
  setIsRestoringOAuthSession: (restoring: boolean) => void;

  /** OAuth callback error (written by the Root layer and read by the shared sign-in entry point). */
  oauthError: string | null;
  setOAuthError: (error: string | null) => void;
  oauthPollingActive: boolean;
  setOAuthPollingActive: (active: boolean) => void;
  oauthSuccessSeq: number;
  lastOAuthSuccessProvider: OAuthProviderId | null;
  markOAuthSuccess: (provider?: OAuthProviderId) => void;
  apiKeyLoginSuccessSeq: number;
  lastApiKeyLoginModel: string | null;
  markApiKeyLoginSuccess: (preferredModel?: string | null) => void;
  /** Request to open the shared sign-in entry point, optionally starting sign-in/connection for a provider automatically. */
  loginEntryRequest: {
    id: number;
    providerId?: OAuthProviderId;
    purpose?: LoginEntryPurpose;
  } | null;
  /** Current shared sign-in attempt; follow-up actions such as purchase can continue only the OAuth flow they started, by ID. */
  loginEntryAttempt: LoginEntryAttempt | null;
  requestLoginEntry: (providerId?: OAuthProviderId, purpose?: LoginEntryPurpose) => number;
  clearLoginEntryRequest: (requestId?: number) => void;
  markLoginEntryAttemptStatus: (
    requestId: number,
    status: Exclude<LoginEntryAttemptStatus, "requested">,
  ) => void;

  /** Coding Plan quota-reset UI state; entries/observations are shared only within this window and are not persisted. */
  codingPlanQuotaResetUiBySource: Record<string, CodingPlanQuotaResetUiEntries>;
  /** Auth session that first observed an automatic/operational completion, used to distinguish later mounts in the same session from a new login. */
  codingPlanQuotaResetAutomaticObservationsBySource: Record<
    string,
    CodingPlanQuotaResetAutomaticObservations
  >;
  /** Used-at records for automatic completion messages already played once across windows; in-memory per window and mergeable through broadcasts. */
  codingPlanQuotaResetAutoPlayedBySource: Record<string, CodingPlanQuotaResetAutoPlayedSlot>;
  /** Record server status writes / reconciled manual uses; a null entry clears that type. */
  setCodingPlanQuotaResetUiEntry: (
    sourceKey: string,
    resetType: CodingPlanResetType,
    entry: CodingPlanQuotaResetUiEntry | null,
    authSessionSeq: number,
  ) => void;
  /** Request a temporary reservation before the Composer shows; this phase does not write to played. */
  reserveCodingPlanQuotaResetAutoPlay: (
    sourceKey: string,
    resetType: CodingPlanResetType,
    completedAt: number,
  ) => Promise<CodingPlanQuotaResetAutoPlayReservationAttempt>;
  /** Commit the reservation, played record, and broadcast while the component is still valid and about to display. */
  commitCodingPlanQuotaResetAutoPlay: (
    reservation: CodingPlanQuotaResetAutoPlayReservation,
  ) => boolean;
  /** Release a reservation that has not been committed if the component becomes invalid. */
  releaseCodingPlanQuotaResetAutoPlay: (
    reservation: CodingPlanQuotaResetAutoPlayReservation,
  ) => Promise<void>;

  /** Request to open the onboarding dialog manually. */
  newUserOnboardingOpen: boolean;
  setNewUserOnboardingOpen: (open: boolean) => void;
  onboardingDialogRequested: boolean | "migration";
  requestOnboardingDialog: (entry?: "migration") => void;
  clearOnboardingDialogRequest: () => void;
}

// ============================================================================
// Store factory
// ============================================================================

/** Create a Zustand store connected to the broadcast service for cross-window state synchronization. @param broadcastService — broadcast service; Desktop uses RPC and Web may pass a no-op implementation. */
export function createZCodeStore(
  broadcastService: IBroadcastService,
  options: {
    initialIsRestoringOAuthSession?: boolean;
  } = {},
) {
  let loginEntryRequestSeq = 0;
  const syncSystemThemeListener = createSystemThemeSync(() => ({
    mode: useStore.getState().theme,
    palette: useStore.getState().palette,
  }));
  const initialThemeSelection = readStoredThemeSelection();

  const useStore = create<ZCodeState>()((set, get) => ({
    interfaceMode: normalizeInterfaceMode(readSafeLocalStorage(INTERFACE_MODE_STORAGE_KEY)),
    setInterfaceMode: (mode) => {
      const interfaceMode = normalizeInterfaceMode(mode);
      if (get().interfaceMode !== interfaceMode) {
        logger.debug("[InterfaceMode] 切换界面模式", { interfaceMode });
      }
      writeSafeLocalStorage(INTERFACE_MODE_STORAGE_KEY, interfaceMode);
      set({ interfaceMode });
    },
    // Older zcode-theme values may be stored as combinations such as zai-dark. migrateThemeSelection splits them into light/dark mode + zai color scheme,
    // preserving the old appearance. When nothing is saved, default to dark mode + zai color scheme.
    theme: initialThemeSelection.mode,
    setTheme: (theme: Theme) => {
      writeSafeLocalStorage(THEME_STORAGE_KEY, theme);
      syncSystemThemeListener(theme);
      applyTheme(theme, get().palette);

      set({ theme });
    },
    palette: initialThemeSelection.palette,
    setPalette: (palette: ThemePalette) => {
      writeSafeLocalStorage(THEME_PALETTE_STORAGE_KEY, palette);
      applyTheme(get().theme, palette);

      set({ palette });
    },

    locale: readSafeLocalStorage("zcode-locale") || "zh-CN",
    setLocale: (locale: string) => {
      writeSafeLocalStorage("zcode-locale", locale);
      set({ locale });
    },

    codePreviewSettings: loadCodePreviewSettings(),
    setCodePreviewSettings: (patch: Partial<CodePreviewSettings>) =>
      set((state) => {
        const next = {
          ...state.codePreviewSettings,
          ...patch,
          fontSizePx:
            typeof patch.fontSizePx === "number"
              ? Math.min(20, Math.max(12, Math.round(patch.fontSizePx)))
              : state.codePreviewSettings.fontSizePx,
        };
        writeSafeLocalStorage(CODE_PREVIEW_SETTINGS_KEY, JSON.stringify(next));
        return { codePreviewSettings: next };
      }),

    fileManagerNavigationOpenByWorkspace: loadFileManagerNavigationPreferences(),
    setFileManagerNavigationOpen: (workspaceKey, open) => {
      const normalizedWorkspaceKey = workspaceKey.trim();
      if (!normalizedWorkspaceKey) return;
      set((state) => {
        const next = {
          ...state.fileManagerNavigationOpenByWorkspace,
          [normalizedWorkspaceKey]: open,
        };
        writeSafeLocalStorage(
          FILE_MANAGER_NAVIGATION_PREFERENCES_STORAGE_KEY,
          JSON.stringify(next),
        );
        return { fileManagerNavigationOpenByWorkspace: next };
      });
    },

    uiFontSizePx: loadUiFontSizePx(),
    setUiFontSizePx: (fontSizePx: number) => {
      const normalizedFontSizePx = normalizeUiFontSizePx(fontSizePx);
      writeSafeLocalStorage(UI_FONT_SIZE_STORAGE_KEY, String(normalizedFontSizePx));
      applyUiFontSizePx(normalizedFontSizePx);
      set({ uiFontSizePx: normalizedFontSizePx });
    },

    ...createFontPreferencesSlice((partial) => set(partial)),

    performanceMode: loadPerformanceMode(),
    setPerformanceMode: (enabled: boolean) => {
      writeSafeLocalStorage(PERFORMANCE_MODE_STORAGE_KEY, enabled ? "true" : "false");
      set({ performanceMode: enabled });
    },

    terminalWebglEnabled: loadTerminalWebglEnabled(),
    setTerminalWebglEnabled: (enabled: boolean) => {
      writeSafeLocalStorage(TERMINAL_WEBGL_STORAGE_KEY, enabled ? "true" : "false");
      set({ terminalWebglEnabled: enabled });
    },

    notificationEnabled: isTaskNotificationEnabled(),
    setNotificationEnabled: (enabled: boolean) => {
      persistTaskNotificationEnabled(enabled);
      set({ notificationEnabled: enabled });
    },

    notificationSoundEnabled: isTaskNotificationSoundPreferenceEnabled(),
    setNotificationSoundEnabled: (enabled: boolean) => {
      persistTaskNotificationSoundEnabled(enabled);
      set({ notificationSoundEnabled: enabled });
    },

    user: null,
    authSessionSeq: 0,
    setUser: (user: UserInfo | null) =>
      set((state) => ({
        user,
        authSessionSeq:
          state.user === null && user !== null ? state.authSessionSeq + 1 : state.authSessionSeq,
      })),

    isRestoringOAuthSession: options.initialIsRestoringOAuthSession ?? false,
    setIsRestoringOAuthSession: (restoring: boolean) => set({ isRestoringOAuthSession: restoring }),

    oauthError: null,
    setOAuthError: (error: string | null) => set({ oauthError: error }),
    oauthPollingActive: false,
    setOAuthPollingActive: (active: boolean) => set({ oauthPollingActive: active }),
    oauthSuccessSeq: 0,
    lastOAuthSuccessProvider: null,
    markOAuthSuccess: (provider?: OAuthProviderId) =>
      set((state) => ({
        oauthSuccessSeq: state.oauthSuccessSeq + 1,
        lastOAuthSuccessProvider: provider ?? state.lastOAuthSuccessProvider,
      })),
    apiKeyLoginSuccessSeq: 0,
    lastApiKeyLoginModel: null,
    markApiKeyLoginSuccess: (preferredModel?: string | null) =>
      set((state) => ({
        apiKeyLoginSuccessSeq: state.apiKeyLoginSuccessSeq + 1,
        lastApiKeyLoginModel: preferredModel?.trim() || null,
      })),
    loginEntryRequest: null,
    loginEntryAttempt: null,
    requestLoginEntry: (providerId?: OAuthProviderId, purpose?: LoginEntryPurpose) => {
      const id = ++loginEntryRequestSeq;
      const attempt: LoginEntryAttempt = {
        id,
        providerId,
        purpose,
        status: "requested",
      };
      set({
        loginEntryRequest: {
          id,
          providerId,
          purpose,
        },
        loginEntryAttempt: attempt,
      });
      return id;
    },
    clearLoginEntryRequest: (requestId?: number) =>
      set((state) => {
        if (requestId !== undefined && state.loginEntryRequest?.id !== requestId) {
          return {};
        }
        return { loginEntryRequest: null };
      }),
    markLoginEntryAttemptStatus: (requestId, status) =>
      set((state) => {
        if (state.loginEntryAttempt?.id !== requestId) {
          return {};
        }
        return {
          loginEntryAttempt: {
            ...state.loginEntryAttempt,
            status,
          },
        };
      }),

    codingPlanQuotaResetUiBySource: {},
    codingPlanQuotaResetAutomaticObservationsBySource: {},
    codingPlanQuotaResetAutoPlayedBySource: {},
    ...createCodingPlanQuotaResetStoreActions({
      broadcastService,
      readState: get,
      writeState: (updater) => set((state) => updater(state)),
    }),

    newUserOnboardingOpen: false,
    setNewUserOnboardingOpen: (open) => set({ newUserOnboardingOpen: open }),
    onboardingDialogRequested: false,
    requestOnboardingDialog: (entry) => set({ onboardingDialogRequested: entry ?? true }),
    clearOnboardingDialogRequest: () => set({ onboardingDialogRequested: false }),
  }));

  // Zustand v5 setState uses different overloads for replace=true/false, so the broadcast wiring
  // lives in stateBroadcast.ts and only observes committed state changes.
  wireStateBroadcast(useStore, broadcastService, syncSystemThemeListener);

  return useStore;
}

export type ZCodeStore = ReturnType<typeof createZCodeStore>;
