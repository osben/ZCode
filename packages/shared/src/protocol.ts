import type { RemoteAssetInstallMode } from "./remoteAssetInstallMode.js";
import type { RemoteResourcePackageSelection } from "./remoteResourcePackages.js";
import type { ProviderFamilyDomain } from "./model-provider-family.js";
import type { ProviderFamilyConnectionSelectionSettings } from "./provider-family-connection-selection.js";
import type { ZCodeProvider } from "./zcode-task-types-core.js";
import type { WorkspacePurpose } from "./workspacePurpose.js";
import type { EmbeddedBrowserViewportPreference } from "./browser-use/command-metadata.js";

// ── Domain types ──

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  /** Older remote servers may omit this; callers should treat it as false. */
  isSymbolicLink?: boolean;
}

export interface FileStat {
  path: string;
  type: "file" | "directory";
  /** File size in bytes; older remote servers may omit this, so callers should handle undefined. */
  size?: number;
  /** File modification time; chunked sharing reads use it to detect concurrent changes during a read. */
  mtimeMs?: number;
}

/** Filesystem change event (directory-level granularity). */
export interface FileWatchEvent {
  /** Path of the changed directory. */
  dirPath: string;
  /**
   * Return full paths that changed when the underlying watcher can determine them.
   * Omitted for older Hosts, platforms that do not return filenames, or debounce windows containing multiple paths; callers should refresh conservatively.
   */
  changedPath?: string;
}

export interface FileTextSlice {
  path: string;
  content: string;
  offset: number;
  bytesRead: number;
  totalBytes: number;
  truncated: boolean;
  isBinary: boolean;
}

export interface FileMediaPreview {
  path: string;
  mediaType: string;
  dataBase64: string;
  totalBytes: number;
}

export interface FileBinaryPreview {
  path: string;
  dataBase64: string;
  totalBytes: number;
}

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  relativePath: string;
  type: "file" | "directory";
}

export interface SystemInfo {
  homedir: string;
  platform: string;
}

/** Supported languages. */
export type Locale = "zh-CN" | "en-US" | "uk-UA";

/** UI language preference; system follows the current runtime's system language. */
export type LocalePreference = "system" | Locale;

/** Interaction behavior when sending more input while ZCode is running. */
export type ZCodeInteractionBehavior = "queue" | "guide";

/** Desktop Electron auto-update release channel. */
export type ElectronReleaseChannel = "stable" | "preview";

/** Integrated terminal shell dialect available to the Windows Bash tool. */
export type IntegratedTerminalShellDialect = "cmd" | "git-bash";

/** User-selected Windows Bash shell on the Settings page. */
export type IntegratedTerminalShellSelection =
  | { mode: "auto" }
  | {
      mode: "shell";
      dialect: IntegratedTerminalShellDialect;
      id: string;
      label: string;
      path: string;
    };

/** Windows shell options recognized by the current host. */
export interface IntegratedTerminalShellOption {
  dialect: IntegratedTerminalShellDialect;
  id: string;
  label: string;
  path: string;
  source: "system" | "path";
}

/** Default language. */
export const DEFAULT_LOCALE: Locale = "zh-CN";

// ── Workspace / Tab ──

/** Unique tab ID. */
export type TabId = string;

/** State of a single tab. */
export interface TabState {
  id: TabId;
  /** Absolute workspace path. */
  workspacePath: string;
  /** Display name, usually the final path segment. */
  label: string;
}

export interface SSHRemoteTargetSnapshot {
  kind: "ssh";
  host: string;
  port?: number;
  username: string;
  /** SSH config Host alias selected by the user when connecting; used only for UI display. */
  sshConfigAlias?: string;
  privateKeyPath?: string;
  assetInstallMode?: RemoteAssetInstallMode;
  resourcePackages?: RemoteResourcePackageSelection;
  /**
   * SSH passwords are not written to setting.json.
   * Store only the credentialService key here, then read the actual password from secure storage during restoration.
   */
  passwordCredentialKey?: string;
  /**
   * Private-key passphrases are not written to setting.json.
   * Store only the credentialService key here, then read the actual passphrase from secure storage during restoration.
   */
  privateKeyPassphraseCredentialKey?: string;
}

