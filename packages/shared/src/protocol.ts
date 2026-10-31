import type { RemoteAssetInstallMode } from "./remoteAssetInstallMode.js";
import type { RemoteResourcePackageSelection } from "./remoteResourcePackages.js";
import type { ProviderFamilyDomain } from "./model-provider-family.js";
import type { ProviderFamilyConnectionSelectionSettings } from "./provider-family-connection-selection.js";
import type { ZCodeProvider } from "./zcode-task-types-core.js";
import type { WorkspacePurpose } from "./workspacePurpose.js";
import type { DynamicWorkflowMode } from "./dynamic-workflow-feature.js";
import type { EmbeddedBrowserViewportPreference } from "./browser-use/command-metadata.js";
import type { IncognitoDefaults } from "./incognito-profile.js";
import type { AppToolSearchMode } from "./app-runtime-preferences.js";

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

export interface ServerRemoteTargetSnapshot {
  kind: "server";
  url: string;
  name?: string;
  workspacePath?: string;
  serverId?: string;
  /**
   * Server tokens are not written to setting.json.
   * Store only the credentialService key here, then read the actual token from secure storage during restoration.
   */
  tokenCredentialKey?: string;
}

export type RemoteTargetSnapshot =
  | SSHRemoteTargetSnapshot
  | WSLRemoteTargetSnapshot
  | DockerRemoteTargetSnapshot
  | ServerRemoteTargetSnapshot;

export interface RemoteWorkspaceSessionSnapshot {
  /** Actual absolute path of the remote workspace. */
  workspacePath: string;
  /** User-visible workspace purpose; older remote snapshots missing it are read as project for compatibility. */
  workspacePurpose?: WorkspacePurpose;
  /** Local workspace path when the remote connection was initiated; used only for MCP filesystem path rewriting. */
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
  /** Error code of the most recent failure, written and cleared together with lastConnectionError; wait points also report as failed, and the text alone cannot tell the two apart. */
  lastConnectionErrorCode?: string;
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

export interface VoiceDictationSettings {
  /** Selected voice model id (see the model catalog in services/voice-dictation); null/absent means nothing selected. */
  modelId?: string | null;
  /** Microphone deviceId; null/absent uses the system default input. */
  microphoneDeviceId?: string | null;
  /** Transcription language: `auto` means the model detects it, otherwise a language code (e.g. `en`, `ru`). */
  language?: string;
  /**
   * Selected dictation languages (ISO 639-1); empty/absent means automatic detection. Wins over `language`
   * when present; exactly one entry is forced on the engine, several leave detection to the model.
   */
  languages?: string[];
  /** true: hold the shortcut to record, release to transcribe; false: press once to start, press again to stop. */
  pushToTalk?: boolean;
  /** Minutes an idle model waits in memory before being unloaded automatically. */
  idleUnloadMinutes?: VoiceModelIdleUnloadMinutes;
  /** Play a short chime when recording starts and when it stops; absent means off. */
  feedbackSounds?: boolean;
  /** Feedback chime volume, integer percent 0–100; absent means 70. */
  feedbackVolume?: number;
  /** Mute the OS audio output while recording and restore it when recording ends; absent means on (only an explicit false disables it). Desktop only. */
  muteWhileRecording?: boolean;
  /** Also copy each finished transcript to the system clipboard (insertion into the composer is unaffected); absent means off. */
  copyToClipboard?: boolean;
  /** Load the selected model in the background when the composer gains focus; absent means on (only an explicit false disables it). */
  warmUpOnFocus?: boolean;
  /** Rewrite each finished transcript with the post-processing provider before inserting it; absent means off. */
  postProcessEnabled?: boolean;
  /** Post-processing provider; absent means the only one today, the on-device system model. */
  postProcessProvider?: "apple-fm";
  /** Post-processing prompt; `{{text}}` is replaced by the transcript. Absent or blank means the built-in default. */
  postProcessPrompt?: string;
}

export type VoiceModelIdleUnloadMinutes = 1 | 5 | 10 | 15 | 30;

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
  /** Voice dictation (on-device offline transcription) preferences; model files and the transcription engine are owned by services/voice-dictation. */
  voiceDictation?: VoiceDictationSettings;
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
  /** Master switch for auto-archiving old sessions. */
  taskAutoArchiveEnabled?: boolean;
  /** One-time off marker set after the auto-archive fix; used only for settings migration, not for archive decisions. */
  taskAutoArchiveResetVersion?: 1;
  /** Auto-archive threshold; a task may be archived when its last update is older than this many days. */
  taskAutoArchiveOlderThanDays?: number;
  /** Hide the window to the tray on close on desktop (Windows/Linux; spec: docs/desktop/linux-close-to-tray.md). */
  closeToTrayOnWindows?: boolean;
  /** Prevent system idle sleep while an off-peak task is running (manual toggle; does not prevent sleep when the lid is closed). */
  keepAwakeWhileRunning?: boolean;
  /** Whether the one-time migration for the Windows close-to-tray default has run; used only for Settings migration, not business logic. */
  closeToTrayOnWindowsMigrationInitialized?: boolean;
  /**
   * Whether the one-time migration restoring the Linux close-to-tray default (off) has run.
   * The shared migration has no concept of platforms and previously classified existing Linux
   * users as true, while Linux had no Settings entry before; main-process bootstrap uses this
   * marker to restore first-launch Linux users to the default off in one pass.
   */
  closeToTrayLinuxMigrationInitialized?: boolean;
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
  /** Initial checkbox state for continuing a Coding Plan task after its five-hour usage reset. */
  codingPlanLimitAutoContinueDefaultEnabled?: boolean;
  /** Whether to preserve Model I/O in full; when enabled, do not rotate, reset limits, compress, or truncate, while still redacting authentication data. */
  modelIoFullRetentionEnabled?: boolean;
  /**
   * The user's chosen dynamic-workflow mode (docs/dynamic-workflow/launch.md "The user's choice").
   * Absent = follow the mode provided by the server; it takes effect only while the feature is
   * offered. Choosing the provided mode again deletes the field; untouched installs keep
   * following server-side flips.
   */
  dynamicWorkflowMode?: DynamicWorkflowMode;
  /** Enabled built-in Agent CLIs; the UI still shows "Install" externally, while the underlying semantics remain enabling a built-in capability. */
  enabledBuiltinAgentCliProviders?: ZCodeProvider[];
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
  /** Read on creation or cold restore; existing runtimes keep their current policy. */
  toolSearchMode?: AppToolSearchMode;
  /** Whether Memory is enabled for newly created or cold-restored Sessions; off by default. */
  memoryEnabled?: boolean;
  /** Inject the project memory index as a standalone background-context block instead of inside
   *  the "# agentsMd" instruction banner. Fork-only: stored in fork-settings.json. Default false. */
  memoryIndexAsContext?: boolean;
  /** Default capability set for new incognito sessions (specs/incognito-session.md). Fork-only:
   *  stored in fork-settings.json. Writes send every capability; a missing one reads as off. */
  incognitoDefaults?: IncognitoDefaults;
  /** Main-process resource sampling and ARMS resource events (specs/resource-telemetry-toggle.md).
   *  Fork-only: stored in fork-settings.json. Default false. */
  resourceTelemetryEnabled?: boolean;
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
  /** New versions store only the active execution directory; it does not express project/connection membership, and null means explicitly cleared. */
  lastActiveWorkspace?: PersistedWorkspaceSessionEntry | null;
  /** Derived by the Host from project/local entries for older-version fallback reads; new versions do not treat it as entry truth. */
  lastWorkspaceSession?: PersistedWorkspaceSessionEntry[];
  /** Resolved canonical conversation backing workspace per Source Server. */
  remoteConversationWorkspaceBySourceServerId?: Record<
    string,
    {
      workspacePath: string;
      lastResolvedAt: number;
    }
  >;
  /** Source Servers recognized by the R3 controller; runtime state is still authoritatively provided by the remote server. */
  sourceServers?: import("./source-server/contracts.js").SourceServerRecord[];
  /** Routes from R3 to Source Servers; stores only credential keys, never secrets. */
  connectionProfiles?: import("./source-server/contracts.js").ConnectionProfile[];
  /** R3 workspace open history; connection routes and workspace entities are kept separate. */
  sourceServerWorkspaceHistory?: import("./source-server/contracts.js").SourceServerWorkspaceHistoryEntry[];
  /** Whether desktop performs silent Source Server reconnection on startup; a missing value reads as true for old settings. */
  remoteStartupAutoReconnectEnabled?: boolean;
  sourceServerDirectoryMigrationVersion?: 1;
  /** Old clients only accept 2; kept for rollback compatibility — the new intro does not use this field to decide read status. */
  remoteBoundaryOnboardingVersion?: 2;
  /** Only indicates the user explicitly acknowledged the continuous-run intro. */
  remoteBoundaryIntroAcknowledgedVersion?: 1;
  /** Index of the tab active at last close. */
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
  /** V2 non-sensitive registration identity; JWTs and one-time tokens are never persisted in AppSettings. */
  webRemoteControlRelayV2Device?: {
    deviceSid: string;
    userId: string;
    endpointOrigin: string;
  };
  /** Legacy V1 device identity (no credential). Read only to detect a pre-V2 pairing; the desktop clears it after detection. */
  webRemoteControlExternalRelayDevice?: {
    deviceSid: string;
  };
  /** Target from the last successful Web remote-control enable; absence means the user explicitly disabled it, so it is not restored automatically. */
  webRemoteControlLastEnabledContext?: {
    workspacePath: string;
    workspaceIdentity?: string;
    initialTaskId?: string;
  };
  /** Temporary endpoint override from Settings; production/test default base URL is managed by the ZCODE_BASE_URL env variable. */
  zcodeEndpointOrigin?: string;
  /**
   * Where the "New task in worktree" flow creates new worktrees (spec:
   * docs/superpowers/specs/2026-10-11-command-center-worktrees-themes-design.md, "Worktree settings").
   * Unset means the sibling convention `<parent>/<repo>-worktrees/<branch>`.
   */
  worktreeLocationMode?: WorktreeLocationMode;
  /** Absolute directory used when worktreeLocationMode is "custom". */
  worktreeCustomLocationPath?: string;
  /**
   * Literal branch-name prefix for new worktree branches; stored as a template string so a future
   * `%username%` syntax does not break the format, but the MVP expands the literal text only.
   */
  worktreeBranchPrefix?: string;
  /**
   * Per-project overrides for the worktree flow, keyed by workspacePath; nothing is written into
   * the project repository. A missing entry or field inherits the global default.
   */
  worktreeProjectOverrides?: Record<string, WorktreeProjectOverrideSettings>;
}

/**
 * Where new task worktrees are created; "sibling" is the default.
 * "global" uses the app-managed `~/.zcode/worktrees/<repoName>/<branch>` directory
 * (renderer resolves the directory through IPlatformService.getAppWorktreesDir).
 */
export type WorktreeLocationMode = "sibling" | "inside" | "global" | "custom";

/** Per-project worktree defaults stored in AppSettings.worktreeProjectOverrides (keyed by workspacePath). */
export interface WorktreeProjectOverrideSettings {
  /** Base branch preselected by the "New task in worktree" flow for this project. */
  defaultBaseBranch?: string;
  /** Project-level branch prefix; overrides the global worktreeBranchPrefix when set. */
  branchPrefix?: string;
}