export interface WSLRemoteTargetSnapshot {
  kind: "wsl";
  distro?: string;
  user?: string;
}

export interface DockerRemoteTargetSnapshot {
  kind: "docker";
  container: string;
}

export type RemoteTargetSnapshot =
  | SSHRemoteTargetSnapshot
  | WSLRemoteTargetSnapshot
  | DockerRemoteTargetSnapshot;

export interface RemoteWorkspaceSessionSnapshot {
  /** Actual absolute path of the remote workspace. */
  workspacePath: string;
  /** Local workspace path at the time of remote connection; used only to rewrite MCP filesystem paths. */
  localWorkspacePath?: string;
  /** Stable identity key for the remote workspace (authority + canonicalPath). */
  workspaceIdentity?: string;
  /** Restorable snapshot of the remote connection target. */
  target: RemoteTargetSnapshot;
  /** Timestamp when this workspace was last opened successfully. */
  lastOpenedAt: number;
  /** Most recent recovery/reconnection result. */
  lastConnectionStatus: "connected" | "failed";
  /** Most recent failure reason; cleared on success. */
  lastConnectionError?: string;
}

export interface LocalWorkspaceSessionEntry {
  kind: "local";
  workspacePath: string;
  /** Project display category; defaults to project for old data. Conversations still use the actual workspacePath as cwd/key. */
  workspacePurpose?: WorkspacePurpose;
}

export interface RemoteWorkspaceSessionEntry extends RemoteWorkspaceSessionSnapshot {
  kind: "remote";
}

export type PersistedWorkspaceSessionEntry =
  | LocalWorkspaceSessionEntry
  | RemoteWorkspaceSessionEntry;

// ── Process Monitor ──

/** Resource-manager category: core service / built-in plugin / community plugin. */
export type ResourceUsageCategory = "base" | "builtin-plugin" | "community-plugin";

/** Group key for core services; plugin group key is the plugin name or MCP server name. */
export type ResourceUsageBaseGroupKey = "main" | "gpu" | "renderer" | "host" | "cli" | "utility";

/** A process row in the resource manager (CPU is normalized as a percentage of the whole machine; memory is in bytes). */
export interface ResourceUsageProcess {
  pid: number;
  /** Process display name, such as zcode-main / zcode-agent-zcode-demo / node_repl. */
  name: string;
  category: ResourceUsageCategory;
  groupKey: string;
  groupLabel: string;
  cpuPercent: number;
  memoryBytes: number;
  /** false means only the process topology is known; metrics have not been sampled yet (display as —). */
  sampled: boolean;
}

/** External process row sampled by Host (Agent / MCP / terminal, etc.); merged into the snapshot by main. */
export type HostResourceUsageProcess = Omit<ResourceUsageProcess, "sampled">;

/** Complete resource-manager snapshot, returned after the main process combines Electron metrics, system totals, and Host samples. */
export interface ResourceUsageSnapshot {
  sampledAt: number;
  logicalCpuCount: number;
  system: {
    cpuPercent: number;
    memoryTotalBytes: number;
    memoryUsedBytes: number;
  };
  app: {
    cpuPercent: number;
    memoryBytes: number;
  };
  processes: ResourceUsageProcess[];
}

export interface AppSettings {
  /** The current App/Host no longer shows pre-submission trial-plan recommendations; this does not change model selection at any entry point. */
  startPlanRecommendationDismissed?: boolean;
  recentProjects: string[]; // Recent projects; retain at most 10.
  locale: Locale; // UI language.
  /**
   * User-overridden shortcut bindings (command ID → array of binding strings; see shortcutCommands.ts for the format).
   * Store only user overrides: commands without overrides are not persisted and are merged with SHORTCUT_COMMANDS defaults when read;
   * an override replaces the entire group (for example, overriding openCommandCenter disables both default bindings).
   */
  shortcutBindings?: Record<string, string[]>;
  /** UI language preference; locale stores the resolved language for non-browser contexts such as main/menu/remote control. */
  localePreference?: LocalePreference;
  /** Whether to inherit the system terminal profile, shell environment, and font where possible. */
  terminalInheritSystemProfile?: boolean;
  /** User-overridden terminal font; automatically detected from system terminal config when empty. */
  terminalFontFamily?: string;
  /** Local shell used by the Bash tool on Windows; selected automatically when unset. */
  integratedTerminalShell?: IntegratedTerminalShellSelection;
  /** HTTP/HTTPS outbound proxy, for example http://127.0.0.1:7890; connect directly when empty. Applies on the next app/agent startup. */
  httpProxy?: string;
  /** Proxy bypass rules, for example localhost,127.0.0.1,.example.com; affects the renderer only when httpProxy is set, while agent/tools use explicit environment settings. */
  httpProxyNoProxy?: string;
  /** Custom PEM root certificate path; used for renderer validation and agent NODE_EXTRA_CA_CERTS on the next app/agent startup. */
  httpProxyCaCertPath?: string;
  /**
   * Ignore HTTPS certificate validation errors (self-signed, expired, hostname mismatch, etc.) in the built-in browser for internal test sites.
   * Affects only built-in browser traffic, not ZCode's own backend or model API requests. Disabled by default; applies after restart.
   */
  embeddedBrowserAllowInsecureCertificates?: boolean;
  /** One-time display preference when a human user opens a Browser tab; Agent Browser Use does not read or write it. */
  embeddedBrowserViewportPreference?: EmbeddedBrowserViewportPreference;
  /**
   * The user has hidden the "Computer Use" button in the input box from Settings (internal hidden state).
   * Store hidden rather than visible: undefined means shown by default, so existing users need no data migration.
   * Once hidden, the button is not rendered and is not restored by restart or upgrade; it can only be re-enabled in Settings.
   */
  computerUseComposerEntryHidden?: boolean;
  /** Master switch for automatically archiving old completed tasks. */
  taskAutoArchiveEnabled?: boolean;
  /** Auto-archive threshold; a task may be archived when its last update is older than this many days. */
  taskAutoArchiveOlderThanDays?: number;
  /** On Windows desktop, hide the window to the tray when closed; ignored on other platforms. */
  closeToTrayOnWindows?: boolean;
  /** Prevent system idle sleep while an off-peak task is running (manual toggle; does not prevent sleep when the lid is closed). */
  keepAwakeWhileRunning?: boolean;
  /** Whether the one-time migration for the Windows close-to-tray default has run; used only for Settings migration, not business logic. */
  closeToTrayOnWindowsMigrationInitialized?: boolean;
  /** Global desktop page zoom level; restores UI zoom after restart, ignored on Web/mobile. */
  desktopZoomLevel?: number;
  /** Desktop main window's last non-maximized width/height and maximized state; ignored on Web/mobile. */
  desktopWindowSize?: {
    width: number;
    height: number;
    maximized: boolean;
  };
  /** Desktop Chromium hardware-acceleration toggle; applies early in the next main-process startup, ignored on Web/mobile. */
  desktopChromiumHardwareAccelerationEnabled?: boolean;
  /** Whether to show model reasoning in the message stream. */
  messageStreamShowReasoning?: boolean;
  // TODO(settings-schema-version): Once all supported upgrade paths are proven to run this migration, use a unified settings schema version and remove this marker, the migration function, and the persistence check together.
  /** Whether the one-time migration for the default model-reasoning display setting has run; used only for Settings migration, not message rendering. */
  messageStreamShowReasoningMigrationInitialized?: boolean;
  /** Whether to render todo tools in the message stream; does not affect todos in the summary panel. */
  messageStreamShowTodos?: boolean;
  /** Whether to group consecutive read-only tool calls into Explore. */
  toolGroupingExploreEnabled?: boolean;
  /** Whether to group consecutive non-read-only Shell tool calls into Terminal. */
  toolGroupingTerminalEnabled?: boolean;
  /** Whether to group consecutive Write/Edit/ApplyPatch tool calls into Changes. */
  toolGroupingChangesEnabled?: boolean;
  /** When adding input while ZCode is running, whether to queue it for the next turn or run it after the next tool call. */
  zcodeInteractionBehavior?: ZCodeInteractionBehavior;
  /** Whether to continue automatically when an Agent question receives no answer for five minutes; defaults to enabled for compatibility with older config. */
  askUserQuestionAutoResolutionEnabled?: boolean;
  /** Whether to preserve Model I/O in full; when enabled, do not rotate, reset limits, compress, or truncate, while still redacting authentication data. */
  modelIoFullRetentionEnabled?: boolean;
  /** Current unique structured connection selection for each Provider Family in Settings. */
  providerFamilyConnectionSelections?: ProviderFamilyConnectionSelectionSettings;
  /** ZAI / BigModel provider-family runtime domain confirmed after the user connects successfully through WelcomeScreen. */
  providerFamilyDomain?: ProviderFamilyDomain;
  /** Time when providerFamilyDomain was last set or cleared. */
  providerFamilyDomainUpdatedAt?: number;
  /** Whether migration from old oauth/provider state to providerFamilyDomain has been attempted. */
  providerFamilyDomainMigrated?: boolean;
  /** Whether to inject bfs/ugrep enhancements for Bash in newly created or cold-restored Sessions; enabled by default. */
  nativeSearchEnhancementsEnabled?: boolean;
  /** Whether Memory is enabled in newly created or cold-restored Sessions; disabled by default. */
  memoryEnabled?: boolean;
  onboardingOccupation?:
    | "office"
    | "developer"
    | "independent"
    | "infrastructure"
    | "product"
    | "design"
    | "student"
    | "creator"
    | "operations"
    | "marketing"
    | "finance"
    | "accounting"
    | "legal"
    | "other"
    | null;
  proactiveSuggestionsEnabled?: boolean;
  /** Full workspace session at the last shutdown (including local and remote workspaces). */
  lastWorkspaceSession?: PersistedWorkspaceSessionEntry[];
  /** Tab index that was active at the last shutdown. */
  lastActiveTabIndex?: number;
  /** Last active taskId for each workspace; restored automatically on next open. */
  lastActiveTaskByWorkspace?: Record<string, string>;
  /** Root path for the data directory (replaces homedir), defaults to os.homedir(); the .zcode/v2 suffix remains unchanged. */
  dataBaseDir?: string;
  /** Release notes to show on the first launch after an auto-update installation completes. */
  pendingPostUpdateReleaseNotes?: {
    version: string;
    title: string;
    markdown: string;
    releaseDate?: string;
    releaseNotesByLocale?: Partial<Record<Locale, { title: string; markdown: string }>>;
  };
  /** Settings preference for "receive preview auto-updates"; read only by desktop auto-update. */
  receivePreviewUpdates?: boolean;
  /** Settings/update-dialog preference for "automatically download and install updates"; read only by desktop auto-update. */
  autoDownloadAndInstallUpdates?: boolean;
  /** Electron auto-update version skipped by the user; isolated by channel so stable / preview do not mask each other. */
  skippedElectronUpdateVersions?: Partial<Record<ElectronReleaseChannel, string>>;
  /** Whether the first-launch settings-sync prompt has been dismissed; means only that the prompt will not reappear, not that import succeeded. */
  settingsSyncFirstRunPromptHandled?: boolean;
  /** Temporary endpoint override from Settings; production/test default base URL is managed by the ZCODE_BASE_URL env variable. */
  zcodeEndpointOrigin?: string;
}
