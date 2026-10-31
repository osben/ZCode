import { createConversationShareMockRoute } from "./test/e2e/helpers/conversation-share-mock-route.js";
import { prepareTtftOtlpFixture } from "./test/e2e/helpers/ttft-otlp-fixture.js";
import {
  loadToolSearchResponses,
  toolSearchResponseStage,
  type ToolSearchRequest,
} from "./test/e2e/helpers/toolsearch-provider.js";
import {
  requestSecurityCaptureMocks,
  recordRequestSecurityCaptureMode,
  requestSecurityWorkerEnv,
  restoreRequestSecurityEndpointEnv,
  requestSecurityClientConfig,
  requestSecurityAgentConfig,
  requestSecuritySpecTimeout,
  startRequestSecurityFixture,
  stopRequestSecurityFixture,
} from "./test/e2e/helpers/request-security-edition/index.js";
import {
  presentationResponse,
  type EntitlementPresentation,
} from "./test/e2e/fixtures/entitlement-presentation.js";
/* eslint-disable max-lines -- WDIO config centralizes Electron, Xvfb, proxy and container demo parameters; splitting it would make the test entry harder to trace. */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import {
  resolveE2EChromedriverExecutable,
  startE2EChromedriverServer,
} from "./scripts/e2e-chromedriver-server.mjs";
import {
  captureWorkspaceSources,
  withE2ESourceEvidence,
} from "./test/e2e/reporting/e2e-source-evidence.js";
import { config as loadDotenv } from "dotenv";
import {
  PROVIDER_RESPONSIVE_TEAM_NAME,
  buildProviderResponsiveStartBalance,
} from "./test/e2e/fixtures/provider-family-responsive.js";
import {
  startUpstreamReplayServer,
  type UpstreamReplayServer,
} from "./test/e2e/helpers/upstream-replay-server.js";
import {
  hasUpstreamCaseLocalReplayFixtureForWorker,
  resolveUpstreamE2EHttpMode,
  resolveUpstreamE2EHttpModeForWorker,
  resolvePluginReplayFixturePaths,
  resolveUpstreamReplayFixturePaths as resolveUpstreamReplayFixturePathsFromContract,
  type UpstreamReplayFixtureMode,
} from "./test/e2e/helpers/upstream-replay-fixture-resolution.js";
import {
  buildE2ERunIdArg,
  buildWindowsTaskkillArgs,
  createWindowsE2EHomeMarkerArg,
  listE2EProcessTreePids,
  waitE2EDelay,
} from "./test/e2e/helpers/e2e-process-cleanup.js";
import {
  collectE2EWebDriverPageHandleCandidates,
  type E2EBrowserTargetInfo,
} from "./test/e2e/helpers/e2e-window-target.js";
import { runE2EBeforeSessionSetup } from "./test/e2e/helpers/e2e-before-session.js";
import {
  PROJECT_UPGRADE_ORDER_SPEC,
  seedProjectUpgradeOrderFixture,
} from "./test/e2e/helpers/project-upgrade-order-fixture.js";
import { resolveAskUserQuestionClockScaleForWorker } from "./test/e2e/helpers/e2e-worker-environment.js";
import {
  CODING_PLAN_TEAM_MOCK_BASE_URL_ENV,
  CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV,
  applyCodingPlanTeamMockEnv,
  applyCodingPlanUpgradeMockEnv,
  clearCodingPlanTeamMockEnv,
  clearCodingPlanUpgradeMockEnv,
  shouldPrepareCodingPlanTeamMock,
  shouldReuseDesktopE2EBuild,
  isOffPeakTeamPlanSpec,
} from "./test/e2e/helpers/coding-plan-mock-env.js";
import {
  createCodingPlanDataPlaneResponse,
  type DataPlaneTurnFixture,
} from "./test/e2e/helpers/coding-plan-data-plane-response.js";
import {
  HIGHSPEED_MOCK_SCENARIO_ENV,
  resolveHighspeedE2EMockScenario,
} from "./test/e2e/helpers/highspeed-mock-env.js";
import { createE2ERendererBridgeRootHooks } from "./test/e2e/helpers/e2e-renderer-bridge-root-hook.js";
import { resetDraftRegenerationResend } from "#e2e/helpers/draft-regeneration-resend";
import { installHookTrustFixture } from "./test/e2e/helpers/hook-trust-fixture.js";
import { resolveUpstreamModels } from "./test/e2e/helpers/upstream-recorded-models.js";
import { runMeasuredE2ELifecyclePhase } from "./test/e2e/helpers/e2e-lifecycle-measurement.js";
import { createE2ERunnerFinalizationGuard } from "./test/e2e/helpers/e2e-runner-finalization-guard.js";
import { installHooksLifecycleFixture } from "./test/e2e/helpers/hooks-lifecycle-fixture.js";
import { installStopToolResultsFixture } from "./test/e2e/helpers/stop-tool-results-fixture.js";
import { installBashPrefixPermissionPnpmShim } from "./test/e2e/helpers/bash-prefix-permission-shim.js";
import {
  applyE2EWorkerModelRetryEnv,
  applyE2EWorkerReplayProxyEnv,
  replaceChromeUserDataDirArg,
  resolveE2EWorkerModelStreamIdleTimeoutMs,
  resolveE2EWebDriverRequestLimits,
  resolveE2EWorkerChromiumProfileDir,
  workerSpecsContain,
} from "./test/e2e/helpers/e2e-worker-isolation.js";
import { createE2EStartupCredentialSeed } from "./test/e2e/helpers/e2e-startup-credentials.js";
import { seedRemoteOnboardingFixture } from "./test/e2e/helpers/remote-startup-profile.js";
import { getE2EProviderEndpointEnv } from "#e2e/helpers/e2e-provider-endpoint";
import { prepareOAuthCompletionRaceFixture } from "./test/e2e/helpers/oauth-completion-race-fixture.js";
import { prepareAccessToken401Fixture } from "./test/e2e/helpers/access-token-401-fixture.js";
import { createE2EReplayFixtureVariables } from "./test/e2e/helpers/e2e-runtime-paths.js";
import { stageE2EAppOutput } from "./test/e2e/helpers/e2e-app-output-stage.js";
import { withE2EDesktopBuildLock } from "./scripts/ensure-e2e-desktop-build.mjs";
import {
  ensureSshRemoteReleaseAssets,
  resolveSshRemoteReleaseScope,
} from "./test/e2e/helpers/e2e-ssh-remote-release-assets.js";
import {
  ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV,
  BUILTIN_MODEL_PROVIDER_IDS,
  BIGMODEL_PROVIDER_ID,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
import {
  seedPersonalProviderConfig,
  seedPersonalDefaultModelSelection,
  type PersonalProviderConfigSeed,
} from "./test/e2e/helpers/model-provider-restart-config.js";
import {
  DEFAULT_E2E_NETWORK_CAPTURE_NO_PROXY,
  startE2ENetworkCaptureProxy,
  type E2ENetworkCaptureProxy,
} from "./test/e2e/helpers/network-capture-proxy.js";
import {
  resetCodingPlanUpgradeMockServer,
  resolveCodingPlanUpgradeMockScenario,
  shouldPrepareCodingPlanUpgradeMockForBuild,
  startCodingPlanUpgradeMockServer,
  type CodingPlanUpgradeMockServer,
} from "./test/e2e/helpers/coding-plan-upgrade-mock-server.js";
import {
  MANUAL_REVIEW_SPEC_GLOB,
  hasRequiredSshE2EEnvironment,
  isExplicitE2ESpecSelection,
  resolveEnvironmentGatedFormalSpecExcludes,
} from "./scripts/e2e-formal-spec-selection.mjs";
import {
  applyDynamicWorkflowConfigMockEnv,
  clearDynamicWorkflowConfigMockEnv,
  resolveDynamicWorkflowConfigMockScenario,
  startDynamicWorkflowConfigMockServer,
  type DynamicWorkflowConfigMockServer,
} from "./test/e2e/helpers/dynamic-workflow-config-mock-server.js";
import {
  resolveModelContextBudgetConfigMockScenario,
  startModelContextBudgetConfigMockServer,
  type ModelContextBudgetConfigMockServer,
} from "./test/e2e/helpers/model-context-budget-config-mock-server.js";
import {
  MODEL_PROVIDER_CATALOG_PAYLOAD,
  resolveSubagentLoginCatalogConfigVersion,
  resolveSubagentLoginCatalogPayload,
} from "./test/e2e/helpers/model-provider-catalog-mock-server.js";
import {
  applyClientScenesMockEnv,
  clearClientScenesMockEnv,
  shouldUseClientScenesMock,
  startClientScenesMockServer,
  type ClientScenesMockServer,
} from "./test/e2e/helpers/client-scenes-mock-server.js";
import {
  resolvePluginCdnZipMarketplaceLastUpdated,
  seedPluginCdnZipMarketplaceFixture,
  shouldUsePluginCdnZipMarketplaceFixture,
  startPluginCdnZipFixtureServer,
  stopPluginCdnZipFixtureServer,
  type PluginCdnZipFixtureServer,
} from "./test/e2e/helpers/plugin-cdn-zip-marketplace.js";
import { E2EFailureArtifactCollector } from "./test/e2e/reporting/e2e-failure-artifacts.js";
import { classifyError, createE2EReporter } from "./test/e2e/reporting/e2e-reporting.js";
import type { E2ELifecyclePhase } from "./test/e2e/reporting/e2e-reporting-types.js";
import {
  DEFAULT_E2E_ELECTRON_INSTALL_TIMEOUT_MS,
  resolveE2EElectronBinary,
} from "./test/e2e/helpers/e2e-electron-binary.js";
import {
  CONTEXT_WINDOW_COLD_RESUME_MAX_TOKENS,
  CONTEXT_WINDOW_COLD_RESUME_MAX_OUTPUT_TOKENS,
  CONTEXT_WINDOW_COLD_RESUME_MODEL_ID,
  CONTEXT_WINDOW_COLD_RESUME_PROVIDER_ID,
  CONTEXT_WINDOW_COLD_RESUME_PROVIDER_NAME,
  seedProviderReadinessHistoryFixture,
} from "./test/e2e/helpers/provider-readiness-history-fixture.js";
import { seedSessionPrStatusFixture } from "./test/e2e/helpers/session-pr-status-fixture.js";
import {
  PASSIVE_AGENT_STARTUP_SCENARIO,
  SMALL_AGENT_WARMUP_SCENARIO,
  seedPassiveAgentStartupWorkspaces,
} from "./test/e2e/helpers/passive-agent-startup-fixture.js";
import { seedSessionHistoryFirstFixture } from "./test/e2e/helpers/session-history-first-fixture.js";
import { seedTaskIndexRowAuthorityFixture } from "./test/e2e/helpers/task-list-row-authority-fixture.js";
import { seedDeleteAllArchivedTasksFixture } from "./test/e2e/helpers/delete-all-archived-tasks-fixture.js";
import { seedTaskTitleMarqueeFixture } from "./test/e2e/helpers/task-title-marquee-fixture.js";
import { seedAppUsageE2EFixture } from "./test/e2e/helpers/usage-stats-app-usage-fixture.js";

const DESKTOP_DIR = import.meta.dirname;
const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(DESKTOP_DIR, "../..");
const E2E_ELECTRON_SERVICE_MODULE_PATH = resolve(
  DESKTOP_DIR,
  "test/e2e/helpers/e2e-electron-service.ts",
);
const E2E_LOCAL_ENV_FILES = [
  resolve(DESKTOP_DIR, ".env.e2e.local"),
  resolve(REPO_ROOT, ".env.e2e.local"),
  // The repository no longer ships a shared key: .env.e2e.local.example lists only variable names with empty values and is not read as a fallback.
];
// Bug cause: the Electron binary preflight ran before local E2E env was loaded, so the missing-package fix bypassed mirror,
// proxy, certificate and cache config. Every runner init that reads process.env must run after that call.
loadE2ELocalEnv();
const BUILD_DESKTOP_AGENT_SCRIPT = resolve(REPO_ROOT, "scripts/build-desktop-agent-cli.mjs");
const ZCODE_CLI_ENTRYPOINT = resolve(REPO_ROOT, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
const E2E_HOME_DIR = resolve(
  process.env.ZCODE_E2E_HOME_DIR?.trim() ||
    // Fix reason: when several local WDIO runs run concurrently they clean each other's default .e2e-home, causing blank windows,
    // DevTools links breaking or login-page waits failing. The default path stays compatible; explicit isolation is allowed when debugging.
    resolve(DESKTOP_DIR, ".e2e-home"),
);
const E2E_PACKAGED_APP_BINARY_PATH = process.env.ZCODE_E2E_PACKAGED_APP_PATH?.trim()
  ? resolve(process.env.ZCODE_E2E_PACKAGED_APP_PATH)
  : null;
// The directory isolation was rolled back: all Desktop E2E keep using the historical ~/.zcode layout.
const E2E_STORAGE_ROOT = resolve(E2E_HOME_DIR, ".zcode");
const E2E_APP_CONFIG_DIR = resolve(E2E_STORAGE_ROOT, "v2");
const E2E_APP_SETTINGS_FILE = resolve(E2E_APP_CONFIG_DIR, "setting.json");
const E2E_APP_CREDENTIALS_FILE = resolve(E2E_APP_CONFIG_DIR, "credentials.json");
const E2E_APP_PROVIDER_CONFIG_FILE = resolve(E2E_APP_CONFIG_DIR, "provider_config.json");
// The staged Electron app contains only main/host/renderer artifacts and does not carry the repo-level config/provider.
// If Host derives bundled config from app.getAppPath(), a restart would treat a non-existent path as a
// bundled release and model config initialization would fail outright. E2E explicitly injects the same read-only baseline; the off-peak
// spec overrides it with a case-local file that has a mock endpoint, in startOffPeakE2EMock.
const E2E_DEFAULT_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = resolve(
  REPO_ROOT,
  "config/provider/zcode-builtin.json",
);
const INITIAL_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE =
  process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim();
const E2E_OFFPEAK_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = resolve(
  REPO_ROOT,
  ".cache/desktop-e2e-provider-config/official-offpeak-mock.json",
);
const E2E_AGENTS_STATE_FILE = resolve(E2E_APP_CONFIG_DIR, "agents-state.json");
const E2E_CLI_CONFIG_DIR = resolve(E2E_STORAGE_ROOT, "cli");
const E2E_CLI_CONFIG_FILE = resolve(E2E_CLI_CONFIG_DIR, "config.json");
const E2E_CLI_AGENTS_DIR = resolve(E2E_CLI_CONFIG_DIR, "agents");
const E2E_USER_AGENTS_DIR = resolve(E2E_STORAGE_ROOT, "agents");
const E2E_NETWORK_CAPTURE_DIR = resolve(
  process.env.ZCODE_E2E_NETWORK_CAPTURE_DIR?.trim() ||
    // Fix reason: beforeSession clears .e2e-home; the capture proxy's CA must sit
    // outside the reset scope, otherwise the agent hits ENOENT when reading httpProxyCaCertPath.
    resolve(DESKTOP_DIR, ".e2e-network-capture"),
);
const E2E_CERT_CACHE_ROOT =
  process.env.ZCODE_E2E_CERT_CACHE_DIR?.trim() || resolve(REPO_ROOT, ".cache");
const E2E_NETWORK_CAPTURE_CA_DIR = resolve(E2E_CERT_CACHE_ROOT, "desktop-e2e-network-capture-ca");
const E2E_CODING_PLAN_DATA_PLANE_CA_DIR = resolve(
  E2E_CERT_CACHE_ROOT,
  "desktop-e2e-coding-plan-data-plane-ca",
);
const E2E_BROWSER_DRIVER_CACHE_DIR = resolve(REPO_ROOT, ".cache/wdio-browser-drivers");
const DESKTOP_BUILD_OUTPUT_DIR = resolve(DESKTOP_DIR, "out");
const DESKTOP_BUILD_ENTRY_POINT = resolve(DESKTOP_BUILD_OUTPUT_DIR, "main/index.js");
const E2E_RENDERER_ASSETS_DIR = resolve(DESKTOP_DIR, "out/renderer/assets");
const UPSTREAM_CAPTURE_ARTIFACT_PATH = resolve(E2E_NETWORK_CAPTURE_DIR, "upstream-provider.json");
const CODING_PLAN_DATA_PLANE_ARTIFACT_PATH = resolve(
  E2E_NETWORK_CAPTURE_DIR,
  "coding-plan-data-plane.json",
);
const E2E_PROVIDER_RUNTIME_FILE = resolve(E2E_NETWORK_CAPTURE_DIR, "upstream-runtime.json");
const UPSTREAM_REPLAY_FIXTURE_ROOT = resolve(DESKTOP_DIR, "test/e2e/fixtures/upstream");
const UPSTREAM_COMMON_REPLAY_FIXTURE_PATH = resolve(UPSTREAM_REPLAY_FIXTURE_ROOT, "common.json");
const UPSTREAM_CONVERSATION_SESSION_REPLAY_FIXTURE_DIR = resolve(
  UPSTREAM_REPLAY_FIXTURE_ROOT,
  "conversation-session",
);
const UPSTREAM_CONVERSATION_SESSION_CASE_MANIFEST_DIR = resolve(
  DESKTOP_DIR,
  "test/e2e/fixtures/cases/conversation-session",
);
const LEGACY_UPSTREAM_REPLAY_FIXTURE_PATHS = [
  resolve(UPSTREAM_REPLAY_FIXTURE_ROOT, "provider-conversation-tool-cross-product.json"),
  resolve(UPSTREAM_REPLAY_FIXTURE_ROOT, "provider-basic.json"),
];
const UPSTREAM_CAPTURE_RESPONSE_PREVIEW_BYTES = 8 * 1024 * 1024;
const UPSTREAM_CAPTURE_RESPONSE_CHUNK_TIMELINE_BYTES = 16 * 1024 * 1024;
const E2E_ELECTRON_INSTALL_TIMEOUT_MS =
  readPositiveIntegerEnv("ZCODE_E2E_ELECTRON_INSTALL_TIMEOUT_MS") ??
  DEFAULT_E2E_ELECTRON_INSTALL_TIMEOUT_MS;
const ELECTRON_APP_BINARY_PATH =
  E2E_PACKAGED_APP_BINARY_PATH ??
  resolveE2EElectronBinary({
    desktopDir: DESKTOP_DIR,
    environment: process.env,
    installTimeoutMs: E2E_ELECTRON_INSTALL_TIMEOUT_MS,
    repoRoot: REPO_ROOT,
  });
const UPSTREAM_PROVIDER_SPEC = "./test/e2e/upstream-provider.test.ts";
const PLUGIN_NO_GIT_GITHUB_ARCHIVE_SPEC = "plugin-no-git-github-archive.test.ts";
const GIT_COMMIT_DIALOG_UI_FLOW_SPEC = "git-commit-dialog-ui-flow.test.ts";
const OAUTH_CREDENTIAL_RECOVERY_SPEC = "oauth-credential-recovery.test.ts";
const JWT_EXPIRY_REAUTHENTICATION_SPEC = "jwt-expiry-reauthentication.test.ts";
const SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_SPEC =
  "subagent-coding-plan-login-catalog-stale.test.ts";
const SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE = "subagent-login-catalog-stale";
const SUBAGENT_CODING_PLAN_OAUTH_FLOW_ID = "e2e-subagent-bigmodel-flow";
const SUBAGENT_CODING_PLAN_OAUTH_STATE = "e2e-subagent-bigmodel-state";
const PROVIDER_READINESS_AGENT_STARTUP_SPEC = "provider-readiness-agent-startup.test.ts";
const CONTEXT_WINDOW_COLD_RESUME_SPEC = "conversation-session-context-window-cold-resume.test.ts";
const PASSIVE_AGENT_STARTUP_SPEC = "workspace-passive-agent-startup.test.ts";
const AGENT_WARMUP_LIFECYCLE_SPEC = "workspace-agent-warmup-lifecycle.test.ts";
const AGENT_WARMUP_SMALL_SET_SPEC = "workspace-agent-warmup-small-set.test.ts";
const PROVIDER_SAVE_DORMANT_AGENT_SPEC = "workspace-provider-save-dormant-agent.test.ts";
const MODEL_PROVIDER_REGRESSION_GAPS_SPEC =
  "conversation-session-model-provider-regression-gaps.test.ts";
// Only borrows this fixture's "multi-workspace restored" startup state for workspace switching; it does not assert agent warmup behavior.
const BROWSER_CROSS_WORKSPACE_CLOSE_SPEC = "browser-tab-close-cross-workspace.test.ts";
const BROWSER_CROSS_WORKSPACE_ATTACHMENT_SPEC =
  "browser-tab-attachment-restore-cross-workspace.test.ts";
const WORKSPACE_REMOVAL_RUNTIME_RELEASE_SPEC = "workspace-removal-runtime-release.test.ts";
const WORKSPACE_SIDEBAR_PROJECT_CONTROLS_SPEC = "workspace-sidebar-project-controls.test.ts";
const AGENT_WARMUP_FIXTURE_SPECS = [
  PASSIVE_AGENT_STARTUP_SPEC,
  AGENT_WARMUP_LIFECYCLE_SPEC,
  AGENT_WARMUP_SMALL_SET_SPEC,
  PROVIDER_SAVE_DORMANT_AGENT_SPEC,
  WORKSPACE_SIDEBAR_PROJECT_CONTROLS_SPEC,
  BROWSER_CROSS_WORKSPACE_CLOSE_SPEC,
  BROWSER_CROSS_WORKSPACE_ATTACHMENT_SPEC,
  WORKSPACE_REMOVAL_RUNTIME_RELEASE_SPEC,
  MODEL_PROVIDER_REGRESSION_GAPS_SPEC,
] as const;
/** Specs that need only two workspaces; the small scenario seeds 7 fewer directories. */
const SMALL_AGENT_WARMUP_SPECS = [
  AGENT_WARMUP_SMALL_SET_SPEC,
  WORKSPACE_SIDEBAR_PROJECT_CONTROLS_SPEC,
  BROWSER_CROSS_WORKSPACE_CLOSE_SPEC,
  BROWSER_CROSS_WORKSPACE_ATTACHMENT_SPEC,
  WORKSPACE_REMOVAL_RUNTIME_RELEASE_SPEC,
  MODEL_PROVIDER_REGRESSION_GAPS_SPEC,
] as const;
const TASK_INDEX_ROW_AUTHORITY_SPEC = "conversation-session-task-index-row-authority.test.ts";
const TASK_TITLE_MARQUEE_SPEC = "conversation-session-task-title-marquee.test.ts";
const GIT_REVIEW_ENTRY_SPEC = "conversation-session-git-review-entry.test.ts";
const SESSION_PR_STATUS_SPEC = "git/session-pr-status.test.ts";
const WORKTREE_CHAT_FIRST_SPEC = "conversation-session-worktree-chat-first.test.ts";
const WINDOWS_AGENT_METRIC_PROBE_ABSENCE_SPEC = "windows-agent-metric-probe-absence.test.ts";
const HOOKS_LIFECYCLE_SPEC = "conversation-session-hooks-lifecycle.test.ts";
const HOOK_TRUST_SPEC = "conversation-session-hook-trust.test.ts";
const E2E_PROVIDER_ID = "e2e-upstream";
const E2E_PROVIDER_ALTERNATE_PROVIDER_ID = "e2e-upstream-alt";
const E2E_PROVIDER_ALTERNATE_PROVIDER_NAME = "Upstream E2E Alt";
// Model names are controlled by E2E_PROVIDER_MODEL / E2E_PROVIDER_SECONDARY_MODEL; when unset, the replay fixture's recorded model is used.
const { model: E2E_PROVIDER_MODEL, secondaryModel: E2E_PROVIDER_SECONDARY_MODEL } =
  resolveUpstreamModels();
const SUBAGENT_PROVIDER_REGISTRY_COLD_START_SPEC =
  "conversation-session-subagent-provider-registry-cold-start.test.ts";
const BUILT_IN_SUBAGENT_MODEL_OVERRIDES_SPEC =
  "conversation-session-built-in-subagent-model-overrides.test.ts";
const SETTINGS_SUBAGENT_CREATE_EDIT_PERSISTENCE_SPEC =
  "settings-subagent-create-edit-persistence.test.ts";
const SUBAGENT_REASONING_AGENT_NAME = "e2e-reasoning-reviewer";
const SUBAGENT_RUNTIME_CATALOG_REASONING_SPEC =
  "conversation-session-subagent-runtime-catalog-reasoning.test.ts";
const SUBAGENT_RUNTIME_CATALOG_PROVIDER_ID = "e2e-claude-runtime-catalog";
const SUBAGENT_RUNTIME_CATALOG_PROVIDER_NAME = "Claude Runtime Catalog E2E";
const SUBAGENT_RUNTIME_CATALOG_MODEL = "claude-opus-4-8";
const SUBAGENT_RUNTIME_CATALOG_AGENT_NAME = "e2e-claude-catalog-reviewer";
const OFFPEAK_SUBAGENT_MODEL_INHERITANCE_SPEC =
  "conversation-session-offpeak-subagent-model-inheritance.test.ts";
const OFFPEAK_INVALID_TICKET_SPEC = "conversation-session-off-peak-invalid-ticket.test.ts";
const MODEL_PROVIDER_PLAN_SURFACE_SPEC = "conversation-session-model-provider-plan-surface.test.ts";
const SUBAGENT_TEAM_SCOPE_SPEC = "conversation-session-subagent-team-scope.test.ts";
const TOOL_ERROR_SURFACE_SPEC = "conversation-session-tool-error-surface.test.ts";
const MODEL_OUTPUT_TOKEN_BUDGET_SPEC = "conversation-session-model-output-token-budget.test.ts";
const MODEL_OUTPUT_TOKEN_PREFLIGHT_SPEC = "conversation-session-model-output-token-preflight";
const OUTPUT_LIMIT_CONTINUE_MARKDOWN_PROTOCOLS_SPEC =
  "conversation-session-output-limit-continue-markdown-protocols.test.ts";
const SUBAGENT_PROVIDER_REGISTRY_AGENT_NAME = "e2e-provider-registry-reviewer";
const TOOL_ERROR_SURFACE_STALE_AGENT_NAME = "e2e-stale-error-reviewer";
const TOOL_ERROR_SURFACE_HEALTHY_AGENT_NAME = "e2e-healthy-error-reviewer";
// The upstream provider address comes from E2E_PROVIDER_BASE_URL; the repo hardcodes no provider. Only capture mode needs it, when it hits the real upstream.
// Replay mode uses the local replay server; the effective address is passed to each test process via E2E_PROVIDER_RUNTIME_BASE_URL.
const E2E_PROVIDER_UPSTREAM_BASE_URL = process.env.E2E_PROVIDER_BASE_URL?.trim() ?? "";
const E2E_PROVIDER_REPLAY_API_KEY = "e2e-fixture-key";
const CODING_PLAN_MODEL_SSE_BODY =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"coding-plan-e2e","type":"message","role":"assistant","content":[],"model":"glm-e2e","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":128,"output_tokens":0}}}\n\n' +
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"coding-plan-e2e-ok"}}\n\n' +
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":12}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const codingPlanDefaultDataPlaneResponse = createCodingPlanDataPlaneResponse(null, {
  fallbackBody: CODING_PLAN_MODEL_SSE_BODY,
  title: { id: "coding-plan-e2e-title", text: '{"title":"Coding Plan E2E"}' },
});
const E2E_AUTH_PROVIDER_ID = "zai";
const E2E_AUTH_TOKEN = "e2e-oauth-token";
const E2E_USER_PROFILE = {
  displayName: "ZCode E2E",
  id: "zcode-e2e-user",
  username: "zcode-e2e-user",
};
const GLM_HIGHSPEED_E2E_PROVIDER_ID = "e2e-glmhighspeed";
const GLM_HIGHSPEED_E2E_MODEL = "glm-5.1-highspeed";
const GLM_HIGHSPEED_E2E_BASE_URL = "https://open.bigmodel.cn/api";
const BIGMODEL_GLM53_E2E_PROVIDER_ID = "e2e-bigmodel-glm53";
const BIGMODEL_GLM53_E2E_MODEL = "GLM-5.3";
const BIGMODEL_GLM53_E2E_BASE_URL = "https://open.bigmodel.cn/api";
const STAGING_MODEL_E2E_PROVIDER_ID = "e2e-staging-model";
const STAGING_MODEL_E2E_MODEL = "glm-5.2";
const STAGING_MODEL_E2E_BASE_URL = "https://open.bigmodel.cn/api";
const E2E_PROVIDER_PRESETS = {
  env: {
    apiKeyEnvNames: ["E2E_PROVIDER_API_KEY"],
    baseUrl: E2E_PROVIDER_UPSTREAM_BASE_URL,
    expectedHost: readUpstreamBaseUrlPart("host"),
    expectedProtocol: readUpstreamBaseUrlPart("protocol"),
    model: E2E_PROVIDER_MODEL,
    providerId: E2E_PROVIDER_ID,
    providerName: "Upstream E2E",
    thoughtLevel: "high",
  },
  glmhighspeed: {
    apiKeyEnvNames: [
      "GLM_HIGHSPEED_E2E_API_KEY",
      "BIGMODEL_API_KEY",
      "ZHIPUAI_API_KEY",
      "E2E_PROVIDER_API_KEY",
    ],
    baseUrl: GLM_HIGHSPEED_E2E_BASE_URL,
    expectedHost: "open.bigmodel.cn",
    expectedProtocol: "https",
    model: GLM_HIGHSPEED_E2E_MODEL,
    providerId: GLM_HIGHSPEED_E2E_PROVIDER_ID,
    providerName: "GLM Highspeed E2E",
    thoughtLevel: "",
  },
  bigmodel53: {
    apiKeyEnvNames: ["BIGMODEL_GLM53_E2E_API_KEY"],
    baseUrl: BIGMODEL_GLM53_E2E_BASE_URL,
    expectedHost: "open.bigmodel.cn",
    expectedProtocol: "https",
    model: BIGMODEL_GLM53_E2E_MODEL,
    providerId: BIGMODEL_GLM53_E2E_PROVIDER_ID,
    providerName: "BigModel GLM-5.3 E2E",
    thoughtLevel: "",
  },
  stagingmodel: {
    apiKeyEnvNames: ["STAGING_MODEL_E2E_API_KEY"],
    baseUrl: STAGING_MODEL_E2E_BASE_URL,
    expectedHost: "open.bigmodel.cn",
    expectedProtocol: "https",
    model: STAGING_MODEL_E2E_MODEL,
    providerId: STAGING_MODEL_E2E_PROVIDER_ID,
    providerName: "stagingModel",
    thoughtLevel: "",
  },
} as const;
type E2EProviderPresetName = keyof typeof E2E_PROVIDER_PRESETS;
const upstreamE2EContextWindowOverride = readPositiveIntegerEnv(
  "ZCODE_E2E_UPSTREAM_CONTEXT_WINDOW",
);
const upstreamE2EMaxOutputTokensOverride = readPositiveIntegerEnv(
  "ZCODE_E2E_UPSTREAM_MAX_OUTPUT_TOKENS",
);
const DESKTOP_PACKAGE_JSON = JSON.parse(
  readFileSync(resolve(DESKTOP_DIR, "package.json"), "utf-8"),
) as { devDependencies?: Record<string, string> };
const ELECTRON_VERSION = DESKTOP_PACKAGE_JSON.devDependencies?.electron ?? "";
let e2eChromedriverServer: Awaited<ReturnType<typeof startE2EChromedriverServer>> | undefined;
const PNPM_COMMAND = "pnpm";
const E2E_ELECTRON_APP_QUIT_TIMEOUT_MS =
  readPositiveIntegerEnv("ZCODE_E2E_ELECTRON_APP_QUIT_TIMEOUT_MS") ?? 1000;
const E2E_ELECTRON_FORCE_KILL_GRACE_MS =
  readPositiveIntegerEnv("ZCODE_E2E_ELECTRON_FORCE_KILL_GRACE_MS") ?? 3000;
const E2E_RENDERER_BRIDGE_PREFLIGHT_TIMEOUT_MS =
  readPositiveIntegerEnv("ZCODE_E2E_RENDERER_BRIDGE_PREFLIGHT_TIMEOUT_MS") ?? 15000;
const E2E_RUNNER_FORCE_EXIT_TIMEOUT_MS =
  readPositiveIntegerEnv("ZCODE_E2E_RUNNER_FORCE_EXIT_TIMEOUT_MS") ?? 5000;
const E2E_RUNNER_FINALIZATION_GUARD_TIMEOUT_MS =
  readPositiveIntegerEnv("ZCODE_E2E_RUNNER_FINALIZATION_GUARD_TIMEOUT_MS") ?? 30000;
const E2E_FAILURE_ARTIFACT_COLLECTION_TIMEOUT_MS = Math.min(
  readPositiveIntegerEnv("ZCODE_E2E_FAILURE_ARTIFACT_COLLECTION_TIMEOUT_MS") ?? 60_000,
  5 * 60_000,
);
const E2E_WEBDRIVER_REQUEST_LIMITS = resolveE2EWebDriverRequestLimits({
  retryCount: process.env.ZCODE_E2E_WEBDRIVER_REQUEST_RETRY_COUNT,
  timeoutMs: process.env.ZCODE_E2E_WEBDRIVER_REQUEST_TIMEOUT_MS,
});
const E2E_HOME_REMOVE_RETRY_DELAYS_MS = [200, 500, 1000, 2000, 3000, 5000, 8000];
const HOST_HOME_DIR = process.env.HOME?.trim();
const HOST_USERPROFILE_DIR = process.env.USERPROFILE?.trim();

interface E2ERendererBridgePreflightResult {
  bridgeMethods: Record<string, boolean>;
  candidateHandles: string[];
  currentHandle: string | null;
  documentReadyState: string | null;
  handle: string | null;
  handles: string[];
  hasSessionBridge: boolean;
  missingBridgeMethods: string[];
  missingStateMethods: string[];
  ok: boolean;
  reason: string;
  stateMethods: Record<string, boolean>;
  targets: E2EBrowserTargetInfo[];
  url: string | null;
}

const E2E_RENDERER_BRIDGE_REQUIRED_BRIDGE_METHODS = ["getState", "setState", "subscribe"];
// Fix reason: the V4 store removed the old renderer-local queue/message/stop injection methods; if the global preflight
// still required them, a healthy renderer would be misjudged as an infrastructure failure before the formal V4 case runs.
const E2E_RENDERER_BRIDGE_REQUIRED_STATE_METHODS = [
  "getWorkspaceState",
  "setSlashCommands",
  "setTaskRuntimeState",
  "upsertOptimisticTaskListItem",
];

const requestedE2ESpecs = readRequestedE2ESpecs();
const requestedE2EExcludeSpecs = readRequestedE2EExcludeSpecs();
const configuredModelRetryMaxRetries = process.env.ZCODE_MODEL_RETRY_MAX_RETRIES;
const configuredE2EWorkerNetworkEnv = {
  httpProxy: process.env.ZCODE_HTTP_PROXY,
  noProxy: process.env.ZCODE_NO_PROXY,
};
const upstreamProviderSpecRequested = process.argv
  .concat(requestedE2ESpecs)
  .some((arg) => arg.includes("upstream-provider.test.ts"));
const manualReviewSpecRequested = process.argv
  .concat(requestedE2ESpecs)
  .some((arg) => arg.replaceAll("\\", "/").includes("/manual-review/"));
const manualReviewE2E =
  process.env.ZCODE_E2E_MANUAL_REVIEW?.trim() === "1" || manualReviewSpecRequested;
if (manualReviewE2E) {
  process.env.ZCODE_E2E_MANUAL_REVIEW = "1";
}
const manualReviewHoldMs = readPositiveIntegerEnv("ZCODE_E2E_MANUAL_REVIEW_HOLD_MS") ?? 0;
const REQUESTED_UPSTREAM_HTTP_MODE_ENV = "ZCODE_E2E_REQUESTED_UPSTREAM_HTTP_MODE";
const requestedUpstreamE2EHttpMode =
  process.env[REQUESTED_UPSTREAM_HTTP_MODE_ENV] !== undefined
    ? process.env[REQUESTED_UPSTREAM_HTTP_MODE_ENV]?.trim() || undefined
    : process.env.E2E_PROVIDER_HTTP_MODE?.trim() || undefined;
const requestedAskUserQuestionClockScale =
  process.env[ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV]?.trim() || undefined;
let upstreamE2EHttpMode = readUpstreamE2EHttpMode();
const e2eProviderPresetName = readE2EProviderPresetName();
const e2eProviderPreset = E2E_PROVIDER_PRESETS[e2eProviderPresetName];
const containerE2E = process.env.ZCODE_E2E_CONTAINER === "1";
const configuredE2ESpecs =
  requestedE2ESpecs.length > 0
    ? requestedE2ESpecs
    : manualReviewE2E
      ? [MANUAL_REVIEW_SPEC_GLOB]
      : upstreamProviderSpecRequested
        ? [UPSTREAM_PROVIDER_SPEC]
        : ["./test/e2e/**/*.test.ts"];
const pluginNoGitGitHubArchiveE2E = configuredE2ESpecs.some((spec) =>
  spec.includes(PLUGIN_NO_GIT_GITHUB_ARCHIVE_SPEC),
);
const workspacePluginRemoteExplicitSyncE2E = configuredE2ESpecs.some((spec) =>
  spec.includes("conversation-session-plugin-remote-explicit-sync-workspace.test.ts"),
);
const e2eReporter = createE2EReporter({
  repoRoot: REPO_ROOT,
  desktopDir: DESKTOP_DIR,
  requestedSpecs: requestedE2ESpecs,
  containerE2E,
});
const e2eRunnerFinalizationGuard = createE2ERunnerFinalizationGuard({
  onTimeout: forceFinalizeE2ERunnerFromGuard,
  timeoutMs: E2E_RUNNER_FINALIZATION_GUARD_TIMEOUT_MS,
});
const E2E_RUN_ID = process.env.ZCODE_E2E_RUN_ID?.trim();
if (!E2E_RUN_ID) {
  throw new Error("[e2e] ZCODE_E2E_RUN_ID missing after reporter initialization");
}
const E2E_RUN_CACHE_DIR = resolve(DESKTOP_DIR, ".e2e-cache", E2E_RUN_ID);
const E2E_APP_OUTPUT_DIR = resolve(E2E_RUN_CACHE_DIR, "app");
const E2E_APP_ENTRY_POINT = resolve(E2E_APP_OUTPUT_DIR, "main/index.js");
const E2E_APP_RENDERER_ASSETS_DIR = resolve(E2E_APP_OUTPUT_DIR, "renderer/assets");
const E2E_REMOTE_ASSET_VERSION = String(
  (
    JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8")) as {
      version?: string;
    }
  ).version ?? "",
).trim();
const E2E_REMOTE_RELEASE_SOURCE_DIR = resolve(
  DESKTOP_DIR,
  "mock-cdn",
  "releases",
  E2E_REMOTE_ASSET_VERSION,
);
const E2E_REMOTE_RELEASE_OUTPUT_DIR = resolve(
  E2E_RUN_CACHE_DIR,
  "mock-cdn",
  "releases",
  E2E_REMOTE_ASSET_VERSION,
);
const E2E_CHROMIUM_USER_DATA_ROOT_DIR = resolve(E2E_RUN_CACHE_DIR, "chromium-profiles");
const containerChromeArgs = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--ozone-platform=x11",
  "--window-size=1440,1000",
];

process.env.HOME = E2E_HOME_DIR;
process.env.USERPROFILE = E2E_HOME_DIR;
process.env.ZCODE_E2E_HOME_DIR = E2E_HOME_DIR;
process.env.ZCODE_E2E_RUN_ID = E2E_RUN_ID;
process.env.ZCODE_DATA_BASE_DIR = E2E_HOME_DIR;
process.env.ZCODE_DESKTOP_APPLICATION_NAME = "ZCode E2E";
process.env.ZCODE_DESKTOP_HOME_DIR = E2E_HOME_DIR;
process.env.ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA = "1";
// Bugfix: the renderer E2E store bridge may be opened only explicitly by the WDIO process, so the ZCODE_ENV=test product environment does not expose a global mutable store.
process.env.VITE_ZCODE_E2E_STORE_BRIDGE = "1";
// Bugfix: the e2e session's debug port is managed by Chromedriver; disable the main process's fixed 9229 used in dev mode,
// to avoid colliding with an already-open ZCode Dev on this machine, which causes a blank window and a stall during session creation.
process.env.ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT = "1";

let upstreamCaptureProxy: E2ENetworkCaptureProxy | null = null;
let upstreamReplayServer: UpstreamReplayServer | null = null;
let codingPlanTeamMockServer: Server | null = null;
let offPeakTeamGateway: { port: number; origin: string; close(): Promise<void> } | null = null;
let codingPlanTeamMockBaseUrl = "";
let codingPlanDataPlaneProxy: E2ENetworkCaptureProxy | null = null;
let codingPlanUpgradeMockServer: CodingPlanUpgradeMockServer | null = null;
let modelContextBudgetConfigMockServer: ModelContextBudgetConfigMockServer | null = null;
let dynamicWorkflowConfigMockServer: DynamicWorkflowConfigMockServer | null = null;
let clientScenesMockServer: ClientScenesMockServer | null = null;
let stopOAuthCompletionRaceFixture: (() => Promise<void>) | null = null;
let stopTtftOtlpFixture: (() => Promise<void>) | null = null;
let stopAccessToken401Fixture: (() => Promise<void>) | null = null;
let pluginCdnZipFixtureServer: PluginCdnZipFixtureServer | null = null;
let upstreamE2EBaseUrl: string = e2eProviderPreset.baseUrl;
let e2eRunnerExitWatchdog: ReturnType<typeof setTimeout> | null = null;
let currentE2EElectronAppPid: number | null = null;
let currentE2EWorkerSpecs: string[] = [];
let currentE2EBeforeSessionError: unknown = null;
let e2eFailureArtifacts: E2EFailureArtifactCollector | null = null;
let currentE2EWorkerSessionSpecs: string[] = [];
let currentE2EChromiumUserDataDir: string | null = null;
const e2eWorkerLifecycleStarts = new Map<string, { specs: string[]; startedAt: Date }>();

applyE2EProviderEnv();

async function measureE2ELifecyclePhase<T>(
  phase: E2ELifecyclePhase,
  context: { cid?: string; specs?: string[] },
  run: () => Promise<T> | T,
): Promise<T> {
  return await runMeasuredE2ELifecyclePhase(phase, context, e2eReporter.recordLifecycleEvent, run);
}

async function runE2EDiagnosticWithTimeout<T>(
  run: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(), timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function loadE2ELocalEnv() {
  for (const envFile of E2E_LOCAL_ENV_FILES) {
    if (!existsSync(envFile)) {
      continue;
    }

    const parsedEnv: Record<string, string> = {};
    const result = loadDotenv({
      path: envFile,
      processEnv: parsedEnv,
      quiet: true,
    });
    if (result.error) {
      throw new Error(`Failed to load e2e env file: ${envFile}`, {
        cause: result.error,
      });
    }
    for (const [key, value] of Object.entries(parsedEnv)) {
      if (!process.env[key]?.trim()) {
        process.env[key] = value;
      }
    }
  }
}

function readRequestedE2ESpecs() {
  const specs = new Set<string>();
  appendRequestedE2ESpecs(specs, process.env.ZCODE_E2E_SPEC);

  for (let index = 0; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (!arg) {
      continue;
    }
    if (arg === "--spec") {
      appendRequestedE2ESpecs(specs, process.argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--spec=")) {
      appendRequestedE2ESpecs(specs, arg.slice("--spec=".length));
    }
  }

  return [...specs];
}

function readRequestedE2EExcludeSpecs() {
  const specs = new Set<string>();
  appendRequestedE2ESpecs(specs, process.env.ZCODE_E2E_EXCLUDE_SPEC);

  for (let index = 0; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (!arg) {
      continue;
    }
    if (arg === "--exclude") {
      appendRequestedE2ESpecs(specs, process.argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--exclude=")) {
      appendRequestedE2ESpecs(specs, arg.slice("--exclude=".length));
    }
  }

  return [...specs];
}

function appendRequestedE2ESpecs(specs: Set<string>, value?: string) {
  if (!value?.trim()) {
    return;
  }

  // Fix reason: under `pnpm test:e2e -- --spec <file>` WDIO still loads the config first;
  // if the config only reads ZCODE_E2E_SPEC, it falls back to the full spec set, and multiple workers
  // resetting .e2e-home in turn would wipe out the upstream flash selection.
  for (const spec of value.split(",")) {
    const trimmed = spec.trim();
    if (trimmed) {
      specs.add(trimmed);
    }
  }
}

function readConfiguredUpstreamReplayFixturePaths() {
  const configured = process.env.E2E_PROVIDER_REPLAY_FIXTURE_PATH?.trim();
  if (!configured) {
    return null;
  }

  return configured
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => resolve(REPO_ROOT, item));
}

async function resolveUpstreamReplayFixturePaths(specs: string[] = []) {
  const configured = readConfiguredUpstreamReplayFixturePaths();
  const mode = readUpstreamReplayFixtureMode();
  return resolveUpstreamReplayFixturePathsFromContract({
    caseFixtureDir: UPSTREAM_CONVERSATION_SESSION_REPLAY_FIXTURE_DIR,
    caseManifestDir: UPSTREAM_CONVERSATION_SESSION_CASE_MANIFEST_DIR,
    commonFixturePath: UPSTREAM_COMMON_REPLAY_FIXTURE_PATH,
    configuredFixturePaths: configured,
    legacyFixturePaths: LEGACY_UPSTREAM_REPLAY_FIXTURE_PATHS,
    mode,
    pluginFixturePaths:
      configured || mode === "strict-case-local"
        ? []
        : await resolvePluginReplayFixturePaths({
            fixtureRoot: UPSTREAM_REPLAY_FIXTURE_ROOT,
            specs,
          }),
    specs,
  });
}

function readUpstreamReplayFixtureMode(): UpstreamReplayFixtureMode {
  const mode = process.env.E2E_PROVIDER_REPLAY_FIXTURE_MODE?.trim() || "compatible";
  if (mode === "compatible" || mode === "strict-case-local") {
    return mode;
  }
  throw new Error(
    `Unsupported E2E_PROVIDER_REPLAY_FIXTURE_MODE=${mode}. Expected compatible or strict-case-local.`,
  );
}

function readPositiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`);
  }
  return Math.floor(parsed);
}

function readUpstreamBaseUrlPart(part: "host" | "protocol") {
  if (!E2E_PROVIDER_UPSTREAM_BASE_URL) return "";
  const url = new URL(E2E_PROVIDER_UPSTREAM_BASE_URL);
  return part === "host" ? url.host : url.protocol.replace(/:$/u, "");
}

function readE2EProviderPresetName(): E2EProviderPresetName {
  const configured =
    process.env.E2E_PROVIDER_PRESET?.trim() || process.env.LLM_E2E_PROVIDER_PRESET?.trim();
  if (!configured) {
    // Default uses the upstream provider configured via environment variables (E2E_PROVIDER_BASE_URL / API_KEY / MODEL);
    // Fix reason: after a rebase the default once fell to GLM highspeed, which requested open.bigmodel.cn and was inconsistent with the manual acceptance path.
    return "env";
  }
  if (
    configured === "env" ||
    configured === "glmhighspeed" ||
    configured === "bigmodel53" ||
    configured === "stagingmodel"
  ) {
    return configured;
  }
  throw new Error(
    `Unsupported E2E_PROVIDER_PRESET=${configured}. ` +
      "Expected env, glmhighspeed, bigmodel53, or stagingmodel.",
  );
}

function resolveActiveE2EProviderEnv(specs: string[] = configuredE2ESpecs) {
  return {
    providerId: e2eProviderPreset.providerId,
    providerName: e2eProviderPreset.providerName,
    model: e2eProviderPreset.model,
    thoughtLevel: readE2EThoughtLevel(),
  };
}

function applyE2EProviderEnv(specs: string[] = configuredE2ESpecs) {
  const providerEnv = resolveActiveE2EProviderEnv(specs);
  process.env.E2E_PROVIDER_PRESET = e2eProviderPresetName;
  process.env.E2E_PROVIDER_ID = providerEnv.providerId;
  process.env.E2E_PROVIDER_NAME = providerEnv.providerName;
  process.env.E2E_PROVIDER_MODEL = providerEnv.model;
  process.env.E2E_PROVIDER_ALTERNATE_PROVIDER_ID = E2E_PROVIDER_ALTERNATE_PROVIDER_ID;
  process.env.E2E_PROVIDER_ALTERNATE_PROVIDER_NAME = E2E_PROVIDER_ALTERNATE_PROVIDER_NAME;
  process.env.E2E_PROVIDER_ALTERNATE_MODEL = E2E_PROVIDER_SECONDARY_MODEL;
  process.env.E2E_PROVIDER_THOUGHT_LEVEL = providerEnv.thoughtLevel;
  // Fix reason: runnerEnv is only guaranteed visible to WDIO spec processes; the Electron/Host startup chain inherits
  // the wdio config process's environment. Production control-plane choices for request-security capture and live-team are written only to runnerEnv,
  // so the Agent keeps accessing the test domain, and the live-team production JWT would trigger a 401.
  Object.assign(
    process.env,
    getE2EProviderEndpointEnv(specs, e2eProviderPresetName, upstreamE2EHttpMode),
  );
}

function readE2EThoughtLevel() {
  for (const envName of ["E2E_PROVIDER_THOUGHT_LEVEL", "LLM_E2E_THOUGHT_LEVEL"]) {
    if (process.env[envName] !== undefined) {
      return process.env[envName]?.trim() ?? "";
    }
  }
  return e2eProviderPreset.thoughtLevel;
}

function readUpstreamE2EHttpMode() {
  const mode = resolveUpstreamE2EHttpMode({
    explicitReplayFixture: Boolean(process.env.E2E_PROVIDER_REPLAY_FIXTURE_PATH?.trim()),
    manualReview: manualReviewE2E,
    requestedMode: requestedUpstreamE2EHttpMode,
  });
  process.env.E2E_PROVIDER_HTTP_MODE = mode;
  return mode;
}

function applyUpstreamE2EHttpModeForWorker(specs: string[]) {
  upstreamE2EHttpMode = resolveUpstreamE2EHttpModeForWorker({
    caseLocalReplayFixtureAvailable: hasUpstreamCaseLocalReplayFixtureForWorker({
      caseFixtureDir: UPSTREAM_CONVERSATION_SESSION_REPLAY_FIXTURE_DIR,
      specs,
    }),
    explicitReplayFixture: Boolean(process.env.E2E_PROVIDER_REPLAY_FIXTURE_PATH?.trim()),
    requestedMode: requestedUpstreamE2EHttpMode,
    specs,
  });
  // Bug cause: the combined run's global manual-review switch used to pin formal workers to
  // capture as well, so case-local replay hit the real model directly and produced false failures. The mode must be re-decided for each worker
  // before each Electron start, based on that worker's spec and fixture integrity.
  process.env.E2E_PROVIDER_HTTP_MODE = upstreamE2EHttpMode;
}

function applyAskUserQuestionClockScaleForWorker(specs: string[]) {
  const scale = resolveAskUserQuestionClockScaleForWorker({
    requestedScale: requestedAskUserQuestionClockScale,
    specs,
  });
  if (scale) {
    // Bug cause: this pending case's five-minute deadline depends on the test clock scale; when run alone it is
    // injected manually, and if the full-run worker does not inherit it, the product fails right at startup. Inject per spec and clean up in the
    // next worker, so the scaling does not leak into ordinary AskUserQuestion behavior.
    process.env[ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV] = scale;
  } else {
    delete process.env[ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV];
  }
}

function prepareDesktopAppBuild() {
  if (E2E_PACKAGED_APP_BINARY_PATH) {
    if (!existsSync(E2E_PACKAGED_APP_BINARY_PATH)) {
      throw new Error(`[e2e] packaged app binary missing: ${E2E_PACKAGED_APP_BINARY_PATH}`);
    }
    console.log(`[e2e] using packaged app: ${E2E_PACKAGED_APP_BINARY_PATH}`);
    return;
  }
  // Fix reason: the WDIO config is parsed by esbuild first; CI-executed strings must keep ASCII quotes.
  // The shard's mock port is allocated after the parent build; when a web mock is present, the compile-time origin must be rebuilt with the current port.
  if (shouldReuseDesktopE2EBuild(process.env)) {
    console.log("[e2e] ZCODE_E2E_SKIP_BUILD=1, skipping onPrepare build");
    assertDesktopE2EBuildReady("ZCODE_E2E_SKIP_BUILD=1");
    return;
  }
  // Bugfix: running `wdio run` directly bypasses package.json's pretest:e2e; checking only whether the
  // out file exists would run against an old renderer, showing up as "fixed but e2e still white-screens/does nothing".
  // So the WDIO entry always builds first, ensuring tests use desktop artifacts that match the current source.
  runPnpmWorkspaceCommand(["--filter", "@zcode/desktop", "build:no-runtime-assets"]);
  assertDesktopE2EBuildReady("onPrepare build");
}

function runPnpmWorkspaceCommand(
  args: string[],
  options?: { timeoutMs?: number; env?: Record<string, string> },
) {
  execFileSync(PNPM_COMMAND, args, {
    cwd: REPO_ROOT,
    env: { ...createPnpmChildEnv(), ...options?.env },
    stdio: "inherit",
    // Bug cause: prepare:remote-assets downloads the node binary on CI and builds several packages serially;
    // without a timeout, if the download or build hangs, wdio onPrepare keeps the dedicated runner occupied until the job
    // global timeout. This is only a generous anti-hang cap (a cold-cache full prepare takes about 10 minutes) and does not rate-limit;
    // other call sites (local builds) stay without a timeout.
    ...(options?.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    // Fix reason: on Windows runners `pnpm` comes from a cmd shim; calling execFileSync directly on "pnpm.cmd"
    // can fail with spawnSync EINVAL on some CI environments, so WDIO keeps starting Electron with missing or stale artifacts.
    shell: process.platform === "win32",
  });
}

function assertDesktopE2EBuildReady(context: string) {
  if (!existsSync(DESKTOP_BUILD_ENTRY_POINT)) {
    throw new Error(
      `[e2e] ${context}: desktop main entrypoint missing: ${DESKTOP_BUILD_ENTRY_POINT}`,
    );
  }

  if (!isRendererE2EStoreBridgeCompiled(E2E_RENDERER_ASSETS_DIR)) {
    throw new Error(`[e2e] ${context}: renderer build is missing VITE_ZCODE_E2E_STORE_BRIDGE=1`);
  }
}

async function stageDesktopE2EAppOutput() {
  await rm(E2E_APP_OUTPUT_DIR, { force: true, recursive: true });
  // Fix reason: dev-mode pre-dev/tsup watch rebuilds the shared packages/desktop/out; if a long batch starts directly from out,
  // the directory is emptied while running and later loadFile calls fall into chrome-error://. After the build completes,
  // copy the immutable app artifacts by runId, so E2E is fully isolated from parallel dev processes.
  // Use copy-on-write to lower preparation cost across shards; do not use hard links that share an inode, since a type check
  // that overwrites out/host in place would break the already-running isolated copies at the same time.
  await stageE2EAppOutput(DESKTOP_BUILD_OUTPUT_DIR, E2E_APP_OUTPUT_DIR);
  if (
    hasRequiredSshE2EEnvironment(process.env) ||
    process.env.ZCODE_E2E_SSH_HOST?.trim() ||
    process.env.ZCODE_E2E_SSH_A_HOST?.trim() ||
    process.env.ZCODE_E2E_SSH_B_HOST?.trim()
  ) {
    // Bug cause: CI only has the build:remote:assets job produce mock-cdn/releases/<version>, and it runs on the generic
    // macos runner slot; the conversation e2e runs on a dedicated runner, and the persistent mock-cdn workspace directories are not shared
    // with each other. After a version bump the dedicated runner always lacks the new release; a direct fatal would turn every upgrade into a
    // CI-only failure. Instead, when the directory is missing, run prepare:remote-assets automatically (idempotent) and fail only if it is still missing afterwards.
    // fail-closed。
    // Bug cause: packages/desktop's prepare:remote-assets was removed with the legacy asset pipeline,
    // `pnpm --filter @zcode/desktop prepare:remote-assets` fails with ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT,
    // making all SSH E2E fatal during onPrepare; it must call the root package.json's prepare:remote-assets
    // prepare:remote-assets（→ @zcode/server-cli stage:remote-assets）。runPnpmWorkspaceCommand
    // the cwd is fixed to REPO_ROOT, so passing just the script name hits the root script.
    // When the local Docker runner declares "Linux only", the helper reads the descriptor to judge the two Linux targets,
    // and only calls `ZCODE_ENV=test pnpm prepare:remote-assets:linux`; when undeclared, behavior is unchanged.
    await ensureSshRemoteReleaseAssets({
      releaseDir: E2E_REMOTE_RELEASE_SOURCE_DIR,
      scope: resolveSshRemoteReleaseScope(process.env),
      prepareReleaseAssets: (request) =>
        runPnpmWorkspaceCommand([request.script], {
          // Anti-hang cap: a cold-cache full prepare takes about 10 minutes; 30 minutes only pays off in a complete hang, so
          // onPrepare fails and exits; the normal slow path is unaffected.
          timeoutMs: 30 * 60 * 1000,
          env: request.env,
        }),
    });
    // Bug cause: dual-SSH cases only configure A/B targets; if only the common host is recognized here, the remote release built
    // from the current source is not placed in the runId-isolated directory, and the remote keeps reusing the old server bundle of the same version,
    // rejecting new fields such as enabledSource with the old protocol schema.
    await stageE2EAppOutput(E2E_REMOTE_RELEASE_SOURCE_DIR, E2E_REMOTE_RELEASE_OUTPUT_DIR);
  }
  if (!existsSync(E2E_APP_ENTRY_POINT)) {
    throw new Error(`[e2e] staged desktop main entrypoint missing: ${E2E_APP_ENTRY_POINT}`);
  }
  if (!isRendererE2EStoreBridgeCompiled(E2E_APP_RENDERER_ASSETS_DIR)) {
    throw new Error("[e2e] staged renderer is missing VITE_ZCODE_E2E_STORE_BRIDGE=1");
  }
}

function isRendererE2EStoreBridgeCompiled(rendererAssetsDir: string) {
  if (!existsSync(rendererAssetsDir)) {
    return false;
  }

  return readdirSync(rendererAssetsDir, { withFileTypes: true }).some((entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".js")) {
      return false;
    }

    const source = readFileSync(resolve(rendererAssetsDir, entry.name), "utf-8");
    return /["'\x60]?VITE_ZCODE_E2E_STORE_BRIDGE["'\x60]?\s*:\s*["'\x60]1["'\x60]/u.test(source);
  });
}

function createPnpmChildEnv() {
  // Bugfix: WDIO injects a tsx loader via NODE_OPTIONS to load the TypeScript config.
  // pnpm 11 inherits that loader and then mistakenly tries to load a .pnpmfile.mjs that does not exist at the repo root,
  // causing the onPrepare build to fail; the child pnpm only runs workspace scripts and does not need to inherit it.
  const { NODE_OPTIONS: _nodeOptions, ...env } = process.env;
  return {
    ...env,
    // Bugfix: WDIO changes HOME/USERPROFILE to isolate app data in .e2e-home,
    // but the onPrepare child pnpm needs the real user directory's corepack/nvm cache; otherwise, after CI cleans .e2e-home,
    // it cannot find the corepack-managed pnpm.mjs.
    ...(HOST_HOME_DIR ? { HOME: HOST_HOME_DIR } : {}),
    ...(HOST_USERPROFILE_DIR ? { USERPROFILE: HOST_USERPROFILE_DIR } : {}),
    // Bugfix: the agent build script enters the apps/zcode-cli sub-workspace; pnpm 11's
    // verify-deps-before-run triggers a sub-workspace install, but that workspace depends at runtime on the root @zcode/shared,
    // so the automatic install cannot resolve it; it must be turned off in the E2E build chain.
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
    // Fix reason: E2E depends on the renderer exposing the store bridge; it is injected explicitly only in the WDIO build chain,
    // so normal production/test builds do not accidentally expose a mutable global store.
    VITE_ZCODE_E2E_STORE_BRIDGE: "1",
    ZCODE_DESKTOP_AGENT_BUILD_MODE: env.ZCODE_DESKTOP_AGENT_BUILD_MODE ?? "pnpm",
  };
}

function prepareZCodeAgentServer() {
  if (E2E_PACKAGED_APP_BINARY_PATH) {
    // The real Preview package must use the bundled Agent; test runners must not inject a source entry point to hide missing packaging.
    configureZCodeAgentServerEnv();
    return;
  }
  if (process.env.ZCODE_E2E_SKIP_AGENT_BUILD === "1") {
    // Fix reason: in Windows full-E2E shards the parent runner builds the agent once; if each child WDIO builds again,
    // they concurrently overwrite the same dist directory. When skipping, still verify the entry so stale or missing artifacts do not start silently.
    console.log("[e2e] ZCODE_E2E_SKIP_AGENT_BUILD=1, skipping agent build");
    if (!existsSync(ZCODE_CLI_ENTRYPOINT)) {
      throw new Error(`ZCode CLI entrypoint not found: ${ZCODE_CLI_ENTRYPOINT}`);
    }
    configureZCodeAgentServerEnv();
    return;
  }

  // Bugfix: e2e was still looking for an old native zcode-agent binary outside the repo and calling the deleted
  // `build:agent-exe`. The desktop now exposes the ZCode Protocol uniformly through zcode-cli's app-server JS bundle;
  // here we reuse the official dev-entry build script, after which the bundled resolver
  // selects the validated bundle, keeping the storage preparation capability and the formal desktop startup contract.
  execFileSync(process.execPath, [BUILD_DESKTOP_AGENT_SCRIPT], {
    cwd: REPO_ROOT,
    env: createPnpmChildEnv(),
    stdio: "inherit",
  });

  if (!existsSync(ZCODE_CLI_ENTRYPOINT)) {
    throw new Error(`ZCode CLI entrypoint not found: ${ZCODE_CLI_ENTRYPOINT}`);
  }

  configureZCodeAgentServerEnv();
}

function configureZCodeAgentServerEnv() {
  // Database preparation trusts only the entry point confirmed by the bundled resolver. Even if E2E puts this run's bundle into a custom
  // command, it is rejected with unsupported_runtime; clear the inherited override and reuse the formal desktop resolution chain.
  delete process.env.ZCODE_AGENT_SERVER_COMMAND;
  delete process.env.ZCODE_AGENT_SERVER_ARGS_JSON;
  delete process.env.ZCODE_AGENT_SERVER_CWD;
}

function assertUpstreamCaptureConfig() {
  if (!e2eProviderPreset.baseUrl) {
    throw new Error(
      `E2E_PROVIDER_HTTP_MODE=capture with ${e2eProviderPresetName} requires E2E_PROVIDER_BASE_URL.`,
    );
  }
  const apiKey = readE2EProviderApiKey();
  if (apiKey && apiKey !== "xxx") {
    return;
  }

  // Fix reason: default e2e has switched to fixture replay; only an explicit capture actually hits the real
  // upstream. When capturing fixtures, validate the real key up front, to avoid freezing a failed response into the repo.
  throw new Error(
    `E2E_PROVIDER_HTTP_MODE=capture with ${e2eProviderPresetName} requires one of: ${e2eProviderPreset.apiKeyEnvNames.join(", ")}.`,
  );
}

function readE2EProviderApiKey() {
  for (const envName of e2eProviderPreset.apiKeyEnvNames) {
    const value = process.env[envName]?.trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function ensureUpstreamReplayConfig() {
  process.env.E2E_PROVIDER_API_KEY = E2E_PROVIDER_REPLAY_API_KEY;
}

async function startUpstreamE2EHttp(specs: string[] = []) {
  await stopUpstreamE2EHttp();
  if (
    upstreamE2EHttpMode === "capture" ||
    specs.some((spec) => spec.includes("conversation-session-toolsearch"))
  ) {
    applyE2EWorkerReplayProxyEnv(process.env, [], "", configuredE2EWorkerNetworkEnv);
    await startUpstreamCaptureProxy(specs);
    return;
  }

  ensureUpstreamReplayConfig();
  upstreamReplayServer = await startUpstreamReplayServer({
    artifactPath: UPSTREAM_CAPTURE_ARTIFACT_PATH,
    fixtureVariables: createE2EReplayFixtureVariables(E2E_HOME_DIR),
    fixturePaths: await resolveUpstreamReplayFixturePaths(specs),
  });
  upstreamE2EBaseUrl = upstreamReplayServer.baseUrl;
  process.env.E2E_PROVIDER_CAPTURE_MODE = "replay";
  process.env.E2E_PROVIDER_CAPTURE_PATH = upstreamReplayServer.artifactPath;
  process.env.E2E_PROVIDER_CAPTURE_PROXY_URL = upstreamReplayServer.baseUrl;
  process.env.E2E_PROVIDER_EXPECTED_HOST = `${upstreamReplayServer.host}:${upstreamReplayServer.port}`;
  process.env.E2E_PROVIDER_EXPECTED_PROTOCOL = "http";
  process.env.E2E_PROVIDER_RUNTIME_BASE_URL = upstreamReplayServer.baseUrl;
  process.env.NO_PROXY = DEFAULT_E2E_NETWORK_CAPTURE_NO_PROXY;
  process.env.no_proxy = DEFAULT_E2E_NETWORK_CAPTURE_NO_PROXY;
  applyE2EWorkerReplayProxyEnv(
    process.env,
    specs,
    upstreamReplayServer.baseUrl,
    configuredE2EWorkerNetworkEnv,
  );
  writeUpstreamE2ERuntimeFile("replay", upstreamReplayServer.baseUrl);
}

function shouldUseCodingPlanTeamMock(specs: string[] = []) {
  return shouldPrepareCodingPlanTeamMock(specs);
}

async function startCodingPlanTeamMockIfNeeded(specs: string[] = []) {
  if (!shouldUseCodingPlanTeamMock(specs)) {
    await stopCodingPlanTeamMock();
    return;
  }

  const preparedBaseUrl = process.env[CODING_PLAN_TEAM_MOCK_BASE_URL_ENV]?.trim();
  if (!codingPlanTeamMockServer && preparedBaseUrl) {
    // Bugfix: probe before adopting. If the launcher inherited a leftover dead URL from the shell, or the worker's
    // runnerEnv points to an already-exited launcher server, silently adopting it would make the control plane and data plane lose connectivity together.
    if (await isCodingPlanTeamMockAlive(preparedBaseUrl)) {
      codingPlanTeamMockBaseUrl = preparedBaseUrl;
      applyCodingPlanTeamMockEnv(process.env, preparedBaseUrl);
      return;
    }
    delete process.env[CODING_PLAN_TEAM_MOCK_BASE_URL_ENV];
  }
  if (codingPlanTeamMockServer) {
    applyCodingPlanTeamMockEnv(process.env, codingPlanTeamMockBaseUrl);
    return;
  }
  if (process.env.WDIO_WORKER_ID !== undefined) {
    // Fail fast: a server newly started inside the worker is reachable only by test code, while Electron/Host still point to the
    // launcher address allocated in onPrepare (see the onPrepare comment). Reaching here means runnerEnv
    // does not carry a live mock address; silently degrading would only make waitForMockRequest timeouts harder to diagnose.
    throw new Error(
      "coding plan reset mock 未在 onPrepare 准备（runnerEnv 缺少存活的 ZCODE_E2E_CODING_PLAN_MOCK_URL）",
    );
  }

  let caseMode:
    | "default"
    | typeof SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE
    | "model-provider-plan-surface" = "default";
  let subagentOAuthTokenIssued = false;
  let modelProviderCatalogMode: "full" | "partial" | "unavailable" = "full";
  let presentation: EntitlementPresentation | undefined;
  let scenario: "personalOnly" | "teamOnly" | "both" = "both";
  // Bug regression: the Start Plan standalone case needs billing/balance to return Start Plan entitlements and models,
  // so the trial plan and Coding Plan coexist for real from first launch; the mock is created only once in onPrepare,
  // so this mode must be fixed at creation time; later workers share the same server state.
  const startIndependent = workerSpecsContain(
    specs,
    "conversation-session-start-plan-independent.test.ts",
  );
  const offPeakTeam = isOffPeakTeamPlanSpec(specs);
  if (offPeakTeam) {
    // The generic product mock replaces it with personal fake credentials, which cannot verify Team. Only the test process substitutes the HTTP server.
    const { startOffPeakMockGateway, createServiceLogger } = await import("@zcode/services/node");
    offPeakTeamGateway = await startOffPeakMockGateway(
      {
        logger: createServiceLogger("e2e-offpeak-team", { isDebugEnabled: false }),
        resolveUpstream: async () => {
          throw new Error("Team E2E 不允许访问真实上游");
        },
      },
      {
        port: 0,
        readyDelayMs: 0,
        readyTtlMs: 600000,
        activeMs: 600000,
        scenario: "foreground-subagents",
      },
    );
    process.env.ZCODE_OFFPEAK_MOCK_PORT = String(offPeakTeamGateway.port);
  }
  let providerResponsive = startIndependent;
  let faultMode:
    | "none"
    | "optionalActivity"
    | "quotaBusinessFailure"
    | "quotaFailure"
    | "startBalance"
    | "startBalanceFailure"
    | "unavailableTeam"
    | "expiredTeam"
    | "twoTeams" = "none";
  let resetScenario:
    | "none"
    | "emptyThenGrant"
    | "existingMultiple"
    | "fiveHourUse"
    | "multiFiveHourUse"
    | "multiFiveHourUseLagging"
    | "urgentOpportunity" = "none";
  let resetScenarioStartedAt = Date.now();
  let resetOpportunityGranted = false;
  let resetUseAccepted = false;
  let resetUseConfirmed = false;
  // Bugfix: used_at must be latched at the moment of confirmation. If each /status returned a new Date.now(),
  // the client would treat every poll as a new completion, repeating history/read, forcing an entitlement refresh, or replaying the animation.
  let resetUsedAt: number | null = null;
  // multiFiveHourUse (QR-E2E-14): FIVE_HOUR holds 2 chances, and /use immediately consumes the earliest one (no confirm
  // step). Counting is idempotent by idempotency_key, consistent with the real server: a client resending an old key does not consume another one.
  const resetMultiUsedKeys = new Set<string>();
  let resetMultiUnread = false;
  // multiFiveHourUseLagging (QR-E2E-15): on top of multiFiveHourUse, the /use consumption result is delayed
  // by RESET_USE_VISIBLE_LAG_MS before it becomes visible in /status; within that window /status returns the pre-consumption snapshot (the previous used_at).
  const RESET_USE_VISIBLE_LAG_MS = 600;
  let resetMultiLag: {
    usedAt: number | null;
    usedCount: number;
    unread: boolean;
    visibleAt: number;
  } | null = null;
  const requests: Array<{
    body?: unknown;
    headers: Record<string, string | string[] | undefined>;
    method: string;
    path: string;
    query: Record<string, string>;
  }> = [];
  const shareMockRoute = createConversationShareMockRoute();
  codingPlanTeamMockServer = createServer(async (request, response) => {
    if (await shareMockRoute(request, response)) return;
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (offPeakTeamGateway && url.pathname.startsWith("/api/v1/off-peak/")) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const headers = Object.fromEntries(
        Object.entries(request.headers).flatMap(([key, value]) =>
          typeof value === "string" && !["host", "connection", "content-length"].includes(key)
            ? [[key, value]]
            : [],
        ),
      );
      const upstream = await fetch(new URL(request.url!, offPeakTeamGateway.origin), {
        method: request.method,
        headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      response.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }
    if (url.pathname === "/__e2e/coding-plan/case-mode" && request.method === "POST") {
      presentation = undefined;
      const body = await readRequestJson<{ mode?: typeof caseMode }>(request);
      caseMode =
        body.mode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE
          ? SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE
          : body.mode === "model-provider-plan-surface"
            ? "model-provider-plan-surface"
            : "default";
      subagentOAuthTokenIssued = false;
      modelProviderCatalogMode = "full";
      scenario =
        caseMode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE ? "personalOnly" : "both";
      faultMode = "none";
      resetScenario = "none";
      resetScenarioStartedAt = Date.now();
      resetOpportunityGranted = false;
      resetUseAccepted = false;
      resetUseConfirmed = false;
      resetUsedAt = null;
      resetMultiUsedKeys.clear();
      resetMultiUnread = false;
      resetMultiLag = null;
      requests.length = 0;
      writeJson(response, { mode: caseMode, ok: true });
      return;
    }
    if (url.pathname === "/__e2e/coding-plan/team-health" && request.method === "GET") {
      writeJson(response, { ok: true, mock: "team" });
      return;
    }

    if (url.pathname === "/__e2e/coding-plan/catalog-mode" && request.method === "POST") {
      const body = await readRequestJson<{ mode?: string }>(request);
      if (body.mode !== "full" && body.mode !== "partial" && body.mode !== "unavailable") {
        writeJson(response, { code: 400, msg: "invalid catalog mode" }, 400);
        return;
      }
      modelProviderCatalogMode = body.mode;
      writeJson(response, { mode: modelProviderCatalogMode, ok: true });
      return;
    }

    if (url.pathname === "/__e2e/coding-plan/scenario" && request.method === "POST") {
      const body = await readRequestJson<{
        scenario?: typeof scenario;
        faultMode?: typeof faultMode;
        providerResponsive?: boolean;
        presentation?: EntitlementPresentation;
      }>(request);
      providerResponsive = body.providerResponsive === true;
      presentation = body.presentation;
      if (
        body.scenario === "personalOnly" ||
        body.scenario === "teamOnly" ||
        body.scenario === "both"
      ) {
        scenario = body.scenario;
      }
      faultMode =
        body.faultMode === "optionalActivity" ||
        body.faultMode === "quotaBusinessFailure" ||
        body.faultMode === "quotaFailure" ||
        body.faultMode === "startBalance" ||
        body.faultMode === "unavailableTeam" ||
        body.faultMode === "expiredTeam" ||
        body.faultMode === "twoTeams" ||
        body.faultMode === "startBalanceFailure"
          ? body.faultMode
          : "none";
      requests.length = 0;
      writeJson(response, { faultMode, ok: true, scenario });
      return;
    }
    if (url.pathname === "/__e2e/coding-plan/reset-scenario" && request.method === "POST") {
      const body = await readRequestJson<{
        resetScenario?: typeof resetScenario;
      }>(request);
      resetScenario =
        body.resetScenario === "emptyThenGrant" ||
        body.resetScenario === "existingMultiple" ||
        body.resetScenario === "fiveHourUse" ||
        body.resetScenario === "multiFiveHourUse" ||
        body.resetScenario === "multiFiveHourUseLagging" ||
        body.resetScenario === "urgentOpportunity"
          ? body.resetScenario
          : "none";
      resetOpportunityGranted = false;
      resetScenarioStartedAt = Date.now();
      resetUseAccepted = false;
      resetUseConfirmed = false;
      resetUsedAt = null;
      resetMultiUsedKeys.clear();
      resetMultiUnread = false;
      resetMultiLag = null;
      requests.length = 0;
      writeJson(response, { ok: true, resetScenario });
      return;
    }
    if (url.pathname === "/__e2e/coding-plan/reset-confirm-use" && request.method === "POST") {
      resetUseConfirmed = true;
      resetUsedAt ??= Date.now();
      writeJson(response, { ok: true });
      return;
    }
    if (url.pathname === "/__e2e/coding-plan/requests") {
      writeJson(response, { ok: true, requests });
      return;
    }

    const isResetMutation =
      request.method === "POST" &&
      (url.pathname.endsWith("/coding-plan/reset/opportunity") ||
        url.pathname.endsWith("/coding-plan/reset/use"));
    const requestBody = isResetMutation ? await readRequestJson<unknown>(request) : undefined;
    requests.push({
      ...(requestBody === undefined ? {} : { body: requestBody }),
      headers: {
        // The dual-JWT contract of the four reset interfaces (Authorization=zcode JWT / X-Bigmodel-Authorization=MaaS JWT)
        // is asserted by the cases, so it must be recorded as well.
        authorization: request.headers.authorization,
        "bigmodel-organization": request.headers["bigmodel-organization"],
        "bigmodel-project": request.headers["bigmodel-project"],
        "x-bigmodel-authorization": request.headers["x-bigmodel-authorization"],
      },
      method: request.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
    });

    if (presentation) {
      const fixture = presentationResponse(url.pathname, presentation);
      if (fixture) {
        writeJson(response, fixture);
        return;
      }
    }

    if (
      caseMode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE &&
      request.method === "POST" &&
      url.pathname === "/api/v1/oauth/cli/init"
    ) {
      writeJson(response, {
        code: 0,
        data: {
          authorize_url: `https://bigmodel.cn/login?appId=zcode&redirect=${encodeURIComponent("https://zcode.z.ai/api/v1/oauth/cli/callback/bigmodel")}&state=${SUBAGENT_CODING_PLAN_OAUTH_STATE}`,
          expires_at: Math.floor(Date.now() / 1000) + 300,
          flow_id: SUBAGENT_CODING_PLAN_OAUTH_FLOW_ID,
          poll_interval_sec: 30,
        },
        msg: "",
      });
      return;
    }

    if (caseMode === "model-provider-plan-surface" && request.method === "GET") {
      if (url.pathname === "/api/v2/releases/latest") {
        writeJson(response, {
          config_version: "e2e-model-provider-catalog-v1",
          version: "3.8.1-e2e",
        });
        return;
      }
      if (url.pathname === "/api/v1/client/configs") {
        if (modelProviderCatalogMode === "unavailable") {
          writeJson(
            response,
            { code: 503, data: null, msg: "catalog temporarily unavailable" },
            503,
          );
          return;
        }
        // Reason: the model catalog and the team plan catalog are two separate facts; without the plan static catalog, Composer
        // hides subscribed teams while Automation's raw Registry menu still shows them.
        const catalogPayload = {
          ...MODEL_PROVIDER_CATALOG_PAYLOAD,
          data: {
            ...MODEL_PROVIDER_CATALOG_PAYLOAD.data,
            configs: {
              ...requestSecurityClientConfig(),
              codingPlanStaticTeamProducts: {
                [BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan]: [
                  {
                    productId: "product-team-a",
                    productName: "Team",
                    tier: "PRO",
                    subscribeMode: "CONTINUOUS",
                    subscribePeriod: "MONTHLY",
                    purchaseMethodName: "Monthly",
                    priceCurrency: "CNY",
                    payAmount: 598,
                  },
                ],
              },
            },
          },
        };
        if (modelProviderCatalogMode === "partial") {
          writeJson(response, {
            ...catalogPayload,
            data: {
              ...catalogPayload.data,
              builtinModels: catalogPayload.data.builtinModels.slice(0, 1),
              builtinProviders: catalogPayload.data.builtinProviders.slice(0, 1),
            },
          });
          return;
        }
        writeJson(response, catalogPayload);
        return;
      }
    }

    if (
      caseMode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE &&
      request.method === "GET" &&
      url.pathname === `/api/v1/oauth/cli/poll/${SUBAGENT_CODING_PLAN_OAUTH_FLOW_ID}`
    ) {
      writeJson(response, {
        code: 0,
        data: { status: "pending" },
        msg: "",
      });
      return;
    }

    if (
      caseMode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE &&
      request.method === "POST" &&
      url.pathname === "/api/v1/oauth/token"
    ) {
      subagentOAuthTokenIssued = true;
      writeJson(response, {
        code: 0,
        data: {
          token: "e2e-subagent-login-zcode-jwt",
          bigmodel: {
            access_token: "e2e-subagent-login-bigmodel-token",
            refresh_token: "e2e-subagent-login-bigmodel-refresh-token",
          },
        },
        msg: "",
      });
      return;
    }

    if (
      caseMode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE &&
      request.method === "GET" &&
      url.pathname === "/api/v2/releases/latest"
    ) {
      writeJson(response, {
        config_version: resolveSubagentLoginCatalogConfigVersion(subagentOAuthTokenIssued),
        version: "3.8.1-e2e",
      });
      return;
    }

    if (
      caseMode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE &&
      request.method === "GET" &&
      url.pathname === "/api/v1/client/configs"
    ) {
      writeJson(
        response,
        resolveSubagentLoginCatalogPayload({
          configVersion: url.searchParams.get("config_version"),
          oauthTokenIssued: subagentOAuthTokenIssued,
        }),
      );
      return;
    }

    if (
      faultMode === "startBalanceFailure" &&
      url.pathname === "/api/v1/zcode-plan/billing/balance"
    ) {
      writeJson(response, { code: 429, msg: "Too many requests" }, 429);
      return;
    }

    if (
      providerResponsive &&
      request.method === "GET" &&
      url.pathname === "/api/v1/zcode-plan/billing/balance"
    ) {
      writeJson(
        response,
        // Recommendation depends on the target model's real quota; keep it consistent with the current model used by SIP.
        buildProviderResponsiveStartBalance(startIndependent ? "GLM-5.3" : undefined),
      );
      return;
    }

    if (
      caseMode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE &&
      request.method === "GET" &&
      url.pathname === "/api/v1/zcode-plan/billing/balance"
    ) {
      writeJson(response, {
        code: 0,
        data: { balances: [], plans: [] },
        msg: "",
        success: true,
      });
      return;
    }

    if (
      caseMode === "model-provider-plan-surface" &&
      request.method === "GET" &&
      url.pathname === "/api/v1/zcode-plan/billing/balance"
    ) {
      // The plan cross-case needs a deterministic Start Plan entitlement; ordinary Coding Plan cases still decide by
      // their own subscription interface, so Start entitlements do not leak into other specs.
      // Plan metadata alone, without model quota, does not form an executable Start candidate.
      writeJson(response, buildProviderResponsiveStartBalance("GLM-5.2"));
      return;
    }

    if (url.pathname === "/api/v1/coding-plan/reset/status") {
      if (resetScenario === "multiFiveHourUse" || resetScenario === "multiFiveHourUseLagging") {
        const lag =
          resetMultiLag !== null && Date.now() < resetMultiLag.visibleAt ? resetMultiLag : null;
        const usedCount = lag ? lag.usedCount : resetMultiUsedKeys.size;
        const usedAt = lag ? lag.usedAt : resetUsedAt;
        writeJson(response, {
          code: 0,
          data: {
            available_five_hour_resets: [
              { expire_at: resetScenarioStartedAt + 3_600_000 },
              { expire_at: resetScenarioStartedAt + 7_200_000 },
            ].slice(usedCount),
            available_week_resets: [{ expire_at: resetScenarioStartedAt + 86_400_000 }],
            latest_five_hour_reset_history:
              usedCount > 0 && usedAt !== null ? { used_at: usedAt } : null,
            latest_week_reset_history: null,
            has_unread_history: lag ? lag.unread : resetMultiUnread,
          },
        });
        return;
      }
      const useConfirmed = resetUseAccepted && resetUseConfirmed;
      const hasGrantedOpportunity = resetScenario !== "emptyThenGrant" || resetOpportunityGranted;
      const availableFiveHourResets =
        resetScenario === "none" || !hasGrantedOpportunity || useConfirmed
          ? []
          : resetScenario === "existingMultiple"
            ? [
                { expire_at: resetScenarioStartedAt + 3_600_000 },
                { expire_at: resetScenarioStartedAt + 7_200_000 },
              ]
            : resetScenario === "urgentOpportunity"
              ? // E2E mock must remain urgent after the Electron restart/build barrier;
                // anchoring to scenario setup made the opportunity expire before the
                // renderer finished its first status poll on slower Air runs.
                [{ expire_at: Date.now() + 120_000 }]
              : [{ expire_at: resetScenarioStartedAt + 3_600_000 }];
      const availableWeekResets =
        resetScenario === "existingMultiple" || resetScenario === "fiveHourUse"
          ? [{ expire_at: resetScenarioStartedAt + 86_400_000 }]
          : [];
      writeJson(response, {
        code: 0,
        data: {
          available_five_hour_resets: availableFiveHourResets,
          available_week_resets: availableWeekResets,
          latest_five_hour_reset_history:
            useConfirmed && resetUsedAt !== null ? { used_at: resetUsedAt } : null,
          latest_week_reset_history: null,
          has_unread_history: useConfirmed,
        },
      });
      return;
    }

    if (url.pathname === "/api/v1/coding-plan/reset/opportunity") {
      const granted = resetScenario === "emptyThenGrant" || resetScenario === "existingMultiple";
      resetOpportunityGranted ||= granted;
      writeJson(response, {
        code: granted ? 0 : 3301,
        data: granted ? { granted: true } : { granted: false, next_try_at: Date.now() + 60_000 },
      });
      return;
    }

    if (url.pathname === "/api/v1/coding-plan/reset/use") {
      if (resetScenario === "multiFiveHourUse" || resetScenario === "multiFiveHourUseLagging") {
        const idempotencyKey = (requestBody as { idempotency_key?: unknown } | null | undefined)
          ?.idempotency_key;
        if (
          typeof idempotencyKey === "string" &&
          idempotencyKey &&
          !resetMultiUsedKeys.has(idempotencyKey)
        ) {
          if (resetScenario === "multiFiveHourUseLagging") {
            resetMultiLag = {
              usedAt: resetUsedAt,
              usedCount: resetMultiUsedKeys.size,
              unread: resetMultiUnread,
              visibleAt: Date.now() + RESET_USE_VISIBLE_LAG_MS,
            };
          }
          resetMultiUsedKeys.add(idempotencyKey);
          // used_at must strictly increase: the client recognizes "completed another time" by a change in used_at.
          resetUsedAt = Math.max(Date.now(), (resetUsedAt ?? 0) + 1);
          resetMultiUnread = true;
        }
        writeJson(response, { code: 0, data: { used: true } });
        return;
      }
      resetUseAccepted = true;
      resetUseConfirmed = false;
      writeJson(response, { code: 0, data: { used: true } });
      return;
    }

    if (url.pathname === "/api/v1/coding-plan/reset/history/read") {
      resetMultiUnread = false;
      writeJson(response, { code: 0, data: null });
      return;
    }

    // Composer switching refreshes Built-in; the default download address keeps the catalog seeded in this round and must not return 404.
    if (url.pathname === "/api/v1/client/configs") {
      writeJson(response, {
        code: 0,
        success: true,
        data: {
          configs: {
            ...requestSecurityClientConfig(),
            ...(offPeakTeam ? { offPeak: { enable_offpeak_task: true } } : {}),
          },
        },
      });
      return;
    }
    if (url.pathname === "/api/v1/agent/configs") {
      writeJson(response, {
        code: 0,
        data: requestSecurityAgentConfig(),
      });
      return;
    }

    if (url.pathname === "/api/anthropic/v1/messages") {
      const body = JSON.stringify(await readRequestJson(request));
      response.writeHead(200, codingPlanDefaultDataPlaneResponse.headers(body));
      response.end(codingPlanDefaultDataPlaneResponse.body(body));
      return;
    }

    if (url.pathname === "/api/biz/subscription/enterprise/v2/pricing") {
      writeJson(response, {
        code: 200,
        data: {
          productList:
            scenario === "personalOnly"
              ? []
              : [
                  {
                    productId: "product-team-a",
                    tier: "PRO",
                    subscribeMode: "CONTINUOUS",
                    subscribePeriod: "MONTHLY",
                    purchaseMethodName: "连续包月",
                    subscribed: true,
                  },
                ],
        },
      });
      return;
    }

    if (url.pathname === "/api/biz/customer/getCustomerInfo") {
      writeJson(response, {
        code: 200,
        data: {
          ...(caseMode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE
            ? {
                avatar: "",
                customerName: "Subagent Login E2E",
                customerNumber: "subagent-login-e2e-user",
                nickName: "Subagent Login E2E",
              }
            : {}),
          organizations: [
            ...(["expiredTeam", "twoTeams"].includes(faultMode)
              ? [
                  {
                    organizationId: "org-team-b",
                    organizationName: "Active Team",
                    projects: [{ projectId: "proj-team-b", projectName: "Team B", projectType: 2 }],
                  },
                ]
              : []),
            ...(faultMode === "unavailableTeam"
              ? [
                  {
                    organizationId: "org-unavailable",
                    organizationName: "Unavailable Team",
                    projects: [
                      { projectId: "proj-unavailable", projectName: "Unavailable", projectType: 2 },
                    ],
                  },
                ]
              : []),
            {
              organizationId: "org-team-a",
              organizationName: providerResponsive ? PROVIDER_RESPONSIVE_TEAM_NAME : "Team Org",
              projects: [
                ...(scenario !== "teamOnly" ||
                caseMode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE ||
                caseMode === "model-provider-plan-surface"
                  ? [
                      {
                        projectId: "proj-personal-a",
                        projectName: "Personal Project",
                        projectType: 1,
                      },
                    ]
                  : []),
                {
                  projectId: "proj-team-a",
                  projectName: "Team A",
                  projectType: 2,
                },
              ],
            },
          ],
        },
      });
      return;
    }

    if (request.method === "POST" && url.pathname.endsWith("/access_tokens")) {
      // Reason: the account Provider has switched to project tokens; the old fixture returned only a long-lived Key, so personal entitlements stayed unknown.
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const expiresAt = Math.floor(Date.now() / 1000) + 600;
      const token = `${encode({ alg: "HS256", typ: "JWT", sign_type: "SIGN" })}.${encode({ token_use: "project_access", api_key: "e2e-key", exp: expiresAt })}.e2e-signature`;
      writeJson(response, {
        code: 200,
        data: { enable: true, accessToken: token, tokenType: "Bearer", expiresIn: 600, expiresAt },
      });
      return;
    }

    if (url.pathname.endsWith("/api_keys")) {
      // Bug cause: after the Provider refactor, personal Coding Plan resolves the personal project
      // project key from customerInfo. The old mock returned the Team key based only on the global scenario, so even when the both scenario explicitly selected
      // the personal Provider it could not get the matching credential. The fixture must return keys by project identity, as the server does.
      const personal = url.pathname.includes("/projects/proj-personal-a/");
      if (faultMode === "unavailableTeam" && url.pathname.includes("/projects/proj-unavailable/")) {
        writeJson(
          response,
          request.method === "POST"
            ? { code: 200, success: false, msg: "暂无有效的团队套餐授权记录", data: null }
            : { code: 200, data: [] },
        );
        return;
      }
      writeJson(response, {
        code: 200,
        data: [
          {
            apiKey: personal ? "personal-ak" : "team-ak",
            keyType: personal ? 1 : 2,
            name: personal ? "zcode-api-key" : "zcode-team-api-key",
          },
        ],
      });
      return;
    }

    if (
      request.method === "POST" &&
      /^\/api\/biz\/v1\/organization\/org-team-a\/projects\/proj-(personal|team)-a\/api_keys\/(personal|team)-ak\/access_tokens$/.test(
        url.pathname,
      )
    ) {
      // Project auth has switched to short-lived tokens; without a signing response, the model catalog would be judged unavailable before the tool request.
      const body = await readRequestJson<{ clientType?: string }>(request);
      if (body.clientType !== "zcode" || !request.headers.authorization?.startsWith("Bearer ")) {
        writeJson(response, { code: 400, msg: "invalid_token_request" }, 400);
        return;
      }
      const expiresIn = 600;
      const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const token = `${encode({ alg: "HS256", typ: "JWT", sign_type: "SIGN" })}.${encode({ token_use: "project_access", api_key: "e2e-key", exp: expiresAt })}.e2e-signature`;
      writeJson(response, {
        code: 200,
        data: { enable: true, accessToken: token, tokenType: "Bearer", expiresIn, expiresAt },
      });
      return;
    }

    if (
      url.pathname.endsWith("/api_keys/copy/team-ak") ||
      url.pathname.endsWith("/api_keys/copy/personal-ak")
    ) {
      const personal = url.pathname.endsWith("/api_keys/copy/personal-ak");
      writeJson(response, {
        code: 200,
        data: { secretKey: personal ? "personal-secret" : "team-secret" },
      });
      return;
    }

    if (url.pathname === "/api/biz/team/subscribe/product/querySubscribeDetail") {
      writeJson(response, {
        code: 200,
        success: true,
        data:
          scenario === "personalOnly"
            ? { hasSubscription: false }
            : {
                hasSubscription: true,
                status:
                  faultMode === "expiredTeam" &&
                  request.headers["bigmodel-project"] !== "proj-team-b"
                    ? "EXPIRED"
                    : "EFFECTIVE",
                memberGrantStatus: "VALID",
                productId: "product-team-a",
                productName: "Team Org",
                subscribeEndTime: "2027-08-25",
                subscribePeriod: "YEARLY",
              },
      });
      return;
    }

    if (url.pathname === "/api/biz/subscription/list") {
      writeJson(response, {
        code: 200,
        data:
          scenario === "teamOnly"
            ? []
            : [
                {
                  productId: "personal-coding",
                  productName: "Coding Plan",
                  // Bugfix: provider availability validation requires the subscription to be within its validity period; supplying only renewTime is judged as having no personal entitlement.
                  inCurrentPeriod: true,
                  status: "VALID",
                  renewTime: "2026-08-01T00:00:00.000Z",
                },
              ],
      });
      return;
    }

    if (url.pathname === "/api/monitor/usage/quota/limit") {
      if (faultMode === "quotaBusinessFailure") {
        // CTP-11 phase one uses a business failure to generate a provider/unavailable snapshot, verifying that the entry is stable;
        // the subsequent detail fatal then explicitly switches to quotaFailure, so the two semantics do not overwrite each other.
        writeJson(response, { code: 500, msg: "e2e quota business failure" });
        return;
      }
      if (faultMode === "quotaFailure") {
        writeJson(response, { code: 500, msg: "e2e quota transport failure" }, 500);
        return;
      }
      const isTeam = url.searchParams.get("type") === "2";
      const hasPlan = isTeam ? scenario !== "personalOnly" : scenario !== "teamOnly";
      if (!hasPlan) {
        writeJson(response, {
          code: 500,
          success: false,
          msg: "当前用户不存在coding plan",
        });
        return;
      }
      writeJson(response, {
        code: 200,
        data: {
          level: isTeam ? "team" : "pro",
          limits: [
            {
              type: "TOKENS_LIMIT",
              unit: 3,
              number: 5,
              remaining: isTeam ? 900 : 700,
              percentage: isTeam ? 10 : 30,
              nextResetTime: Date.UTC(2026, 6, 4, 10, 0),
            },
            {
              type: "TOKENS_LIMIT",
              unit: 6,
              remaining: isTeam ? 8000 : 6000,
              percentage: isTeam ? 20 : 40,
              nextResetTime: Date.UTC(2026, 6, 10, 0, 0),
            },
          ],
        },
      });
      return;
    }

    if (url.pathname === "/api/monitor/credit-usage/activity") {
      if (faultMode === "optionalActivity") {
        writeJson(response, { code: 500, msg: "e2e optional activity failure" }, 500);
        return;
      }
      writeJson(response, {
        code: 200,
        data: {
          summary: {
            totalTokens: 350720,
            peakDailyTokens: 120000,
            peakDailyTokensDate: "2026-08-16",
            totalUsageDurationMs: 5400000,
            currentStreakDays: 2,
            longestStreakDays: 4,
          },
          series: [
            {
              date: "2026-08-16",
              totalTokens: 350720,
              modelCallCount: 7,
              mcpCalls: 3,
            },
          ],
        },
      });
      return;
    }

    if (url.pathname === "/api/monitor/credit-usage/usage-detail") {
      const isModel = url.searchParams.get("usageType") === "MODEL";
      writeJson(response, {
        code: 200,
        data: isModel
          ? {
              summary: {
                cacheHitRate: { value: 0.893, trend: 0.12 },
                totalCredits: { value: 28.95, trend: -0.2 },
                averageDailyCredits: { value: 4.13, trend: 0 },
              },
              modelUsage: {
                xTime: ["2026-08-16"],
                modelDataList: [
                  {
                    modelName: "glm-credit-e2e",
                    totalTokens: 350720,
                    totalCredits: 28.95,
                    totalCreditsUsage: [28.95],
                    totalTokensUsage: [350720],
                    cachedInputCreditsUsage: [17.68],
                    uncachedInputCreditsUsage: [8.63],
                    outputCreditsUsage: [2.64],
                    cachedInputTokensUsage: [200000],
                    uncachedInputTokensUsage: [100000],
                    outputTokensUsage: [50720],
                    sortOrder: 1,
                  },
                ],
              },
            }
          : {
              summary: {
                cacheHitRate: { value: null },
                totalCredits: { value: 1, trend: 0.5 },
                averageDailyCredits: { value: 0.2, trend: 0.1 },
              },
              mcpUsage: {
                xTime: ["2026-08-16"],
                mcpDataList: [
                  {
                    mcpCode: "e2e-search",
                    mcpName: "E2E Search MCP",
                    creditsUsage: [1],
                    mcpCallCount: [3],
                    totalUsageCount: 3,
                    totalCredits: 1,
                    sortOrder: 1,
                  },
                ],
              },
            },
      });
      return;
    }

    if (url.pathname === "/api/monitor/usage/model-performance-day") {
      writeJson(response, {
        code: 200,
        data: {
          x_time: ["2026-08-16"],
          proMaxDecodeSpeed: [125.4],
          liteDecodeSpeed: [55.2],
        },
      });
      return;
    }

    if (url.pathname === "/api/monitor/usage/model-usage") {
      const isTeam = url.searchParams.get("type") === "2";
      writeJson(response, {
        code: 200,
        data: {
          x_time: ["2026-07-01", "2026-07-02"],
          granularity: "daily",
          totalUsage: {
            totalModelCallCount: 2,
            totalTokensUsage: isTeam ? 3210 : 1230,
          },
          modelDataList: [
            {
              modelName: isTeam ? "glm-team-e2e" : "glm-personal-e2e",
              sortOrder: 1,
              tokensUsage: isTeam ? [1200, 2010] : [500, 730],
              totalTokens: isTeam ? 3210 : 1230,
            },
          ],
          modelSummaryList: [
            {
              modelName: isTeam ? "glm-team-e2e" : "glm-personal-e2e",
              sortOrder: 1,
              totalTokens: isTeam ? 3210 : 1230,
            },
          ],
        },
      });
      return;
    }

    if (url.pathname === "/api/monitor/usage/tool-usage") {
      const isTeam = url.searchParams.get("type") === "2";
      writeJson(response, {
        code: 200,
        data: {
          x_time: ["2026-07-01", "2026-07-02"],
          granularity: "daily",
          toolDataList: [
            {
              toolCode: isTeam ? "team-search" : "personal-search",
              toolName: isTeam ? "Team Search" : "Personal Search",
              sortOrder: 1,
              usageCount: isTeam ? [2, 3] : [1, 1],
              totalUsageCount: isTeam ? 5 : 2,
            },
          ],
          toolSummaryList: [
            {
              toolCode: isTeam ? "team-search" : "personal-search",
              toolName: isTeam ? "Team Search" : "Personal Search",
              sortOrder: 1,
              totalUsageCount: isTeam ? 5 : 2,
            },
          ],
        },
      });
      return;
    }

    writeJson(response, { code: 404, msg: `Unhandled mock path: ${url.pathname}` }, 404);
  });

  await new Promise<void>((resolveStart) => {
    codingPlanTeamMockServer?.listen(0, "127.0.0.1", resolveStart);
  });
  const address = codingPlanTeamMockServer.address() as AddressInfo;
  codingPlanTeamMockBaseUrl = `http://127.0.0.1:${address.port}`;
  applyCodingPlanTeamMockEnv(process.env, codingPlanTeamMockBaseUrl);
}

async function isCodingPlanTeamMockAlive(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/__e2e/coding-plan/team-health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function configureCodingPlanTeamMockForSpecs(specs: string[]) {
  if (!shouldUseCodingPlanTeamMock(specs)) {
    return;
  }
  const baseUrl =
    codingPlanTeamMockBaseUrl || process.env.ZCODE_E2E_CODING_PLAN_MOCK_URL?.trim() || "";
  if (!baseUrl) {
    throw new Error("coding plan mock case mode 配置失败：mock URL 未初始化");
  }
  const mode = isSubagentCodingPlanLoginCatalogStaleSpec(specs)
    ? SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE
    : isModelProviderPlanSurfaceSpec(specs)
      ? "model-provider-plan-surface"
      : "default";
  const response = await fetch(`${baseUrl}/__e2e/coding-plan/case-mode`, {
    body: JSON.stringify({ mode }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) {
    throw new Error(`coding plan mock case mode 配置失败：status=${response.status} mode=${mode}`);
  }
}

async function stopCodingPlanTeamMock() {
  await offPeakTeamGateway?.close();
  offPeakTeamGateway = null;
  if (codingPlanTeamMockServer) {
    await new Promise<void>((resolveStop) => {
      codingPlanTeamMockServer?.close(() => resolveStop());
    });
    codingPlanTeamMockServer = null;
  }
  if (codingPlanDataPlaneProxy) {
    await codingPlanDataPlaneProxy.stop();
    codingPlanDataPlaneProxy = null;
  }
  // Bugfix: shared env must not be deleted unconditionally. ZCODE_BASE_URL and similar values injected by the budget/catalog mocks before this function
  // were mistakenly deleted in beforeSession, causing those specs' Electron to hit the real domain.
  // Only clear keys whose current value still points at this mock: this removes pollution that runnerEnv seeded into non-team workers,
  // without touching values other mock families just wrote.
  const ownedBaseUrl =
    codingPlanTeamMockBaseUrl || process.env[CODING_PLAN_TEAM_MOCK_BASE_URL_ENV]?.trim() || "";
  codingPlanTeamMockBaseUrl = "";
  if (!ownedBaseUrl) {
    return;
  }
  clearCodingPlanTeamMockEnv(process.env, ownedBaseUrl);
}

const HIGHSPEED_DATA_PLANE_FIXTURE_PATHS = [
  "test/e2e/fixtures/upstream/conversation-session/conversation-session-highspeed-card.json",
  "test/e2e/fixtures/upstream/conversation-session/conversation-session-highspeed-card-draw-timeout.json",
  "test/e2e/fixtures/upstream/conversation-session/conversation-session-highspeed-card-draw-miss.json",
  "test/e2e/fixtures/upstream/conversation-session/conversation-session-highspeed-card-fallback-unlocks-model.json",
];

async function readDataPlaneTurnFixtures(path: string): Promise<DataPlaneTurnFixture[]> {
  return (
    JSON.parse(await readFile(resolve(DESKTOP_DIR, path), "utf8")) as {
      fixtures: DataPlaneTurnFixture[];
    }
  ).fixtures;
}

async function startCodingPlanDataPlaneProxy(specs: readonly string[]) {
  // The data plane starts per current worker; a ToolSearch in a mixed batch does not affect other account cases.
  if (!shouldPrepareCodingPlanTeamMock(specs)) return;
  // ToolSearch's multi-round replies use the main capture proxy, so two proxies do not overwrite the same network settings.
  if (specs.some((spec) => spec.includes("conversation-session-toolsearch"))) return;
  if (codingPlanDataPlaneProxy) {
    for (const [key, value] of Object.entries(codingPlanDataPlaneProxy.env)) {
      process.env[key] = value;
    }
    return;
  }
  const startIndependentFixtures = specs.some((spec) =>
    spec.includes("conversation-session-start-plan-independent.test.ts"),
  )
    ? await readDataPlaneTurnFixtures(
        "test/e2e/fixtures/upstream/conversation-session/conversation-session-start-plan-independent.json",
      )
    : null;
  // Each round of requests in the Highspeed draw case goes through the Team Coding Plan built-in HTTPS endpoint (spec §7);
  // a static body cannot distinguish rounds, so multi-round cases would be judged complete in the first round; they must be marked for replay per round.
  const highspeedFixtures = specs.some((spec) =>
    spec.includes("conversation-session-highspeed-card"),
  )
    ? (
        await Promise.all(
          HIGHSPEED_DATA_PLANE_FIXTURE_PATHS.map((path) => readDataPlaneTurnFixtures(path)),
        )
      ).flat()
    : null;
  codingPlanDataPlaneProxy = await startE2ENetworkCaptureProxy({
    artifactPath: CODING_PLAN_DATA_PLANE_ARTIFACT_PATH,
    caDir: E2E_CODING_PLAN_DATA_PLANE_CA_DIR,
    // SR87 taking the first body text directly would bypass the matcher and return the title as the main request SSE too; share the real replay entry with the controlled stream.
    requestRedirects: specs.some(
      (spec) =>
        spec.includes("conversation-session-highspeed-queue-edit.test.ts") ||
        spec.includes("conversation-session-model-provider-effective-selection.test.ts"),
    )
      ? [
          {
            host: "open.bigmodel.cn",
            path: "/api/anthropic/v1/messages",
            targetUrl: `${upstreamE2EBaseUrl}/messages`,
          },
        ]
      : [],
    responseMocks: [
      // With signing enabled by default, the Account cases' test credentials also start a handshake; a local response avoids reaching the online service.
      {
        host: "open.bigmodel.cn",
        method: "POST",
        path: "/api/paas/c1f3a7e2/v2/client",
        body: JSON.stringify({ code: 500, msg: "E2E handshake unavailable" }),
      },
      ...(startIndependentFixtures
        ? [
            {
              host: "start154-e2e.invalid",
              method: "POST",
              path: "/v1/messages",
              ...createCodingPlanDataPlaneResponse(startIndependentFixtures, {
                fallbackBody: CODING_PLAN_MODEL_SSE_BODY,
                title: { id: "start154-title", text: "Start154 checks" },
              }),
            },
          ]
        : []),
      {
        ...(highspeedFixtures
          ? createCodingPlanDataPlaneResponse(highspeedFixtures, {
              fallbackBody: CODING_PLAN_MODEL_SSE_BODY,
              title: { id: "highspeed-title", text: '{"title":"Highspeed draw"}' },
            })
          : codingPlanDefaultDataPlaneResponse),
        host: "open.bigmodel.cn",
        method: "POST",
        path: "/api/anthropic/v1/messages",
      },
    ],
  });
  for (const [key, value] of Object.entries(codingPlanDataPlaneProxy.env)) {
    process.env[key] = value;
  }
}

async function readRequestJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolveRead) => {
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolveRead());
  });
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  return (raw ? JSON.parse(raw) : {}) as T;
}

function writeJson(response: ServerResponse, payload: unknown, statusCode = 200) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

async function startUpstreamCaptureProxy(specs: readonly string[]) {
  const toolSearchFixture = specs.some((spec) => spec.includes("conversation-session-toolsearch"));
  if (!toolSearchFixture) assertUpstreamCaptureConfig();
  const toolSearchSpec = specs.find((spec) => spec.includes("conversation-session-toolsearch"));
  const toolSearchResponses = toolSearchSpec
    ? await loadToolSearchResponses(
        toolSearchSpec
          .replaceAll("\\", "/")
          .split("/")
          .at(-1)!
          .replace(/\.test\.ts$/, ""),
      )
    : undefined;
  const apiKey = toolSearchFixture ? E2E_PROVIDER_REPLAY_API_KEY : readE2EProviderApiKey();
  const responseMocks = requestSecurityCaptureMocks(process.env, e2eProviderPresetName);
  upstreamCaptureProxy = await startE2ENetworkCaptureProxy({
    artifactPath: UPSTREAM_CAPTURE_ARTIFACT_PATH,
    // Bugfix: beforeSession resets .e2e-home after the capture proxy starts;
    // if the CA lived under .e2e-home it would be deleted, and the agent reading ZCODE_AGENT_CA_CERT afterwards would hit ENOENT.
    caDir: E2E_NETWORK_CAPTURE_CA_DIR,
    recordResponseChunkTimeline: true,
    responseChunkTimelineLimitBytes: UPSTREAM_CAPTURE_RESPONSE_CHUNK_TIMELINE_BYTES,
    responsePreviewLimitBytes: UPSTREAM_CAPTURE_RESPONSE_PREVIEW_BYTES,
    responseMocks: toolSearchFixture
      ? [
          ...(responseMocks ?? []),
          // With signing enabled by default, ToolSearch's fake credentials also start a handshake; share the local failure response boundary with the Account cases.
          {
            host: "open.bigmodel.cn",
            method: "POST",
            path: "/api/paas/c1f3a7e2/v2/client",
            body: JSON.stringify({ code: 500, msg: "E2E handshake unavailable" }),
          },
          {
            body: (body) =>
              toolSearchResponses!.get(
                toolSearchResponseStage(JSON.parse(body) as ToolSearchRequest),
              ).response.body,
            headers: { "content-type": "text/event-stream; charset=utf-8" },
            host: "open.bigmodel.cn",
            method: "POST",
            path: "/api/anthropic/v1/messages",
          },
        ]
      : responseMocks,
  });
  process.env.E2E_PROVIDER_API_KEY = apiKey;
  upstreamE2EBaseUrl = e2eProviderPreset.baseUrl;

  // Fix reason: capture mode is used to update fixed fixtures and needs real upstream responses and request capture;
  // the default replay mode does not go through here, so fixed regressions are not affected by network, balance, or rate limits.
  for (const [key, value] of Object.entries(upstreamCaptureProxy.env)) {
    process.env[key] = value;
  }
  process.env.E2E_PROVIDER_CAPTURE_MODE = "capture";
  process.env.E2E_PROVIDER_CAPTURE_PATH = upstreamCaptureProxy.artifactPath;
  process.env.E2E_PROVIDER_CAPTURE_PROXY_URL = upstreamCaptureProxy.proxyUrl;
  process.env.E2E_PROVIDER_EXPECTED_HOST = e2eProviderPreset.expectedHost;
  process.env.E2E_PROVIDER_EXPECTED_PROTOCOL = e2eProviderPreset.expectedProtocol;
  process.env.E2E_PROVIDER_RUNTIME_BASE_URL = e2eProviderPreset.baseUrl;
  recordRequestSecurityCaptureMode(process.env, Boolean(responseMocks));
  writeUpstreamE2ERuntimeFile("capture", e2eProviderPreset.baseUrl);
}

function writeUpstreamE2ERuntimeFile(mode: "capture" | "replay", baseUrl: string) {
  // Fix reason: an env set inside a WDIO hook is not always reliably readable by all spec code;
  // expose this run's proxy address via a runtime file, so custom-provider cases do not misread a stale CLI config port.
  mkdirSync(E2E_NETWORK_CAPTURE_DIR, { recursive: true });
  writeFileSync(
    E2E_PROVIDER_RUNTIME_FILE,
    JSON.stringify(
      {
        artifactPath: process.env.E2E_PROVIDER_CAPTURE_PATH ?? "",
        baseUrl,
        mode,
      },
      null,
      2,
    ),
  );
}

async function stopUpstreamE2EHttp() {
  if (!upstreamCaptureProxy) {
    if (upstreamReplayServer) {
      await upstreamReplayServer.stop();
      upstreamReplayServer = null;
    }
    return;
  }
  await upstreamCaptureProxy.stop();
  upstreamCaptureProxy = null;
  if (upstreamReplayServer) {
    await upstreamReplayServer.stop();
    upstreamReplayServer = null;
  }
}

async function startCodingPlanUpgradeE2EMock(
  specs: string[] = [],
  options: { prepareForBuild?: boolean } = {},
) {
  const resolvedScenario = resolveCodingPlanUpgradeMockScenario(specs);
  const scenario =
    resolvedScenario ??
    (options.prepareForBuild && shouldPrepareCodingPlanUpgradeMockForBuild(specs)
      ? "webview-refresh-provider"
      : null);
  if (!scenario) {
    await stopCodingPlanUpgradeE2EMock();
    return;
  }
  const preparedBaseUrl = process.env[CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV]?.trim();
  const mockOptions = { marketingTouch: specs.some((spec) => spec.includes("marketing-touch-")) };
  if (!codingPlanUpgradeMockServer && preparedBaseUrl) {
    await resetCodingPlanUpgradeMockServer(preparedBaseUrl, scenario, mockOptions);
    applyCodingPlanUpgradeMockEnv(process.env, preparedBaseUrl);
    return;
  }
  if (codingPlanUpgradeMockServer) {
    await resetCodingPlanUpgradeMockServer(
      codingPlanUpgradeMockServer.baseUrl,
      scenario,
      mockOptions,
    );
    applyCodingPlanUpgradeMockEnv(process.env, codingPlanUpgradeMockServer.baseUrl);
    return;
  }
  codingPlanUpgradeMockServer = await startCodingPlanUpgradeMockServer(scenario, mockOptions);
  process.env[CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV] = codingPlanUpgradeMockServer.baseUrl;
  applyCodingPlanUpgradeMockEnv(process.env, codingPlanUpgradeMockServer.baseUrl);
}

// Off-peak task E2E: when the off-peak spec is hit, start an in-process mock gateway (ZCODE_OFFPEAK_MOCK=1);
// the host inherits the worker env, starts the gateway and force-enables the gray release automatically. Management-type GUI specs keep the ticket briefly queued,
// to avoid creating a row that wakes the scheduler and dispatches a model request before the UI can act on it.
async function startOffPeakE2EMock(specs: string[] = []): Promise<void> {
  const isOffPeakSpec = specs.some((spec) => spec.includes("off-peak") || spec.includes("offpeak"));
  if (isOffPeakTeamPlanSpec(specs)) {
    delete process.env.ZCODE_OFFPEAK_MOCK;
    const port = Number(process.env.ZCODE_OFFPEAK_MOCK_PORT);
    if (!port) throw new Error("Team 闲时 E2E 网关未由 launcher 准备");
    await materializeOffPeakMockZCodeBuiltinProviderConfig(port, "GLM-5.3");
    process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = E2E_OFFPEAK_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
    return;
  }
  if (isOffPeakSpec) {
    process.env.ZCODE_OFFPEAK_MOCK = "1";
    process.env.ZCODE_OFFPEAK_MOCK_PORT = "45197";
    const isSubagentInheritanceSpec = isOffPeakSubagentModelInheritanceSpec(specs);
    const isInvalidTicketSpec = isOffPeakInvalidTicketSpec(specs);
    // Management cases are deferred to ready; OP10 must actually run scheduler→turn→child, so taking a number means ready.
    process.env.ZCODE_OFFPEAK_MOCK_READY_DELAY_MS =
      isSubagentInheritanceSpec || isInvalidTicketSpec ? "0" : "60000";
    process.env.ZCODE_OFFPEAK_MOCK_READY_TTL_MS = "600000";
    process.env.ZCODE_OFFPEAK_MOCK_ACTIVE_MS = "600000";
    process.env.ZCODE_OFFPEAK_MOCK_NEXT_POLL_S = "1";
    if (isSubagentInheritanceSpec) {
      process.env.ZCODE_OFFPEAK_MOCK_SCENARIO = "foreground-subagents";
    } else if (isInvalidTicketSpec) {
      process.env.ZCODE_OFFPEAK_MOCK_SCENARIO = "invalid-ticket";
    } else if (
      specs.some((spec) =>
        spec.includes("conversation-session-offpeak-create-existing-session.test.ts"),
      )
    ) {
      // Binding a session reuses the existing fixed text response and keeps the queued editing window; capture mode would keep
      // forwarding to upstream, which is unsuitable as an offline reply here. The fixture matches only one child marker and creates no subtask.
      process.env.ZCODE_OFFPEAK_MOCK_SCENARIO = "foreground-subagents";
    } else {
      delete process.env.ZCODE_OFFPEAK_MOCK_SCENARIO;
    }
    // D39 regression spec: the dedicated availability returns false + next_take_at, verifying that the renderer
    // greys out early using the server snapshot; the other off-peak specs keep availability=true.
    const isLimitPreGateSpec = specs.some((spec) => spec.includes("off-peak-limit-pre-gate"));
    if (isLimitPreGateSpec) {
      process.env.ZCODE_OFFPEAK_MOCK_AVAILABILITY_BLOCK_MS = "3600000";
    } else {
      delete process.env.ZCODE_OFFPEAK_MOCK_AVAILABILITY_BLOCK_MS;
    }
    await materializeOffPeakMockZCodeBuiltinProviderConfig(
      Number(process.env.ZCODE_OFFPEAK_MOCK_PORT),
      isSubagentInheritanceSpec ? "GLM-5.3" : "GLM-5.2",
    );
    process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = E2E_OFFPEAK_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  } else {
    delete process.env.ZCODE_OFFPEAK_MOCK;
    delete process.env.ZCODE_OFFPEAK_MOCK_AVAILABILITY_BLOCK_MS;
    delete process.env.ZCODE_OFFPEAK_MOCK_PORT;
    delete process.env.ZCODE_OFFPEAK_MOCK_SCENARIO;
    if (INITIAL_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) {
      process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = INITIAL_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
    } else {
      delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
    }
  }
}

async function materializeOffPeakMockZCodeBuiltinProviderConfig(
  port: number,
  modelId: string,
): Promise<void> {
  const sourcePath = resolve(REPO_ROOT, "config/provider/zcode-builtin.json");
  const document = JSON.parse(await readFile(sourcePath, "utf8")) as {
    config?: {
      providerConfigRules?: {
        providerRules?: Array<{
          providerId: string;
          config: { api?: { baseUrl?: string }; builtinModelIds?: string[] };
        }>;
      };
    };
  };
  const offPeakProviderIds = [
    "account:zai-offpeak-idle-plan",
    "account:bigmodel-offpeak-idle-plan",
  ];
  for (const providerId of offPeakProviderIds) {
    // Built-in has converged to a rule list; the old fixture reading providers would fail with a missing api before startup.
    const offPeakProvider = document.config?.providerConfigRules?.providerRules?.find(
      (rule) => rule.providerId === providerId,
    )?.config;
    if (!offPeakProvider?.api) {
      throw new Error(`ZCode Built-in Config 缺少 ${providerId}.api`);
    }
    offPeakProvider.api.baseUrl = `http://127.0.0.1:${port}/api/v1/off-peak/anthropic`;
    // The single-model whitelist of the original off-peak fixture should move to the current Built-in input; it must not keep depending on the retired
    // client-config models field. Only this E2E isolated file is modified; the production list is unchanged.
    offPeakProvider.builtinModelIds = [modelId];
  }
  await mkdir(resolve(E2E_OFFPEAK_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, ".."), {
    recursive: true,
  });
  await writeFile(
    E2E_OFFPEAK_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
    `${JSON.stringify(document, null, 2)}\n`,
    "utf8",
  );
}

// Highspeed E2E uses the deterministic transport built into Host; inject the scenario per spec so that ordinary sessions
// in the default test suite do not accidentally draw the card. This variable must be set before Electron starts for Host to assemble the mock.
function configureHighspeedE2EMock(specs: string[] = []): void {
  const scenario = resolveHighspeedE2EMockScenario(specs);
  if (scenario) {
    process.env[HIGHSPEED_MOCK_SCENARIO_ENV] = scenario;
  } else {
    delete process.env[HIGHSPEED_MOCK_SCENARIO_ENV];
  }
}

async function stopCodingPlanUpgradeE2EMock() {
  const ownedBaseUrl =
    codingPlanUpgradeMockServer?.baseUrl ??
    process.env[CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV]?.trim() ??
    "";
  if (!codingPlanUpgradeMockServer) {
    if (ownedBaseUrl) {
      clearCodingPlanUpgradeMockEnv(process.env, ownedBaseUrl);
    }
    restoreE2EProviderEndpointEnv();
    return;
  }
  await codingPlanUpgradeMockServer.stop();
  codingPlanUpgradeMockServer = null;
  clearCodingPlanUpgradeMockEnv(process.env, ownedBaseUrl);
  restoreE2EProviderEndpointEnv();
}

function restoreE2EProviderEndpointEnv() {
  const endpointEnv = getE2EProviderEndpointEnv(
    configuredE2ESpecs,
    e2eProviderPresetName,
    upstreamE2EHttpMode,
  );
  if (Object.keys(endpointEnv).length > 0) {
    // Fix reason: every round's beforeSession runs the mock cleanup; the production control-plane choices for request-security capture and live-team
    // must be restored, otherwise production credentials would be sent to the test domain.
    Object.assign(process.env, endpointEnv);
    return;
  }
  restoreRequestSecurityEndpointEnv(process.env, e2eProviderPresetName, upstreamE2EHttpMode);
}

async function startModelContextBudgetConfigE2EMock(specs: string[] = []) {
  const scenario = resolveModelContextBudgetConfigMockScenario(specs);
  if (!scenario) {
    await stopModelContextBudgetConfigE2EMock();
    return;
  }
  if (modelContextBudgetConfigMockServer?.scenario !== scenario) {
    await stopModelContextBudgetConfigE2EMock();
    modelContextBudgetConfigMockServer = await startModelContextBudgetConfigMockServer(scenario);
  }
  process.env.ZCODE_BASE_URL = modelContextBudgetConfigMockServer.baseUrl;
  process.env.ZCODE_TEST_BASE_URL = modelContextBudgetConfigMockServer.baseUrl;
  process.env.ZCODE_ENDPOINT_ORIGIN = modelContextBudgetConfigMockServer.baseUrl;
}

async function stopModelContextBudgetConfigE2EMock() {
  if (!modelContextBudgetConfigMockServer) {
    return;
  }
  await modelContextBudgetConfigMockServer.stop();
  modelContextBudgetConfigMockServer = null;
  delete process.env.ZCODE_BASE_URL;
  delete process.env.ZCODE_TEST_BASE_URL;
  delete process.env.ZCODE_ENDPOINT_ORIGIN;
}

async function startDynamicWorkflowConfigE2EMock(specs: string[] = []) {
  const scenario = resolveDynamicWorkflowConfigMockScenario(specs);
  if (!scenario) {
    await stopDynamicWorkflowConfigE2EMock();
    return;
  }
  if (dynamicWorkflowConfigMockServer?.scenario !== scenario) {
    await stopDynamicWorkflowConfigE2EMock();
    dynamicWorkflowConfigMockServer = await startDynamicWorkflowConfigMockServer(scenario);
  }
  applyDynamicWorkflowConfigMockEnv(process.env, dynamicWorkflowConfigMockServer.baseUrl);
}

async function stopDynamicWorkflowConfigE2EMock() {
  if (!dynamicWorkflowConfigMockServer) {
    return;
  }
  const baseUrl = dynamicWorkflowConfigMockServer.baseUrl;
  await dynamicWorkflowConfigMockServer.stop();
  dynamicWorkflowConfigMockServer = null;
  clearDynamicWorkflowConfigMockEnv(process.env, baseUrl);
}

async function startClientScenesE2EMockIfNeeded(specs: string[] = []) {
  if (!shouldUseClientScenesMock(specs)) {
    await stopClientScenesE2EMock();
    return;
  }
  clientScenesMockServer ??= await startClientScenesMockServer();
  applyClientScenesMockEnv(process.env, clientScenesMockServer.baseUrl);
}

async function stopClientScenesE2EMock() {
  if (!clientScenesMockServer) {
    return;
  }
  const baseUrl = clientScenesMockServer.baseUrl;
  await clientScenesMockServer.stop();
  clientScenesMockServer = null;
  clearClientScenesMockEnv(process.env, baseUrl);
}

async function startPluginCdnZipFixtureIfNeeded(specs: string[] = []) {
  if (!shouldUsePluginCdnZipMarketplaceFixture(specs)) {
    return;
  }
  pluginCdnZipFixtureServer ??= await startPluginCdnZipFixtureServer();
}

async function stopPluginCdnZipFixture() {
  await stopPluginCdnZipFixtureServer(pluginCdnZipFixtureServer ?? undefined);
  pluginCdnZipFixtureServer = null;
}

async function armCurrentElectronAppQuit(stage: string) {
  currentE2EElectronAppPid = null;
  try {
    const result = (await browser.electron.execute((electron) => {
      const currentAppPid = process.pid;
      const appName = electron.app.getName();
      if (appName !== "ZCode E2E") {
        return {
          appName,
          appPid: currentAppPid,
          armedWindowCount: 0,
        };
      }

      const appWindows = electron.BrowserWindow.getAllWindows();
      let quitRequested = false;
      const requestQuitAfterDriverClose = () => {
        if (quitRequested || electron.BrowserWindow.getAllWindows().length > 0) {
          return;
        }
        quitRequested = true;
        electron.app.quit();
      };

      // Fix reason: calling app.quit directly in after makes the renderer disappear before ChromeDriver's
      // deleteSession, and ChromeDriver then waits and times out on an invalid browsing context.
      // Here a one-time listener is attached only to the current process and current window; deleteSession closes the window first,
      // then the app.quit before-quit chain reclaims host/agent. There is no cross-session timer.
      for (const appWindow of appWindows) {
        appWindow.once("closed", requestQuitAfterDriverClose);
      }
      return {
        appName,
        appPid: currentAppPid,
        armedWindowCount: appWindows.length,
      };
    })) as {
      appName?: string;
      appPid?: number;
      armedWindowCount?: number;
    };

    currentE2EElectronAppPid = typeof result.appPid === "number" ? result.appPid : null;
    if (!result.armedWindowCount) {
      writeE2ECleanupWarning(
        `${stage}: skip app quit barrier because current Electron app is ${result.appName ?? "unknown"} or has no windows`,
      );
      return;
    }
  } catch (error) {
    writeE2ECleanupWarning(`${stage}: app quit barrier failed: ${formatErrorMessage(error)}`);
  }
}

async function cleanupE2EElectronProcesses(
  stage: string,
  {
    requireExit = false,
    waitForGracefulExit = false,
  }: { requireExit?: boolean; waitForGracefulExit?: boolean } = {},
) {
  try {
    // Fix reason: after has recorded the current Electron main PID; the normal path first waits for and reclaims by the known root process,
    // to avoid each worker repeatedly starting PowerShell/CIM scans of the whole machine's process tree under high concurrency.
    // The final runId/HOME scan remains a strict barrier and catches host/agent leftovers after the main process exits.
    let targetPids =
      currentE2EElectronAppPid !== null && isProcessAlive(currentE2EElectronAppPid)
        ? [currentE2EElectronAppPid]
        : listCurrentE2EProcessPids();
    if (waitForGracefulExit && targetPids.length > 0) {
      // Fix reason: when app.quit is emitted, ChromeDriver still holds the session, and the main process usually cannot exit until
      // after deleteSession; afterSession is the correct barrier point for waiting for a natural exit.
      await waitForProcessesExit(targetPids, E2E_ELECTRON_APP_QUIT_TIMEOUT_MS);
      targetPids = targetPids.filter((pid) => isProcessAlive(pid));
      if (targetPids.length === 0) {
        targetPids = listCurrentE2EProcessPids();
      }
    }
    if (targetPids.length === 0) {
      return;
    }

    writeE2ECleanupWarning(
      `${stage}: force terminating leftover Electron e2e pids=${targetPids.join(",")}`,
    );
    if (process.platform === "win32") {
      forceTerminateWindowsProcesses(targetPids);
      await waitForProcessesExit(targetPids, E2E_ELECTRON_FORCE_KILL_GRACE_MS);
    } else {
      terminatePosixProcesses(targetPids, "SIGTERM");
      await waitForProcessesExit(targetPids, E2E_ELECTRON_FORCE_KILL_GRACE_MS);
      const remainingAfterTerm = targetPids.filter((pid) => isProcessAlive(pid));
      terminatePosixProcesses(remainingAfterTerm, "SIGKILL");
      await waitForProcessesExit(remainingAfterTerm, E2E_ELECTRON_FORCE_KILL_GRACE_MS);
    }

    const remainingPids = listCurrentE2EProcessPids();
    if (remainingPids.length > 0) {
      throw new Error(`E2E process exit barrier failed, remaining pids=${remainingPids.join(",")}`);
    }
  } catch (error) {
    writeE2ECleanupWarning(
      `${stage}: leftover Electron cleanup failed: ${formatErrorMessage(error)}`,
    );
    if (requireExit) {
      throw error;
    }
  }
}

function listCurrentE2EProcessPids() {
  const detectedPids = listE2EProcessTreePids({
    chromiumProfileRootDir: E2E_CHROMIUM_USER_DATA_ROOT_DIR,
    homeDir: E2E_HOME_DIR,
    runId: E2E_RUN_ID,
  });
  if (
    currentE2EElectronAppPid !== null &&
    currentE2EElectronAppPid !== process.pid &&
    isProcessAlive(currentE2EElectronAppPid)
  ) {
    detectedPids.push(currentE2EElectronAppPid);
  }
  return [...new Set(detectedPids)];
}

async function cleanupE2EDirectory(stage: string, userDataDir: string, requireRemoved = false) {
  try {
    await rm(userDataDir, {
      force: true,
      maxRetries: process.platform === "win32" ? 3 : 1,
      recursive: true,
      retryDelay: 300,
    });
    if (existsSync(userDataDir)) {
      throw new Error(`E2E directory still exists: ${userDataDir}`);
    }
  } catch (error) {
    writeE2ECleanupWarning(
      `${stage}: E2E directory cleanup failed (${userDataDir}): ${formatErrorMessage(error)}`,
    );
    if (requireRemoved) {
      throw error;
    }
  }
}

function forceTerminateWindowsProcesses(pids: number[]) {
  if (pids.length === 0) {
    return;
  }
  try {
    // Fix reason: the target set includes parent and child PIDs of the same Electron tree; executing `/T` per PID
    // would recursively kill the same tree repeatedly and amplify taskkill process-creation overhead under multiple shards.
    execFileSync("taskkill", buildWindowsTaskkillArgs(pids), {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch (error) {
    const alivePids = pids.filter((pid) => isProcessAlive(pid));
    if (alivePids.length > 0) {
      writeE2ECleanupWarning(
        `taskkill failed for pids=${alivePids.join(",")}: ${formatErrorMessage(error)}`,
      );
    }
  }
}

function terminatePosixProcesses(pids: number[], signal: NodeJS.Signals) {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (isProcessAliveError(error)) {
        writeE2ECleanupWarning(`${signal} failed for pid=${pid}: ${formatErrorMessage(error)}`);
      }
    }
  }
}

async function waitForProcessesExit(pids: number[], timeoutMs: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (pids.every((pid) => !isProcessAlive(pid))) {
      return true;
    }
    await waitE2EDelay(100);
  }
  return pids.every((pid) => !isProcessAlive(pid));
}

async function runE2ERendererBridgePreflight(specs: string[] = []) {
  const attempt = await waitForE2ERendererBridgePreflight();
  if (!attempt.error) {
    return;
  }

  // Bug cause: reloadSession inside a hook does not first wait for the old Electron process tree to exit, so the old target and
  // the new session compete again for ContextId. Startup failures must be handed to the worker/afterSession for full cleanup.
  throw createE2ERendererBridgePreflightError(attempt.latest, specs, attempt.error, false);
}

async function waitForE2ERendererBridgePreflight(): Promise<{
  error: unknown | null;
  latest: E2ERendererBridgePreflightResult | null;
}> {
  let latest: E2ERendererBridgePreflightResult | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await inspectE2ERendererBridgePreflight();
        return latest.ok;
      },
      {
        interval: 250,
        timeout: E2E_RENDERER_BRIDGE_PREFLIGHT_TIMEOUT_MS,
        timeoutMsg: "E2E renderer bridge preflight timed out",
      },
    );
    return { error: null, latest };
  } catch (error) {
    return { error, latest: latest as E2ERendererBridgePreflightResult | null };
  }
}

function createE2ERendererBridgePreflightError(
  lastResult: E2ERendererBridgePreflightResult | null,
  specs: string[],
  cause: unknown,
  recoveryAttempted: boolean,
): Error {
  return new Error(
    [
      "e2e-bridge-preflight infra failure",
      `reason=${lastResult?.reason ?? "unknown"}`,
      `url=${lastResult?.url ?? "unknown"}`,
      `readyState=${lastResult?.documentReadyState ?? "unknown"}`,
      `currentHandle=${lastResult?.currentHandle ?? "unknown"}`,
      `handles=${JSON.stringify(lastResult?.handles ?? [])}`,
      `candidateHandles=${JSON.stringify(lastResult?.candidateHandles ?? [])}`,
      `targets=${JSON.stringify(lastResult?.targets ?? [])}`,
      `missingBridgeMethods=${JSON.stringify(lastResult?.missingBridgeMethods ?? [])}`,
      `missingStateMethods=${JSON.stringify(lastResult?.missingStateMethods ?? [])}`,
      `recoveryAttempted=${recoveryAttempted}`,
      `specs=${JSON.stringify(specs)}`,
      `cause=${formatErrorMessage(cause)}`,
    ].join("; "),
  );
}

async function inspectE2ERendererBridgePreflight(): Promise<E2ERendererBridgePreflightResult> {
  const handles = await browser.getWindowHandles();
  const targets = await getE2EBrowserTargetInfo().catch(() => []);
  const candidates = collectE2EWebDriverPageHandleCandidates(handles, targets);
  const fallback: E2ERendererBridgePreflightResult = {
    bridgeMethods: {},
    candidateHandles: candidates.map((candidate) => candidate.handle),
    currentHandle: await browser.getWindowHandle().catch(() => null),
    documentReadyState: null,
    handle: null,
    handles,
    hasSessionBridge: false,
    missingBridgeMethods: E2E_RENDERER_BRIDGE_REQUIRED_BRIDGE_METHODS,
    missingStateMethods: E2E_RENDERER_BRIDGE_REQUIRED_STATE_METHODS,
    ok: false,
    reason:
      handles.length === 0
        ? "renderer-handle-missing"
        : candidates.length === 0
          ? "renderer-page-handle-intersection-missing"
          : "renderer-url-missing",
    stateMethods: {},
    targets,
    url: null,
  };

  let latest = fallback;
  for (const candidate of candidates) {
    const handle = candidate.handle;
    try {
      await browser.switchToWindow(handle);
      const currentHandle = await browser.getWindowHandle().catch(() => null);
      if (currentHandle !== handle) {
        latest = {
          ...fallback,
          currentHandle,
          handle,
          reason: "renderer-handle-switch-mismatch",
        };
        continue;
      }
      const result = (await browser.execute(
        (requiredBridgeMethods, requiredStateMethods) => {
          const bridge = (
            window as typeof window & {
              __zcodeSessionStoreE2E?: Record<string, unknown> & {
                getState?: () => Record<string, unknown>;
                setState?: (...args: unknown[]) => unknown;
                subscribe?: (...args: unknown[]) => unknown;
              };
            }
          ).__zcodeSessionStoreE2E;
          const bridgeMethods = Object.fromEntries(
            requiredBridgeMethods.map((method) => [method, typeof bridge?.[method] === "function"]),
          ) as Record<string, boolean>;
          const missingBridgeMethods = requiredBridgeMethods.filter(
            (method) => !bridgeMethods[method],
          );
          const state =
            typeof bridge?.getState === "function"
              ? (() => {
                  try {
                    return bridge.getState?.() ?? null;
                  } catch {
                    return null;
                  }
                })()
              : null;
          const stateMethods = Object.fromEntries(
            requiredStateMethods.map((method) => [
              method,
              Boolean(state && typeof state[method] === "function"),
            ]),
          ) as Record<string, boolean>;
          const missingStateMethods = requiredStateMethods.filter(
            (method) => !stateMethods[method],
          );
          const url = window.location.href;
          const isRendererUrl = url.includes("/renderer/index.html");
          const hasSessionBridge = Boolean(bridge);
          const ok =
            isRendererUrl &&
            hasSessionBridge &&
            missingBridgeMethods.length === 0 &&
            missingStateMethods.length === 0;
          const reason = !isRendererUrl
            ? "renderer-url-missing"
            : !hasSessionBridge
              ? "session-bridge-missing"
              : missingBridgeMethods.length > 0
                ? "session-bridge-method-missing"
                : missingStateMethods.length > 0
                  ? "session-state-method-missing"
                  : "ok";

          return {
            bridgeMethods,
            documentReadyState: document.readyState,
            hasSessionBridge,
            missingBridgeMethods,
            missingStateMethods,
            ok,
            reason,
            stateMethods,
            url,
          };
        },
        E2E_RENDERER_BRIDGE_REQUIRED_BRIDGE_METHODS,
        E2E_RENDERER_BRIDGE_REQUIRED_STATE_METHODS,
      )) as Omit<
        E2ERendererBridgePreflightResult,
        "candidateHandles" | "currentHandle" | "handle" | "handles" | "targets"
      >;
      latest = {
        ...result,
        candidateHandles: fallback.candidateHandles,
        currentHandle,
        handle,
        handles,
        targets,
      };
      if (latest.ok || latest.url?.includes("/renderer/index.html")) {
        // Fix reason: the electron service's auto-focus also reads this handle; only after validation
        // against both the ChromeDriver handle table and the actual renderer URL is the update allowed.
        (
          browser.electron as typeof browser.electron & {
            windowHandle?: string;
          }
        ).windowHandle = handle;
        return latest;
      }
    } catch (error) {
      latest = {
        ...fallback,
        handle,
        reason: `renderer-preflight-execute-failed:${formatErrorMessage(error)}`,
      };
    }
  }

  return latest;
}

async function getE2EBrowserTargetInfo(): Promise<E2EBrowserTargetInfo[]> {
  const puppeteer = await browser.getPuppeteer();
  return puppeteer.targets().map((target) => ({
    id: (target as unknown as { _targetId?: string })._targetId ?? null,
    type: target.type(),
    url: target.url(),
  }));
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isProcessAliveError(error);
  }
}

function isProcessAliveError(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code !== "ESRCH",
  );
}

function writeE2ECleanupWarning(message: string) {
  process.stderr.write(`[desktop-e2e-cleanup] ${message}\n`);
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function armE2ERunnerExitWatchdog(exitCode: number) {
  if (e2eRunnerExitWatchdog) {
    clearTimeout(e2eRunnerExitWatchdog);
  }

  // Fix reason: after Electron and the replay server are both cleaned up, the WDIO CLI may still be stuck on historical
  // handles, forming orphan processes like conversation-session; a normal exit does not trigger this fallback.
  e2eRunnerExitWatchdog = setTimeout(() => {
    writeE2ECleanupWarning(
      `onComplete: forcing WDIO runner exit after ${E2E_RUNNER_FORCE_EXIT_TIMEOUT_MS}ms`,
    );
    process.exit(exitCode);
  }, E2E_RUNNER_FORCE_EXIT_TIMEOUT_MS);
  e2eRunnerExitWatchdog.unref?.();
}

function forceFinalizeE2ERunnerFromGuard() {
  writeE2ECleanupWarning(
    `finalization guard: onComplete did not start within ${E2E_RUNNER_FINALIZATION_GUARD_TIMEOUT_MS}ms`,
  );
  try {
    // Bug cause: a historical full run exited silently with 0 after the 122 workers finished; onComplete did not
    // write the summary. The guard timeout first synchronously preserves the failure summary from the existing NDJSON, then does best-effort cleanup.
    e2eReporter.writeSummary(1);
  } catch (error) {
    writeE2ECleanupWarning(
      `finalization guard: summary recovery failed: ${formatErrorMessage(error)}`,
    );
  }
  armE2ERunnerExitWatchdog(1);

  const cleanupKeepAlive = setInterval(() => {}, 1000);
  void (async () => {
    try {
      await stopUpstreamE2EHttp();
      await stopCodingPlanTeamMock();
      await stopCodingPlanUpgradeE2EMock();
      await stopRequestSecurityFixture();
      await stopModelContextBudgetConfigE2EMock();
      await stopDynamicWorkflowConfigE2EMock();
      await stopPluginCdnZipFixture();
      await cleanupE2EElectronProcesses("finalization-guard");
      // Failure keeps the diagnostic scene (same as the onComplete-home condition): the guard path itself is a failure wrap-up.
      if (process.env.ZCODE_E2E_KEEP_HOME_ON_FAIL === "1") {
        console.warn(`[e2e] finalization guard keeping failure home: ${E2E_HOME_DIR}`);
      } else {
        await cleanupE2EDirectory("finalization-guard-home", E2E_HOME_DIR);
      }
      await cleanupE2EDirectory("finalization-guard-cache", E2E_RUN_CACHE_DIR);
    } catch (error) {
      writeE2ECleanupWarning(
        `finalization guard: emergency cleanup failed: ${formatErrorMessage(error)}`,
      );
    } finally {
      clearInterval(cleanupKeepAlive);
      process.exit(1);
    }
  })();
}

async function resetE2EHome(specs: string[] = []) {
  await removeE2EHomeWithRetry();
  mkdirSync(E2E_HOME_DIR, { recursive: true });
  seedE2EStartupState(specs);
  await seedRemoteOnboardingFixture({
    // The marketing popup preempts the first-run guidance focus; this suite starts from an account that has completed guidance, to verify popup delivery independently.
    enabled:
      process.env.ZCODE_E2E_REMOTE_PROFILE === "1" ||
      specs.some((spec) => spec.endsWith("ui-shell/marketing-touch-delivery.test.ts")),
    specs,
    appConfigDir: E2E_APP_CONFIG_DIR,
    userId: E2E_USER_PROFILE.id,
  });
  if (workerSpecsContain(specs, PROJECT_UPGRADE_ORDER_SPEC)) {
    await seedProjectUpgradeOrderFixture(E2E_HOME_DIR, E2E_APP_SETTINGS_FILE);
  }
  if (
    usesProviderReadinessColdStartFixture(specs) ||
    usesGitReviewEntryFixture(specs) ||
    workerSpecsContain(specs, "conversation-session-permanent-delete.test.ts")
  ) {
    // SP13 must seed both a real task row and an openable
    // CLI session before Host opens tasks-index; in-test injection would bypass the real task/service resolution chain of the Header and status panel.
    await seedProviderReadinessHistoryFixture({
      cliEntryPoint: ZCODE_CLI_ENTRYPOINT,
      e2eHomeDir: E2E_HOME_DIR,
      workspacePath: resolve(E2E_HOME_DIR, "ZCodeProject"),
    });
  }
  if (workerSpecsContain(specs, SESSION_PR_STATUS_SPEC)) {
    // PRS-01 needs a worktree task row, a github.com remote, and the fake gh
    // (ZCODE_GH_BINARY seam) in place before the Host opens tasks-index.
    await seedSessionPrStatusFixture({
      cliEntryPoint: ZCODE_CLI_ENTRYPOINT,
      e2eHomeDir: E2E_HOME_DIR,
      workspacePath: resolve(E2E_HOME_DIR, "ZCodeProject"),
    });
  }
  if (usesTaskIndexRowAuthorityFixture(specs)) {
    // Bug cause: TSL23 must create the cold-start state of "persistent rows outnumber session summaries" before Host opens tasks-index;
    // the spec's before hook is already too late, so only this case is written to disk in the isolated HOME of beforeSession.
    await seedTaskIndexRowAuthorityFixture({
      cliEntryPoint: ZCODE_CLI_ENTRYPOINT,
      e2eHomeDir: E2E_HOME_DIR,
      workspacePath: resolve(E2E_HOME_DIR, "ZCodeProject"),
    });
  }
  if (workerSpecsContain(specs, "conversation-session-delete-all-archived-tasks.test.ts")) {
    // The helper is async; awaiting it keeps the seed on disk before the Host opens tasks-index.
    await seedDeleteAllArchivedTasksFixture({
      cliEntryPoint: ZCODE_CLI_ENTRYPOINT,
      e2eHomeDir: E2E_HOME_DIR,
      workspacePath: resolve(E2E_HOME_DIR, "ZCodeProject"),
    });
  }
  if (specs.some((spec) => spec.includes(TASK_TITLE_MARQUEE_SPEC))) {
    await seedTaskTitleMarqueeFixture({
      cliEntryPoint: ZCODE_CLI_ENTRYPOINT,
      e2eHomeDir: E2E_HOME_DIR,
      workspacePath: resolve(E2E_HOME_DIR, "ZCodeProject"),
    });
  }
  if (specs.some((spec) => spec.includes("usage-stats-app-usage.test.ts"))) {
    await seedAppUsageE2EFixture({
      cliEntryPoint: ZCODE_CLI_ENTRYPOINT,
      e2eHomeDir: E2E_HOME_DIR,
      workspacePath: resolve(E2E_HOME_DIR, "ZCodeProject"),
    });
  }
  seedE2EWorkerModelStreamConfig(specs);
  await seedE2EModelConfig(specs);
  seedE2EPluginCdnZipMarketplace(specs);
  seedE2EPluginMcpSkillInstalledPlugins(specs);
  seedE2EPluginMcpSkillState(specs);
  await seedE2EWorkspacePluginState(specs);
  await seedE2EBuiltinWorkspacePluginDisable(specs);
  seedE2EBuiltInSubagentModelOverrides(specs);
  seedE2ESubagentProfiles(specs);
  await seedE2EGitReviewEntryWorkspace(specs);
  seedE2EGitCommitDialogWorkspace(specs);
  seedE2EWorktreeChatFirstWorkspace(specs);
  if (
    specs.some(
      (spec) =>
        spec.includes("conversation-session-history-first.test.ts") ||
        spec.includes("conversation-session-blocked-runtime-slash-menu.test.ts"),
    )
  ) {
    await seedSessionHistoryFirstFixture({
      cliEntryPoint: ZCODE_CLI_ENTRYPOINT,
      e2eHomeDir: E2E_HOME_DIR,
      workspacePath: resolve(E2E_HOME_DIR, "ZCodeProject"),
      providerId: e2eProviderPreset.providerId,
      modelId: e2eProviderPreset.model,
      thoughtLevel: readE2EThoughtLevel(),
    });
  }
  if (specs.some((spec) => spec.includes(HOOKS_LIFECYCLE_SPEC))) {
    // Bug cause: by the time the spec's before hook runs, the app-server has already read the workspace config;
    // writing Hooks inside the test only changes the settings page, not this round's agent runtime. The case-local fixture
    // must be written to disk during beforeSession's clean HOME phase, so the first agent process loads it on cold start.
    await installHooksLifecycleFixture();
  }
  if (workerSpecsContain(specs, "conversation-session-stop-tool-results.test.ts")) {
    // The Stop-reproduction hook must be written to disk before the app-server first reads its config; spec.before is already later than warmup.
    await installStopToolResultsFixture();
  }
  if (specs.some((spec) => spec.includes(HOOK_TRUST_SPEC))) {
    // Same as above: the workspace-level hook trust fixture must be written to disk before the first agent process cold-starts,
    // otherwise the SessionStart soft gate would not take effect in the first turn (the pending banner precondition for HK05).
    await installHookTrustFixture();
  }
}

async function removeE2EHomeWithRetry() {
  for (let attempt = 0; attempt <= E2E_HOME_REMOVE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await rm(E2E_HOME_DIR, {
        force: true,
        maxRetries: process.platform === "win32" ? 3 : 1,
        recursive: true,
        retryDelay: 500,
      });
      return;
    } catch (error) {
      if (!isRetryableRemoveError(error) || attempt === E2E_HOME_REMOVE_RETRY_DELAYS_MS.length) {
        throw error;
      }
      // Fix reason: Windows briefly holds SQLite WAL/SHM file handles; first clean up leftover Electron/host as a fallback,
      // then retry with backoff, to avoid beforeSession failing to reset because the previous app exited slowly.
      await cleanupE2EElectronProcesses(`beforeSession-remove-home-attempt-${attempt + 1}`);
      await waitE2EDelay(E2E_HOME_REMOVE_RETRY_DELAYS_MS[attempt] ?? 0);
    }
  }
}

function isRetryableRemoveError(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    ["EBUSY", "ENOTEMPTY", "EPERM"].includes(String((error as { code?: unknown }).code)),
  );
}

function seedE2EPluginCdnZipMarketplace(specs: string[] = []) {
  if (!shouldUsePluginCdnZipMarketplaceFixture(specs)) {
    return;
  }
  if (!pluginCdnZipFixtureServer) {
    throw new Error("Plugin CDN zip fixture server must start before seeding marketplace");
  }
  seedPluginCdnZipMarketplaceFixture({
    e2eHomeDir: E2E_HOME_DIR,
    server: pluginCdnZipFixtureServer,
    lastUpdated: resolvePluginCdnZipMarketplaceLastUpdated(specs),
  });
}

// Writes the installed_plugins.json needed by the plugin MCP skill lifecycle spec to
// `~/.zcode/cli/plugins/installed_plugins.json`; only runs when the spec matches and state != not-installed.
// Note that from the agent's view storageRoot is `<home>/.zcode`, while pluginStorageRoot
// is `<home>/.zcode/cli/plugins`; installed_plugins.json must live under the latter to be
// read by bootstrap's `listInstalledPluginRecords(pluginStorageRoot)` (see
// `apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts:347`）。
function seedE2EPluginMcpSkillInstalledPlugins(specs: string[] = []) {
  const state = resolvePluginMcpSkillState(specs);
  if (!state || state === "not-installed" || state === "workspace-root") return;
  const templateName =
    state === "installed-enabled"
      ? "installed-plugins.enabled.template.json"
      : "installed-plugins.disabled.template.json";
  const fixturePath = resolve(DESKTOP_DIR, "test/e2e/fixtures/plugin-mcp-skill", templateName);
  const pluginRoot = resolve(DESKTOP_DIR, "test/e2e/fixtures/plugin-mcp-skill/e2e-plugin-mcp-ping");
  const template = readFileSync(fixturePath, "utf-8").replaceAll("__INSTALL_PATH__", pluginRoot);
  // pluginStorageRoot = <home>/.zcode/cli/plugins
  const targetDir = resolve(E2E_STORAGE_ROOT, "cli/plugins");
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(resolve(targetDir, "installed_plugins.json"), template, "utf-8");
}

function shouldSeedGitCommitDialogWorkspace(specs: string[] = []) {
  return specs.some((spec) => spec.includes(GIT_COMMIT_DIALOG_UI_FLOW_SPEC));
}

function seedE2EGitCommitDialogWorkspace(specs: string[] = []) {
  if (!shouldSeedGitCommitDialogWorkspace(specs)) {
    return;
  }

  const workspacePath = resolve(E2E_HOME_DIR, "ZCodeProject");
  mkdirSync(resolve(workspacePath, "src"), { recursive: true });
  writeFileSync(resolve(workspacePath, "README.md"), "Git commit dialog E2E workspace\n", "utf-8");
  runGitE2ECommand(workspacePath, ["init"]);
  runGitE2ECommand(workspacePath, ["checkout", "-B", "main"]);
  runGitE2ECommand(workspacePath, ["config", "user.name", "ZCode E2E"]);
  runGitE2ECommand(workspacePath, ["config", "user.email", "zcode-e2e@example.com"]);
  runGitE2ECommand(workspacePath, ["add", "README.md"]);
  runGitE2ECommand(workspacePath, ["commit", "-m", "chore: seed git commit dialog e2e"]);
  runGitE2ECommand(workspacePath, ["branch", "e2e-target"]);

  writeFileSync(
    resolve(workspacePath, "src/staged-file.ts"),
    "export const stagedGitCommitDialogE2E = true;\n",
    "utf-8",
  );
  writeFileSync(
    resolve(workspacePath, "src/unstaged-file.ts"),
    "export const unstagedGitCommitDialogE2E = true;\n",
    "utf-8",
  );
  runGitE2ECommand(workspacePath, ["add", "src/staged-file.ts"]);
}

function runGitE2ECommand(cwd: string, args: string[]) {
  execFileSync("git", args, {
    cwd,
    env: process.env,
    stdio: "ignore",
  });
}

function seedE2EWorktreeChatFirstWorkspace(specs: string[] = []) {
  if (!workerSpecsContain(specs, WORKTREE_CHAT_FIRST_SPEC)) return;

  const workspacePath = resolve(E2E_HOME_DIR, "ZCodeProject");
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(resolve(workspacePath, "README.md"), "Worktree chat-first E2E fixture\n", "utf-8");
  runGitE2ECommand(workspacePath, ["init", "-q"]);
  runGitE2ECommand(workspacePath, ["checkout", "-B", "main"]);
  runGitE2ECommand(workspacePath, ["config", "user.name", "ZCode E2E"]);
  runGitE2ECommand(workspacePath, ["config", "user.email", "zcode-e2e@example.invalid"]);
  runGitE2ECommand(workspacePath, ["add", "README.md"]);
  runGitE2ECommand(workspacePath, ["commit", "-m", "chore: seed worktree chat-first e2e"]);
}

function seedE2EStartupState(specs: string[] = []) {
  mkdirSync(E2E_APP_CONFIG_DIR, { recursive: true });
  const useFreshConversationWorkspace = specs.some((spec) =>
    spec.includes("conversation-session-conversation-workspace.test.ts"),
  );
  const legacyDefaultProjectPath = resolve(E2E_HOME_DIR, "ZCodeProject");
  const agentWarmupFixture = AGENT_WARMUP_FIXTURE_SPECS.some((marker) =>
    workerSpecsContain(specs, marker),
  );
  const agentWarmupScenario = SMALL_AGENT_WARMUP_SPECS.some((marker) =>
    workerSpecsContain(specs, marker),
  )
    ? SMALL_AGENT_WARMUP_SCENARIO
    : PASSIVE_AGENT_STARTUP_SCENARIO;
  const modelProviderRegressionFixture = workerSpecsContain(
    specs,
    MODEL_PROVIDER_REGRESSION_GAPS_SPEC,
  );
  const passiveWorkspacePaths = agentWarmupFixture
    ? seedPassiveAgentStartupWorkspaces(E2E_HOME_DIR, agentWarmupScenario.workspaceCount)
    : [];
  if (modelProviderRegressionFixture) {
    // The model regression gap spec needs both dormant workspace switching and the legacy default workspace
    // for provider/replay helpers to initialize; both go into the same lastWorkspaceSession, to avoid
    // the test injecting a workspace directly and bypassing the user-visible sidebar entry.
    mkdirSync(legacyDefaultProjectPath, { recursive: true });
  }
  if (!useFreshConversationWorkspace && !agentWarmupFixture) {
    // Many existing E2E cases use an already-open project as a precondition; the product's first launch has switched to conversation,
    // so the test baseline explicitly seeds a project session, to avoid mistaking an old case's fixture for new user default behavior.
    mkdirSync(legacyDefaultProjectPath, { recursive: true });
  }
  const now = Date.now();
  const codingPlanTeamSpec = shouldUseCodingPlanTeamMock(specs);
  const codingPlanUpgradeE2E = isCodingPlanUpgradeE2E(specs);
  const oauthCredentialRecoverySpec = isOAuthCredentialRecoverySpec(specs);
  const jwtExpiryReauthenticationSpec = isJwtExpiryReauthenticationSpec(specs);
  const subagentLoginCatalogStaleSpec = isSubagentCodingPlanLoginCatalogStaleSpec(specs);
  const builtInSubagentModelOverridesSpec = isBuiltInSubagentModelSelectionOverridesSpec(specs);
  const providerReadinessColdStartFixture = usesProviderReadinessColdStartFixture(specs);
  const shouldUseBigmodelAuth = codingPlanTeamSpec || codingPlanUpgradeE2E;
  const authProviderId = shouldUseBigmodelAuth ? BIGMODEL_PROVIDER_ID : E2E_AUTH_PROVIDER_ID;
  writeFileSync(
    E2E_APP_SETTINGS_FILE,
    JSON.stringify(
      {
        providerFamilyDomain: shouldUseBigmodelAuth ? "bigmodel" : "zai",
        providerFamilyDomainMigrated: true,
        providerFamilyDomainUpdatedAt: now,
        ...(modelProviderRegressionFixture
          ? {
              recentProjects: [legacyDefaultProjectPath, ...passiveWorkspacePaths],
              lastWorkspaceSession: [legacyDefaultProjectPath, ...passiveWorkspacePaths].map(
                (workspacePath) => ({
                  kind: "local" as const,
                  workspacePath,
                  workspacePurpose: "project" as const,
                }),
              ),
              lastActiveTabIndex: 0,
            }
          : agentWarmupFixture
            ? {
                recentProjects: passiveWorkspacePaths,
                lastWorkspaceSession: passiveWorkspacePaths.map((workspacePath) => ({
                  kind: "local" as const,
                  workspacePath,
                  workspacePurpose: "project" as const,
                })),
                lastActiveTabIndex: agentWarmupScenario.activeWorkspaceIndex,
              }
            : !useFreshConversationWorkspace
              ? {
                  lastWorkspaceSession: [
                    {
                      kind: "local",
                      workspacePath: legacyDefaultProjectPath,
                      workspacePurpose: "project",
                    },
                  ],
                  lastActiveTabIndex: 0,
                }
              : {}),
        ...(shouldSeedGuideInteractionBehavior(specs)
          ? {
              // steer-related reproduction needs to enter guide mode from the current worker's initial settings;
              // changing setting.json while running would be overwritten by the app's startup-state write-back, so it still runs queue.
              zcodeInteractionBehavior: "guide",
            }
          : {}),
        providerFamilyConnectionSelections: shouldUseBigmodelAuth
          ? { bigmodel: { kind: "individual-coding-plan" } }
          : {},
        ...(upstreamCaptureProxy
          ? {
              // Fix reason: the agent subprocess trusts only the proxy config explicitly set in the settings page and does not read
              // the standard HTTPS_PROXY in the WDIO process; capture mode must preset it here to catch real requests.
              httpProxy: upstreamCaptureProxy.proxyUrl,
              httpProxyCaCertPath: upstreamCaptureProxy.caCertPath,
              httpProxyNoProxy: DEFAULT_E2E_NETWORK_CAPTURE_NO_PROXY,
            }
          : {}),
      },
      null,
      2,
    ),
    "utf-8",
  );
  writeFileSync(
    E2E_APP_CREDENTIALS_FILE,
    JSON.stringify(
      // Reason: the anonymous callback failure case needs no fake JWT; the 401 expiry confirmation layer would cover the login entry under test.
      providerReadinessColdStartFixture ||
        workerSpecsContain(specs, "oauth-login-failure-cancel.test.ts")
        ? {}
        : // Bug cause: I20 does not verify account login but seeds a fake ZCode JWT; a bypass request carrying account identity
          // would be sent to the real control plane, and the 401 would then pop a login-expired dialog that covers the target interaction.
          // This case keeps only the local Provider replay and injects no unrelated account identity.
          builtInSubagentModelOverridesSpec
          ? {}
          : subagentLoginCatalogStaleSpec
            ? {}
            : oauthCredentialRecoverySpec
              ? createCorruptOAuthCredentialSeed(authProviderId)
              : jwtExpiryReauthenticationSpec
                ? createExpiredJwtOAuthCredentialSeed(authProviderId)
                : createE2EStartupCredentialSeed({
                    specs,
                    legacyAuthToken: E2E_AUTH_TOKEN,
                    restoredOAuthCredentials: {
                      "oauth:active_provider": authProviderId,
                      // Account mock covers only the selected family; smuggling in another fake account would access an unmanaged real control plane.
                      [`oauth:${authProviderId}:access_token`]: shouldUseBigmodelAuth
                        ? "e2e-bigmodel-oauth-token"
                        : E2E_AUTH_TOKEN,
                      [`oauth:${authProviderId}:user_info`]: JSON.stringify(E2E_USER_PROFILE),
                      zcodejwttoken: E2E_AUTH_TOKEN,
                    },
                  }),
      null,
      2,
    ),
    "utf-8",
  );
}

function isOAuthCredentialRecoverySpec(specs: string[] = []) {
  return workerSpecsContain(specs, OAUTH_CREDENTIAL_RECOVERY_SPEC);
}

function isJwtExpiryReauthenticationSpec(specs: string[] = []) {
  return workerSpecsContain(specs, JWT_EXPIRY_REAUTHENTICATION_SPEC);
}

function isSubagentCodingPlanLoginCatalogStaleSpec(specs: string[] = []) {
  return workerSpecsContain(specs, SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_SPEC);
}

function usesProviderReadinessColdStartFixture(specs: string[] = []) {
  // Bug cause: windows-agent-metric-probe-absence.test.ts registers its describe only on win32,
  // so on macOS/Linux it runs no case. Seeding its fixture there aborts beforeSession because
  // the CLI DB is never created; gate it on the same platform check the spec uses.
  return (
    workerSpecsContain(specs, PROVIDER_READINESS_AGENT_STARTUP_SPEC) ||
    (process.platform === "win32" &&
      workerSpecsContain(specs, WINDOWS_AGENT_METRIC_PROBE_ABSENCE_SPEC))
  );
}

function usesContextWindowColdResumeFixture(specs: string[] = []) {
  return workerSpecsContain(specs, CONTEXT_WINDOW_COLD_RESUME_SPEC);
}

function usesTaskIndexRowAuthorityFixture(specs: string[] = []) {
  return workerSpecsContain(specs, TASK_INDEX_ROW_AUTHORITY_SPEC);
}

function usesGitReviewEntryFixture(specs: string[] = []) {
  return workerSpecsContain(specs, GIT_REVIEW_ENTRY_SPEC);
}

async function seedE2EGitReviewEntryWorkspace(specs: string[] = []) {
  if (!usesGitReviewEntryFixture(specs)) return;

  const workspacePath = resolve(E2E_HOME_DIR, "ZCodeProject");
  const caseRoot = resolve(workspacePath, ".zcode-e2e/conversation-session-git-review-entry");
  await mkdir(caseRoot, { recursive: true });
  await runGitReviewEntryCommand(workspacePath, ["init"]);
  await runGitReviewEntryCommand(workspacePath, ["checkout", "-B", "main"]);
  await writeFile(
    resolve(caseRoot, "status-panel-review.txt"),
    "status panel Git review e2e fixture\n",
    "utf8",
  );
}

async function runGitReviewEntryCommand(cwd: string, args: string[]) {
  await execFileAsync(process.env.ZCODE_GIT_BINARY?.trim() || "git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
}

function createCorruptOAuthCredentialSeed(authProviderId: string): Record<string, string> {
  const corruptEncryptedValue = "enc:v1:bad.bad.bad";
  const corruptTokenProvider = process.env.ZCODE_E2E_CORRUPT_OAUTH_TOKEN_PROVIDER;
  if (corruptTokenProvider === BIGMODEL_PROVIDER_ID || corruptTokenProvider === ZAI_PROVIDER_ID) {
    // A corrupted business token once bypassed the decryption cleanup in startup recovery; only a healthy shared JWT and profile isolate this path.
    return {
      "oauth:active_provider": corruptTokenProvider,
      [`oauth:${corruptTokenProvider}:access_token`]: corruptEncryptedValue,
      [`oauth:${corruptTokenProvider}:refresh_token`]: "stale-refresh-token",
      [`oauth:${corruptTokenProvider}:user_info`]: JSON.stringify(
        corruptTokenProvider === ZAI_PROVIDER_ID
          ? { user_id: "e2e-user", name: "Fixture User" }
          : { id: "e2e-user", username: "Fixture User", displayName: "Fixture User" },
      ),
      zcodejwttoken: "e2e-valid-opaque-jwt",
      "bot:e2e:credential": "e2e-independent-bot-token",
    };
  }
  return {
    // Bugfix: this spec needs a cold start to reproduce the online state of "ciphertext exists but the current machine cannot decrypt it";
    // corrupting only the active provider is enough to trigger OAuth session cleanup, and to verify the user still sees the login entry.
    "oauth:active_provider": corruptEncryptedValue,
    [`oauth:${authProviderId}:access_token`]: "stale-access-token",
    [`oauth:${authProviderId}:refresh_token`]: "stale-refresh-token",
    [`oauth:${authProviderId}:user_info`]: JSON.stringify(E2E_USER_PROFILE),
    [`oauth:${BIGMODEL_PROVIDER_ID}:access_token`]: "stale-bigmodel-access-token",
    [`oauth:${BIGMODEL_PROVIDER_ID}:refresh_token`]: "stale-bigmodel-refresh-token",
    [`oauth:${BIGMODEL_PROVIDER_ID}:user_info`]: JSON.stringify(E2E_USER_PROFILE),
    zcodejwttoken: "stale-zcode-jwt-token",
    "bot:e2e:credential": "e2e-independent-bot-token",
  };
}

function createExpiredJwtOAuthCredentialSeed(authProviderId: string): Record<string, string> {
  return {
    "oauth:active_provider": authProviderId,
    [`oauth:${authProviderId}:access_token`]: "expired-session-access-token",
    [`oauth:${authProviderId}:refresh_token`]: "expired-session-refresh-token",
    [`oauth:${authProviderId}:user_info`]: JSON.stringify(E2E_USER_PROFILE),
    // Bug regression fixture: exp=1 is explicitly earlier than any test run time; the client parses only exp,
    // and does not verify the signature of this local test JWT.
    zcodejwttoken: "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJleHAiOjF9.e2e",
  };
}

function isCodingPlanUpgradeE2E(specs: string[] = []) {
  return resolveCodingPlanUpgradeMockScenario(specs) !== null;
}

function shouldSeedGuideInteractionBehavior(specs: string[] = []) {
  return specs.some(
    (arg) =>
      arg.includes("conversation-session-running-guide-steer.test.ts") ||
      arg.includes("conversation-session-background-guide-steer.test.ts"),
  );
}

// Maps the plugin MCP skill lifecycle spec name to seed state.
// State A writes no plugin record; state B installs and enables; state C installs but disables it via
// `config.json#plugins.enabledPlugins[id] = false`. Read order:
// ZCODE_E2E_PLUGIN_MCP_SKILL_STATE env var > spec filename convention.
const PLUGIN_MCP_SKILL_SPEC_PATTERN =
  /conversation-session-plugin-mcp-skill-(not-installed|installed-enabled|installed-disabled|workspace-enabled|workspace-disabled|workspace-inherited|workspace-isolation|workspace-root|workspace-freeze)\.test\.ts/u;
const PLUGIN_MCP_SKILL_STATES = new Set([
  "not-installed",
  "installed-enabled",
  "installed-disabled",
  "workspace-enabled",
  "workspace-disabled",
  "workspace-inherited",
  "workspace-isolation",
  "workspace-root",
  "workspace-freeze",
]);

function resolvePluginMcpSkillState(
  specs: string[] = [],
):
  | "not-installed"
  | "installed-enabled"
  | "installed-disabled"
  | "workspace-enabled"
  | "workspace-disabled"
  | "workspace-inherited"
  | "workspace-isolation"
  | "workspace-root"
  | "workspace-freeze"
  | null {
  const envState = process.env.ZCODE_E2E_PLUGIN_MCP_SKILL_STATE?.trim();
  if (envState && PLUGIN_MCP_SKILL_STATES.has(envState)) {
    return envState as Exclude<ReturnType<typeof resolvePluginMcpSkillState>, null>;
  }
  for (const arg of specs) {
    if (arg.includes("conversation-session-plugin-resident-freeze-cold-resume.test.ts")) {
      return "workspace-freeze";
    }
    const match = arg.match(PLUGIN_MCP_SKILL_SPEC_PATTERN);
    if (match && match[1]) {
      return match[1] as
        | "not-installed"
        | "installed-enabled"
        | "installed-disabled"
        | "workspace-enabled"
        | "workspace-disabled"
        | "workspace-inherited"
        | "workspace-isolation"
        | "workspace-root"
        | "workspace-freeze";
    }
  }
  return null;
}

// State A needs no file writes; only B and C write fixtures.
// This must be called after `seedUpstreamE2EModelConfig`, because it patches
// the `~/.zcode/cli/config.json` we just wrote, setting `plugins.enabledPlugins[id]`
// to false to express "installed but disabled".
function seedE2EPluginMcpSkillState(specs: string[] = []) {
  const state = resolvePluginMcpSkillState(specs);
  if (!state || state === "not-installed" || state.startsWith("workspace-")) return;
  const configPath = resolve(E2E_CLI_CONFIG_DIR, "config.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error as { code?: string }).code !== "ENOENT"
    ) {
      throw error;
    }
  }

  const plugins = (config.plugins as Record<string, unknown> | undefined) ?? {};
  const enabledPlugins = (plugins.enabledPlugins as Record<string, boolean> | undefined) ?? {};
  const pluginId = "e2e-plugin-mcp-ping@e2e-fixture";
  // Bugfix: an installable plugin has defaultEnabled=false when the candidate is constructed (see
  // apps/zcode-cli/packages/adapters/src/plugins/index.ts:resolveCandidates）；
  // resolveEnabled uses `config.enabledPlugins[id] ?? defaultEnabled` to decide,
  // so the enabled state must be explicitly written as true; you cannot just delete the field.
  if (state === "installed-disabled") {
    enabledPlugins[pluginId] = false;
  } else {
    enabledPlugins[pluginId] = true;
  }
  plugins.enabledPlugins = enabledPlugins;
  config.plugins = plugins;
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

// The Provider Registry no longer writes the CLI config; the plugin fixture must explicitly create its own config and must not rely on model-initialization side effects.
async function readOptionalE2ECliConfig(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

async function seedE2EWorkspacePluginState(specs: string[] = []) {
  const state = resolvePluginMcpSkillState(specs);
  if (!state?.startsWith("workspace-")) return;

  const workspacePath = resolve(E2E_HOME_DIR, "ZCodeProject");
  const userConfigPath = resolve(E2E_CLI_CONFIG_DIR, "config.json");
  const workspaceConfigPath = resolve(workspacePath, ".zcode", "config.json");
  const pluginId = "e2e-plugin-mcp-ping@e2e-fixture";
  const pluginRoot = resolve(DESKTOP_DIR, "test/e2e/fixtures/plugin-mcp-skill/e2e-plugin-mcp-ping");
  await mkdir(resolve(workspacePath, ".zcode"), { recursive: true });
  const userConfig = await readOptionalE2ECliConfig(userConfigPath);
  const userPlugins = (userConfig.plugins as Record<string, unknown> | undefined) ?? {};
  const userEnabledPlugins =
    (userPlugins.enabledPlugins as Record<string, boolean> | undefined) ?? {};
  const userOptions =
    (userPlugins.options as Record<string, Record<string, unknown>> | undefined) ?? {};
  userEnabledPlugins[pluginId] = state !== "workspace-isolation";
  userOptions[pluginId] = {
    label: "user-label",
    secret: "E2E_USER_PLUGIN_SECRET",
  };
  userPlugins.enabledPlugins = userEnabledPlugins;
  userPlugins.options = userOptions;
  userConfig.plugins = userPlugins;
  await mkdir(E2E_CLI_CONFIG_DIR, { recursive: true });
  await writeFile(userConfigPath, JSON.stringify(userConfig, null, 2), "utf-8");

  const workspaceEnabledPlugins =
    state === "workspace-inherited"
      ? {}
      : {
          [pluginId]:
            state === "workspace-enabled" ||
            state === "workspace-isolation" ||
            state === "workspace-root" ||
            state === "workspace-freeze",
        };
  const workspaceDirs = state === "workspace-root" ? [pluginRoot] : undefined;
  await writeFile(
    workspaceConfigPath,
    JSON.stringify(
      {
        plugins: {
          ...(workspaceDirs ? { dirs: workspaceDirs } : {}),
          enabledPlugins: workspaceEnabledPlugins,
          options: {
            [pluginId]: {
              label: "workspace-label",
              secret: "E2E_WORKSPACE_PLUGIN_SECRET",
            },
          },
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  if (state === "workspace-isolation") {
    await mkdir(resolve(E2E_HOME_DIR, "WorkspaceB"), { recursive: true });
  }
}

async function seedE2EBuiltinWorkspacePluginDisable(specs: string[] = []) {
  if (
    !specs.some((spec) =>
      spec.includes("conversation-session-plugin-builtin-workspace-disable.test.ts"),
    )
  ) {
    return;
  }

  const pluginId = "skill-creator@zcode-plugins-official";
  const workspaceA = resolve(E2E_HOME_DIR, "ZCodeProject");
  const workspaceB = resolve(E2E_HOME_DIR, "WorkspaceB");
  const userConfig = await readOptionalE2ECliConfig(E2E_CLI_CONFIG_FILE);
  const userPlugins = (userConfig.plugins as Record<string, unknown> | undefined) ?? {};
  const enabledPlugins = (userPlugins.enabledPlugins as Record<string, boolean> | undefined) ?? {};
  const options =
    (userPlugins.options as Record<string, Record<string, unknown>> | undefined) ?? {};
  enabledPlugins[pluginId] = true;
  options[pluginId] = { e2e: "preserve-user-option" };
  userPlugins.enabledPlugins = enabledPlugins;
  userPlugins.options = options;
  userConfig.plugins = userPlugins;
  await mkdir(E2E_CLI_CONFIG_DIR, { recursive: true });
  await writeFile(E2E_CLI_CONFIG_FILE, `${JSON.stringify(userConfig, null, 2)}\n`, "utf-8");

  await mkdir(resolve(workspaceA, ".zcode"), { recursive: true });
  await mkdir(workspaceB, { recursive: true });
  await writeFile(
    resolve(workspaceA, ".zcode", "config.json"),
    `${JSON.stringify(
      {
        plugins: {
          enabledPlugins: {
            [pluginId]: false,
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  const pluginDataDir = resolve(E2E_CLI_CONFIG_DIR, "plugins", "data", pluginId);
  await mkdir(pluginDataDir, { recursive: true });
  await writeFile(
    resolve(pluginDataDir, "state.json"),
    `${JSON.stringify({ marker: "preserve-user-data" }, null, 2)}\n`,
    "utf-8",
  );
}

async function seedE2EModelConfig(specs: string[] = []) {
  if (usesContextWindowColdResumeFixture(specs)) {
    await seedContextWindowColdResumeModelConfig();
    return;
  }
  await seedUpstreamE2EModelConfig(specs);
  await seedModelOutputTokenProviders(specs);
}

interface ModelOutputTokenProviderSeed {
  apiFormat?: "openai-chat-completions" | "openai-responses";
  id: string;
  kind?: "openai" | "openai-compatible";
  models: Array<{
    contextWindow: number;
    id: string;
    limitOutput?: number;
    maxOutputTokens?: number;
  }>;
  name: string;
  supportedFormat?: "openai" | "responses";
}

function seedE2EWorkerModelStreamConfig(specs: string[] = []) {
  const modelStreamIdleTimeoutMs = resolveE2EWorkerModelStreamIdleTimeoutMs(specs);
  if (modelStreamIdleTimeoutMs === undefined) return;
  mkdirSync(E2E_CLI_CONFIG_DIR, { recursive: true });
  writeFileSync(
    E2E_CLI_CONFIG_FILE,
    JSON.stringify({ modelStream: { idleTimeoutMs: modelStreamIdleTimeoutMs } }, null, 2),
    "utf-8",
  );
}

async function seedModelOutputTokenProviders(specs: string[] = []) {
  const providerSeeds: ModelOutputTokenProviderSeed[] = [];
  if (specs.some((spec) => spec.includes(MODEL_OUTPUT_TOKEN_BUDGET_SPEC))) {
    providerSeeds.push({
      id: "output-token-budget-e2e",
      models: [
        { contextWindow: 128_000, id: "otb-default" },
        { contextWindow: 128_000, id: "otb-16k", limitOutput: 16_000 },
        { contextWindow: 128_000, id: "otb-64k", maxOutputTokens: 64_000 },
        { contextWindow: 128_000, id: "otb-runtime-refresh" },
      ],
      name: "Output Token Budget E2E",
    });
  }
  if (specs.some((spec) => spec.includes(MODEL_OUTPUT_TOKEN_PREFLIGHT_SPEC))) {
    providerSeeds.push({
      id: "output-token-preflight-e2e",
      models: [
        {
          contextWindow: 128_000,
          id: "otb-preflight-64k",
          limitOutput: 64_000,
        },
        {
          contextWindow: 64_000,
          id: "otb-preflight-smoke-64k-48k",
          limitOutput: 48_000,
        },
        {
          contextWindow: 200_000,
          id: "otb-preflight-smoke-200k-128k",
          limitOutput: 128_000,
        },
      ],
      name: "Output Token Preflight E2E",
    });
  }
  if (specs.some((spec) => spec.includes(OUTPUT_LIMIT_CONTINUE_MARKDOWN_PROTOCOLS_SPEC))) {
    providerSeeds.push(
      {
        id: "otc-protocol-chat",
        models: [{ contextWindow: 128_000, id: "otc-protocol-chat" }],
        name: "OTC Chat Completions E2E",
      },
      {
        apiFormat: "openai-responses",
        id: "otc-protocol-responses",
        kind: "openai",
        models: [{ contextWindow: 128_000, id: "otc-protocol-responses" }],
        name: "OTC Responses API E2E",
        supportedFormat: "responses",
      },
    );
  }
  if (providerSeeds.length === 0) {
    return;
  }

  const apiKey =
    upstreamE2EHttpMode === "replay"
      ? E2E_PROVIDER_REPLAY_API_KEY
      : (process.env.E2E_PROVIDER_API_KEY?.trim() ?? "");
  if (!apiKey || apiKey === "xxx") {
    throw new Error("Output-token E2E 缺少可用 provider API Key");
  }
  const appProviders = providerSeeds.map(
    (provider): PersonalProviderConfigSeed => ({
      // OTC11 explicitly verifies two protocols; the Responses seed must not be overwritten by Chat Completions.
      apiFormat: provider.apiFormat ?? "openai-chat-completions",
      apiKey,
      baseURL: upstreamE2EBaseUrl,
      enabled: true,
      id: provider.id,
      label: provider.name,
      models: provider.models.map((model) => ({
        contextWindow: model.contextWindow,
        id: model.id,
        ...(model.maxOutputTokens === undefined && model.limitOutput === undefined
          ? {}
          : { maxOutputTokens: model.maxOutputTokens ?? model.limitOutput }),
      })),
    }),
  );
  for (const provider of appProviders) {
    await seedPersonalProviderConfig(E2E_APP_PROVIDER_CONFIG_FILE, provider);
  }
}

async function seedContextWindowColdResumeModelConfig() {
  const apiKey =
    upstreamE2EHttpMode === "replay"
      ? E2E_PROVIDER_REPLAY_API_KEY
      : (process.env.E2E_PROVIDER_API_KEY?.trim() ?? "");
  if (!apiKey || apiKey === "xxx") {
    throw new Error("context-window cold-resume 缺少可用 provider API Key");
  }
  const provider: PersonalProviderConfigSeed = {
    id: CONTEXT_WINDOW_COLD_RESUME_PROVIDER_ID,
    label: CONTEXT_WINDOW_COLD_RESUME_PROVIDER_NAME,
    baseURL: upstreamE2EBaseUrl,
    apiFormat: "openai-chat-completions",
    apiKey,
    enabled: true,
    models: [
      {
        id: CONTEXT_WINDOW_COLD_RESUME_MODEL_ID,
        contextWindow: CONTEXT_WINDOW_COLD_RESUME_MAX_TOKENS,
        maxOutputTokens: CONTEXT_WINDOW_COLD_RESUME_MAX_OUTPUT_TOKENS,
      },
    ],
  };
  await seedPersonalProviderConfig(E2E_APP_PROVIDER_CONFIG_FILE, provider);
  mkdirSync(E2E_APP_CONFIG_DIR, { recursive: true });
  await seedPersonalDefaultModelSelection(E2E_APP_PROVIDER_CONFIG_FILE, {
    providerId: CONTEXT_WINDOW_COLD_RESUME_PROVIDER_ID,
    modelId: CONTEXT_WINDOW_COLD_RESUME_MODEL_ID,
  });
}

function isSubagentProviderRegistryColdStartSpec(specs: string[] = []) {
  return specs.some((spec) => spec.includes(SUBAGENT_PROVIDER_REGISTRY_COLD_START_SPEC));
}

function isBuiltInSubagentModelSelectionOverridesSpec(specs: string[] = []) {
  return specs.some((spec) => spec.includes(BUILT_IN_SUBAGENT_MODEL_OVERRIDES_SPEC));
}

function isSettingsSubagentCreateEditPersistenceSpec(specs: string[] = []) {
  return specs.some((spec) => spec.includes(SETTINGS_SUBAGENT_CREATE_EDIT_PERSISTENCE_SPEC));
}

function isSubagentRuntimeCatalogReasoningSpec(specs: string[] = []) {
  return specs.some((spec) => spec.includes(SUBAGENT_RUNTIME_CATALOG_REASONING_SPEC));
}

function isOffPeakSubagentModelInheritanceSpec(specs: string[] = []) {
  return specs.some((spec) => spec.includes(OFFPEAK_SUBAGENT_MODEL_INHERITANCE_SPEC));
}

function isOffPeakInvalidTicketSpec(specs: string[] = []) {
  return specs.some((spec) => spec.includes(OFFPEAK_INVALID_TICKET_SPEC));
}

function isModelProviderPlanSurfaceSpec(specs: string[] = []) {
  return specs.some((spec) => spec.includes(MODEL_PROVIDER_PLAN_SURFACE_SPEC));
}

function isToolErrorSurfaceSpec(specs: string[] = []) {
  return specs.some((spec) => spec.includes(TOOL_ERROR_SURFACE_SPEC));
}

function seedE2EBuiltInSubagentModelOverrides(specs: string[] = []) {
  const builtInModelSelectionOverridesSpec = isBuiltInSubagentModelSelectionOverridesSpec(specs);
  const runtimeCatalogSpec = isSubagentRuntimeCatalogReasoningSpec(specs);
  const offPeakSubagentModelInheritanceSpec = isOffPeakSubagentModelInheritanceSpec(specs);
  if (
    !builtInModelSelectionOverridesSpec &&
    !runtimeCatalogSpec &&
    !offPeakSubagentModelInheritanceSpec
  ) {
    return;
  }

  // Bug cause: browser.reloadSession() triggers beforeSession again. If this were written unconditionally,
  // the structured selection the test just saved in the settings page would be overwritten by the initial fixture before the cold start,
  // so "cold recovery" would verify the seed rather than the user's persisted result. Write to disk only when the initial HOME is empty.
  if (existsSync(E2E_AGENTS_STATE_FILE)) {
    return;
  }

  const overrideSelection = runtimeCatalogSpec
    ? {
        providerId: SUBAGENT_RUNTIME_CATALOG_PROVIDER_ID,
        modelId: SUBAGENT_RUNTIME_CATALOG_MODEL,
      }
    : {
        providerId: E2E_PROVIDER_ALTERNATE_PROVIDER_ID,
        modelId: E2E_PROVIDER_SECONDARY_MODEL,
      };
  const initialGeneralPurposeSelection =
    runtimeCatalogSpec || offPeakSubagentModelInheritanceSpec
      ? overrideSelection
      : {
          providerId: e2eProviderPreset.providerId,
          modelId: e2eProviderPreset.model,
        };
  mkdirSync(E2E_APP_CONFIG_DIR, { recursive: true });
  writeFileSync(
    E2E_AGENTS_STATE_FILE,
    JSON.stringify(
      {
        builtInModelSelectionOverrides: {
          Explore: {
            ...overrideSelection,
            ...(builtInModelSelectionOverridesSpec || runtimeCatalogSpec
              ? { options: { reasoningLevel: "invalid-e2e" } }
              : {}),
          },
          "general-purpose": {
            ...initialGeneralPurposeSelection,
            ...(runtimeCatalogSpec ? { options: { reasoningLevel: "high" } } : {}),
          },
        },
        disabledAgentIds: [],
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function seedE2ESubagentProfiles(specs: string[] = []) {
  if (specs.some((spec) => spec.includes("conversation-session-subagent-cross-host.test.ts"))) {
    // The built-in document plugin has been split out with a pinned model; the override/clear-override scenarios use their own inherited model fixture.
    const pluginDir = resolve(E2E_STORAGE_ROOT, "cli/plugins");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      resolve(pluginDir, "installed_plugins.json"),
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "e2e-subagent-refresh@e2e-fixture",
            name: "e2e-subagent-refresh",
            marketplace: "e2e-fixture",
            version: "1.0.0",
            installPath: resolve(DESKTOP_DIR, "test/e2e/fixtures/subagent-refresh-plugin"),
            installedAt: "2026-09-18T00:00:00.000Z",
            updatedAt: "2026-09-18T00:00:00.000Z",
            scope: "user",
          },
        ],
      }),
    );
    const config = existsSync(E2E_CLI_CONFIG_FILE)
      ? JSON.parse(readFileSync(E2E_CLI_CONFIG_FILE, "utf8"))
      : {};
    config.plugins = {
      ...config.plugins,
      enabledPlugins: {
        ...config.plugins?.enabledPlugins,
        "e2e-subagent-refresh@e2e-fixture": true,
      },
    };
    writeFileSync(E2E_CLI_CONFIG_FILE, JSON.stringify(config));
  }
  const profileEntries: Array<{ content: string; name: string }> = [];

  if (isBuiltInSubagentModelSelectionOverridesSpec(specs)) {
    profileEntries.push({
      name: SUBAGENT_REASONING_AGENT_NAME,
      content: `---
name: ${SUBAGENT_REASONING_AGENT_NAME}
description: E2E custom subagent for reasoning effort persistence coverage.
model: custom:${E2E_PROVIDER_ALTERNATE_PROVIDER_ID}:${E2E_PROVIDER_SECONDARY_MODEL}
thoughtLevel: invalid-e2e
tools: Read
maxTurns: 1
---
You are the E2E reasoning reviewer. Reply only with the requested marker.
`,
    });
  }

  if (isSubagentRuntimeCatalogReasoningSpec(specs)) {
    profileEntries.push({
      name: SUBAGENT_RUNTIME_CATALOG_AGENT_NAME,
      content: `---
name: ${SUBAGENT_RUNTIME_CATALOG_AGENT_NAME}
description: E2E custom subagent for runtime reasoning catalog coverage.
model: custom:${SUBAGENT_RUNTIME_CATALOG_PROVIDER_ID}:${SUBAGENT_RUNTIME_CATALOG_MODEL}
thoughtLevel: invalid-e2e
tools: Read
maxTurns: 1
---
You are the E2E Claude catalog reviewer. Reply only with the requested marker.
`,
    });
  }

  if (isSubagentProviderRegistryColdStartSpec(specs)) {
    profileEntries.push({
      name: SUBAGENT_PROVIDER_REGISTRY_AGENT_NAME,
      content: `---
name: ${SUBAGENT_PROVIDER_REGISTRY_AGENT_NAME}
description: E2E subagent bound to an alternate provider for cold-start registry sync reproduction.
model: custom:${E2E_PROVIDER_ALTERNATE_PROVIDER_ID}:${E2E_PROVIDER_SECONDARY_MODEL}
thoughtLevel: high
tools: Read
maxTurns: 1
---
You are the E2E provider registry reviewer. Reply only with the requested marker.
`,
    });
  }

  if (isOffPeakSubagentModelInheritanceSpec(specs)) {
    profileEntries.push(
      {
        name: "Code Search",
        content: `---
name: Code Search
description: E2E custom foreground subagent with an explicit alternate provider model.
model: custom:${E2E_PROVIDER_ALTERNATE_PROVIDER_ID}:${E2E_PROVIDER_SECONDARY_MODEL}
tools: Read
maxTurns: 1
---
You are the E2E Code Search reviewer. Reply only with the requested marker.
`,
      },
      {
        name: "E2E OffPeak Inherit Reviewer",
        content: `---
name: E2E OffPeak Inherit Reviewer
description: E2E custom foreground subagent that normally inherits the session model.
tools: Read
maxTurns: 1
---
You are the E2E inherited-model reviewer. Reply only with the requested marker.
`,
      },
      {
        name: "E2E OffPeak Background Reviewer",
        content: `---
name: E2E OffPeak Background Reviewer
description: E2E custom profile configured to run in the background.
model: custom:${E2E_PROVIDER_ALTERNATE_PROVIDER_ID}:${E2E_PROVIDER_SECONDARY_MODEL}
tools: Read
background: true
maxTurns: 1
---
This E2E profile must be rejected before any provider request during an idle-plan turn.
`,
      },
    );
  }

  if (isToolErrorSurfaceSpec(specs)) {
    profileEntries.push(
      {
        name: TOOL_ERROR_SURFACE_STALE_AGENT_NAME,
        content: `---
name: ${TOOL_ERROR_SURFACE_STALE_AGENT_NAME}
description: E2E subagent intentionally bound to a stale provider/model for tool error surface coverage.
model: custom:e2e-stale-provider:e2e-stale-model
tools: Read
maxTurns: 1
---
You are the stale E2E reviewer. This profile should fail before any child model request.
`,
      },
      {
        name: TOOL_ERROR_SURFACE_HEALTHY_AGENT_NAME,
        content: `---
name: ${TOOL_ERROR_SURFACE_HEALTHY_AGENT_NAME}
description: E2E subagent used as the healthy sibling when another Agent tool fails.
tools: Read
maxTurns: 1
---
You are the healthy E2E reviewer. Reply only with the requested marker.
`,
      },
    );
  }

  if (specs.some((spec) => spec.includes(SUBAGENT_TEAM_SCOPE_SPEC))) {
    profileEntries.push({
      name: "e2e-team-scope-reviewer",
      content: `---
name: e2e-team-scope-reviewer
description: E2E custom subagent bound to a Team connection without organization/project scope.
model: custom:team-plan:e2e-missing-scope:team-model
tools: Read
maxTurns: 1
---
This child must fail before sending a provider request when the Team scope is unavailable.
`,
    });
  }

  if (profileEntries.length === 0) {
    return;
  }

  for (const agentsDir of [E2E_USER_AGENTS_DIR, E2E_CLI_AGENTS_DIR]) {
    // Fix reason: the CLI runtime loads user subagent profiles from storageRoot/agents,
    // while the settings page and history paths used .zcode/cli/agents. Dual-writing applies only to this reproduction spec,
    // so path differences do not stall the case at "agent type not found" instead of at a missing provider registry.
    mkdirSync(agentsDir, { recursive: true });
    for (const profile of profileEntries) {
      const profilePath = resolve(agentsDir, `${profile.name}.md`);
      // Same as agents-state: reloadSession must not overwrite the current Markdown already saved in the settings page.
      if (!existsSync(profilePath)) {
        writeFileSync(profilePath, profile.content, "utf-8");
      }
    }
  }
}

async function seedUpstreamE2EModelConfig(specs: string[] = []) {
  if (isOAuthCredentialRecoverySpec(specs) || usesProviderReadinessColdStartFixture(specs)) {
    // Bugfix: the OAuth credential recovery and provider-readiness cold-start fixtures must keep
    // no available local model config, so the default upstream replay provider cannot bypass the login/execution gate.
    return;
  }

  const apiKey =
    upstreamE2EHttpMode === "replay"
      ? E2E_PROVIDER_REPLAY_API_KEY
      : (process.env.E2E_PROVIDER_API_KEY?.trim() ?? "");
  if (!apiKey || apiKey === "xxx") {
    return;
  }

  // Fix reason: fixed e2e replays the recorded capture fixtures by default; only capture mode hits the online
  // upstream. The baseURL must follow the current HTTP mode and be written into the config before each session reset.
  const anthropicBaseURL = buildUpstreamE2EAnthropicBaseUrl();
  const modelProviderListFilteringSpec = specs.some((spec) =>
    spec.includes("conversation-session-model-provider-list-filtering.test.ts"),
  );
  const builtInSubagentModelOverridesSpec = isBuiltInSubagentModelSelectionOverridesSpec(specs);
  const settingsSubagentCreateEditPersistenceSpec =
    isSettingsSubagentCreateEditPersistenceSpec(specs);
  const exposeSubagentReasoningMetadata =
    // Model config isolation and Edit/Fork inheritance check request parameters directly; an empty mapping would swallow the selected tier.
    specs.some((spec) =>
      /conversation-session-(model-config|model-switch-tool-edit-fork|model-switch-compact|model-switch-auto-compact|goal-session-model|new-session-inherits-model|draft-model-switch-first-send|model-provider-session-isolation|upstream-workspace-smoke|model-switch-edit-fork|model-switch-queue|same-model-provider-identity)\.test\.ts$/.test(
        spec,
      ),
    ) ||
    // The SHR regression checks the child's real wire parameters; giving only the menu high/max while setting the map to {}
    // would remove the selected tier from the request, causing the config-update case to falsely report a lost parameter in the first round.
    specs.some((spec) =>
      /conversation-session-subagent-(runtime-refresh|catalog-refresh|profile-fields|context-boundaries|multi-workspace|cross-host)\.test\.ts$/.test(
        spec,
      ),
    ) ||
    // The thinking-isolation focused suite checks the real wire; an empty Map would make the parameter absent, so session isolation could not be verified.
    specs.some((spec) =>
      /conversation-session-(thought-level-session-isolation|readstate-model-isolation|v4-goal)\.test\.ts$/.test(
        spec,
      ),
    ) ||
    builtInSubagentModelOverridesSpec ||
    settingsSubagentCreateEditPersistenceSpec ||
    specs.some((spec) => spec.includes("plugin-subagent-override-cold.test.ts")) ||
    isSubagentCodingPlanLoginCatalogStaleSpec(specs);
  const subagentRuntimeCatalogReasoningSpec = isSubagentRuntimeCatalogReasoningSpec(specs);
  // Reason: the pending directory once used 240/80 uniformly, so ordinary follow-up insertions added an unrelated Compact,
  // and changed test semantics after moving files into the official directory. Only explicit auto-compaction scenarios use a small window.
  const autoCompactSpec = specs.some((spec) =>
    /conversation-session-(compact-auto|compact-auto-actions|goal-run-cases|model-switch-auto-compact|subagent-runtime-refresh)\.test\.ts$/.test(
      spec,
    ),
  );
  const contextWindow = upstreamE2EContextWindowOverride ?? (autoCompactSpec ? 240 : 128000);
  const maxOutputTokens = upstreamE2EMaxOutputTokensOverride ?? (autoCompactSpec ? 80 : undefined);
  // The menu only sets the intent for the next send; the App and Agent use the same window and no longer fake a 1-token trigger of the old guard.
  const appContextWindow = contextWindow;
  const appMaxOutputTokens = maxOutputTokens;
  mkdirSync(E2E_APP_CONFIG_DIR, { recursive: true });
  // The toolbar case actually selects high/max; declaring only disabled would fail before the interaction assertions run.
  const composerToolbarSpec = specs.some((spec) =>
    spec.includes("conversation-session-v4-composer-toolbar.test.ts"),
  );
  // The generic fixture carries a full Option Spec; SSH targets do not depend on the local E2E Built-in completion.
  // The Registry uses the last item as the highest tier; the old fixture put the default first, so the alternate's max was overridden by high.
  const reasoning = (): PersonalProviderConfigSeed["models"][number]["reasoningLevel"] => ({
    values: specs.some((spec) => spec.endsWith("conversation-session-v4-goal.test.ts"))
      ? ["high", "low", "max"]
      : // Default env preparation picks high; declaring only disabled would fail before entering the tested flow.
        e2eProviderPresetName === "env" ||
          e2eProviderPresetName === "stagingmodel" ||
          composerToolbarSpec
        ? builtInSubagentModelOverridesSpec
          ? ["off", "low", "high", "max"]
          : ["high", "max"]
        : ["disabled"],
    // Only the dedicated wire cases inject the thinking parameter; ordinary replay response pacing is controlled by the fixture.
    map: exposeSubagentReasoningMetadata
      ? '{"thinking":{"type":"enabled","budget_tokens":1024},"output_config":{"effort":reasoningLevel}}'
      : "{}",
  });
  const model = (
    id: string,
    visibility?: "visible" | "hidden",
  ): PersonalProviderConfigSeed["models"][number] => ({
    id,
    contextWindow: appContextWindow,
    // Image layout and Stop wrap-up cases must check the real image wire content, so these fixtures are restricted to supporting image input.
    ...(specs.some(
      (spec) =>
        spec.includes("conversation-session-v4-attachment-layout.test.ts") ||
        spec.includes("conversation-session-stop-tool-results.test.ts"),
    )
      ? { inputModalities: ["text", "image"] as const }
      : {}),
    ...(appMaxOutputTokens !== undefined ? { maxOutputTokens: appMaxOutputTokens } : {}),
    reasoningLevel: reasoning(),
    ...(visibility ? { enabled: visibility !== "hidden" } : {}),
  });
  const provider = (params: {
    apiKey?: string;
    baseURL?: string;
    enabled?: boolean;
    id: string;
    label: string;
    models: PersonalProviderConfigSeed["models"];
    visibility?: "visible" | "hidden";
  }): PersonalProviderConfigSeed => ({
    apiFormat: "anthropic-messages",
    apiKey: params.apiKey ?? apiKey,
    baseURL: params.baseURL ?? anthropicBaseURL,
    enabled: params.enabled ?? true,
    id: params.id,
    label: params.label,
    models: params.models,
    ...(params.visibility ? { visibility: params.visibility } : {}),
  });
  const appProviders: PersonalProviderConfigSeed[] = [
    provider({
      id: e2eProviderPreset.providerId,
      label: e2eProviderPreset.providerName,
      models: [
        model(e2eProviderPreset.model),
        ...(e2eProviderPresetName === "env" ? [model(E2E_PROVIDER_SECONDARY_MODEL)] : []),
      ],
    }),
    ...(e2eProviderPresetName === "env"
      ? [
          provider({
            id: E2E_PROVIDER_ALTERNATE_PROVIDER_ID,
            label: E2E_PROVIDER_ALTERNATE_PROVIDER_NAME,
            models: [model(E2E_PROVIDER_SECONDARY_MODEL)],
          }),
        ]
      : []),
    ...(subagentRuntimeCatalogReasoningSpec
      ? [
          provider({
            id: SUBAGENT_RUNTIME_CATALOG_PROVIDER_ID,
            label: SUBAGENT_RUNTIME_CATALOG_PROVIDER_NAME,
            // I68 verifies four-tier parent/child request isolation; the generic high/max fixture cannot substitute for its explicit Option Spec.
            models: [
              {
                ...model(SUBAGENT_RUNTIME_CATALOG_MODEL),
                maxOutputTokens: 32_000,
                reasoningLevel: {
                  values: ["low", "medium", "high", "xhigh"],
                  map: '{"thinking":{"type":"enabled","budget_tokens":reasoningLevel == "low" ? 4000 : reasoningLevel == "medium" ? 8000 : reasoningLevel == "high" ? 16000 : 31999},"output_config":{"effort":reasoningLevel}}',
                },
              },
            ],
          }),
        ]
      : []),
    ...(modelProviderListFilteringSpec
      ? [
          provider({
            id: "e2e-hidden-provider",
            label: "Hidden Provider",
            models: [model("hidden-provider-model")],
            visibility: "hidden",
          }),
          provider({
            id: "e2e-visible-provider-hidden-model",
            label: "Visible Provider With Hidden Model",
            models: [model("visible-companion-model"), model("hidden-model", "hidden")],
          }),
          provider({
            enabled: false,
            id: "e2e-hidden-disabled",
            label: "Hidden Disabled Provider",
            models: [model("hidden-disabled-model")],
          }),
          provider({
            apiKey: "",
            id: "e2e-hidden-no-key",
            label: "Hidden No Key Provider",
            models: [model("hidden-no-key-model")],
          }),
          provider({
            baseURL: "",
            id: "e2e-hidden-no-endpoint",
            label: "Hidden No Endpoint Provider",
            models: [model("hidden-no-endpoint-model")],
          }),
          provider({
            baseURL: `${anthropicBaseURL}/builtin-personal-conflict`,
            id: "e2e-zai-template-provider",
            label: "Z.ai Template Provider E2E",
            models: [model("glm-5.3")],
          }),
        ]
      : []),
  ];
  for (const provider of appProviders) {
    await seedPersonalProviderConfig(E2E_APP_PROVIDER_CONFIG_FILE, provider);
  }
  await seedPersonalDefaultModelSelection(E2E_APP_PROVIDER_CONFIG_FILE, {
    providerId: e2eProviderPreset.providerId,
    modelId: e2eProviderPreset.model,
    // Remote Provisioning accepts only a complete model selection; a default model missing its thinking tier makes the SSH first connection and
    // OP10 new sessions fall back to the Registry recommendation. Models without thinking capability also explicitly choose disabled.
    options: { reasoningLevel: readE2EThoughtLevel() || "disabled" },
  });
}

function buildUpstreamE2EAnthropicBaseUrl() {
  const baseURL = upstreamE2EBaseUrl.replace(/\/+$/u, "");
  return baseURL.endsWith("/anthropic") ? baseURL : `${baseURL}/anthropic`;
}

export const config: WebdriverIO.Config = {
  runner: "local",
  // Fix reason: waitUntil's timeout cannot interrupt a WebDriver HTTP request already sent internally;
  // a bad ContextId inside a hook would hang for minutes with the default 120s and 3 retries, so a hard boundary must be set at the protocol layer.
  connectionRetryCount: E2E_WEBDRIVER_REQUEST_LIMITS.retryCount,
  // The in-browser script timeout of executeAsyncScript and the HTTP timeout from WDIO to Chromedriver
  // are two independent gates; the public-network Archive case must cover the Agent's 180-second download limit at both layers.
  connectionRetryTimeout: pluginNoGitGitHubArchiveE2E
    ? 300_000
    : E2E_WEBDRIVER_REQUEST_LIMITS.timeoutMs,
  runnerEnv: {
    E2E_PROVIDER_ALTERNATE_MODEL: E2E_PROVIDER_SECONDARY_MODEL,
    E2E_PROVIDER_ALTERNATE_PROVIDER_ID,
    E2E_PROVIDER_ALTERNATE_PROVIDER_NAME,
    E2E_PROVIDER_HTTP_MODE: upstreamE2EHttpMode,
    [REQUESTED_UPSTREAM_HTTP_MODE_ENV]: requestedUpstreamE2EHttpMode ?? "",
    E2E_PROVIDER_MODEL: resolveActiveE2EProviderEnv().model,
    E2E_PROVIDER_ID: resolveActiveE2EProviderEnv().providerId,
    E2E_PROVIDER_NAME: resolveActiveE2EProviderEnv().providerName,
    E2E_PROVIDER_PRESET: e2eProviderPresetName,
    ...requestSecurityWorkerEnv(process.env),
    E2E_PROVIDER_THOUGHT_LEVEL: resolveActiveE2EProviderEnv().thoughtLevel,
    ...(upstreamE2EHttpMode === "replay"
      ? { E2E_PROVIDER_API_KEY: E2E_PROVIDER_REPLAY_API_KEY }
      : {}),
    HOME: E2E_HOME_DIR,
    USERPROFILE: E2E_HOME_DIR,
    // PLM-LC-010 uses a non-ZCODE_ prefix to verify Claude-compatible env expansion for plugin MCP.
    // The value is used only for hash comparison by the fixture; neither tool results nor screenshots may echo the original value.
    E2E_PLUGIN_RUNTIME_SECRET: "e2e-plugin-runtime-secret-fixture-20260718",
    ...(pluginNoGitGitHubArchiveE2E
      ? {
          // The real public-network smoke must prove the Agent did not silently fall back to the developer machine's Git; a non-existent absolute path makes
          // any Git call reliably get ENOENT, without affecting the WDIO runner's own process-cleanup commands.
          ZCODE_GIT_BINARY: resolve(E2E_HOME_DIR, "missing-bin", "git"),
        }
      : {}),
    // session-pr-status spec seam: POSIX-only fake gh at a fixed path. The spec writes the script
    // itself before the first worktree task triggers gh resolution; other specs only see a candidate
    // that fails the --version probe and fall through to a real gh lookup. Windows keeps the seam
    // unset because spawning a shell script is not supported there.
    ...(process.platform !== "win32"
      ? { ZCODE_GH_BINARY: resolve(E2E_HOME_DIR, "fake-bin", "gh") }
      : {}),
    // ACP detection seam (specs/acp-agent-runtime.md): every spec probes only this run-scoped
    // directory, so a real opencode/cursor-agent on the machine is never detected or spawned. The
    // ACP settings spec writes its mock agent here; for other specs the directory stays absent.
    ZCODE_E2E_ACP_AGENT_PATH: resolve(E2E_HOME_DIR, "acp-agent-bin"),
    VITE_ZCODE_E2E_STORE_BRIDGE: "1",
    ZCODE_AGENT_SERVER_ARGS_JSON: "",
    ZCODE_AGENT_SERVER_COMMAND: "",
    ZCODE_DATA_BASE_DIR: E2E_HOME_DIR,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:
      INITIAL_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ?? E2E_DEFAULT_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
    ZCODE_DESKTOP_APPLICATION_NAME: "ZCode E2E",
    ZCODE_DESKTOP_HOME_DIR: E2E_HOME_DIR,
    ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA: "1",
    ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
    ZCODE_E2E_HOME_DIR: E2E_HOME_DIR,
    ZCODE_E2E_ARTIFACT_DIR: e2eReporter.artifactDir,
    ZCODE_E2E_DEFER_APP_DATA_CLEANUP: "1",
    ZCODE_E2E_RUN_ID: E2E_RUN_ID,
    ZCODE_ENV: "test",
    // Fix reason: ordinary E2E's ZCODE_ENV=test routes the config interface to the test domain;
    // request-security capture and the independent live-team explicitly override the production control plane; other cases keep their original behavior.
    ...getE2EProviderEndpointEnv(configuredE2ESpecs, e2eProviderPresetName, upstreamE2EHttpMode),
    ...(process.env.ZCODE_TELEMETRY_PARITY_CAPTURE_PATH?.trim()
      ? {
          ZCODE_TELEMETRY_PARITY_CAPTURE_PATH: process.env.ZCODE_TELEMETRY_PARITY_CAPTURE_PATH,
        }
      : {}),
    ...(process.env.ZCODE_TELEMETRY_PARITY_VARIANT?.trim()
      ? {
          ZCODE_TELEMETRY_PARITY_VARIANT: process.env.ZCODE_TELEMETRY_PARITY_VARIANT,
        }
      : {}),
  },
  framework: "mocha",
  reporters: ["spec"],
  maxInstances: Number(process.env.ZCODE_E2E_MAX_INSTANCES ?? "1"),
  maxInstancesPerCapability: Number(process.env.ZCODE_E2E_MAX_INSTANCES ?? "1"),
  ...(containerE2E
    ? {
        autoXvfb: true,
        xvfbAutoInstall: false,
        xvfbMaxRetries: 5,
        xvfbRetryDelay: 1500,
      }
    : {}),
  services: [
    [
      // Bug cause: the old Electron service swallowed ContextId failures, and reloadSession does not rerun
      // service.before; the local module keeps the official launcher while adding strict readiness and onReload.
      E2E_ELECTRON_SERVICE_MODULE_PATH,
      {
        // Bugfix: rootDir is used only to let wdio-electron-service read the desktop package.json;
        // the Electron executable lives in different places under pnpm hoisted/isolated layouts, so appEntryPoint mode must not
        // hard-join node_modules/.bin/electron from rootDir.
        rootDir: DESKTOP_DIR,
      },
    ],
  ],
  capabilities: [
    {
      browserName: "electron",
      browserVersion: ELECTRON_VERSION,
      "wdio:electronServiceOptions": {
        appArgs: [
          ...(E2E_PACKAGED_APP_BINARY_PATH ? [] : [`--app=${E2E_APP_ENTRY_POINT}`]),
          "--no-sandbox",
          // Fix reason: environment variables do not appear in the process command line; so pass both runId and HOME identity,
          // letting cross-platform cleanup prefer hits for the current run and keep a path-level fallback for Windows shards.
          buildE2ERunIdArg(E2E_RUN_ID),
          createWindowsE2EHomeMarkerArg(E2E_HOME_DIR),
        ],
        appBinaryPath: ELECTRON_APP_BINARY_PATH,
      },
      "goog:chromeOptions": {
        // Fix reason: Electron's `--app=<main>` permanently keeps one
        // chrome-error://chromewebdata/ app target. Once the app is exposed to ChromeDriver, the current handle can drift back to the wrong shell during
        // session start/stop in long batches; here only
        // the BrowserWindow's page target is allowed, so an unready session fails instead of binding the wrong window.
        windowTypes: ["page"],
        args: [...(containerE2E ? containerChromeArgs : [])],
      },
      ...(containerE2E
        ? {
            "wdio:chromedriverOptions": {
              // Fix reason: pin the container cache so each round does not re-download Chromedriver from /tmp.
              cacheDir: E2E_BROWSER_DRIVER_CACHE_DIR,
            },
          }
        : {}),
    },
  ],
  specs: configuredE2ESpecs,
  // Fix reason: the upstream provider e2e needs a real upstream key; the default full e2e should not start a worker that is "skipped but still occupies the browser".
  // Otherwise it would share and reset .e2e-home with smoke, showing up as a blank temporary test window or waiting forever for the default workspace.
  exclude: [
    ...(upstreamProviderSpecRequested ? [] : [UPSTREAM_PROVIDER_SPEC]),
    ...(manualReviewE2E ? [] : [MANUAL_REVIEW_SPEC_GLOB]),
    ...resolveEnvironmentGatedFormalSpecExcludes({
      env: process.env,
      targeted: isExplicitE2ESpecSelection(requestedE2ESpecs),
    }),
    // Bugfix: the MR auto gate may temporarily quarantine known-flaky formal specs, but the local default
    // `test:e2e` is unaffected, to avoid permanently hiding flaky cases from the developer regression entry.
    ...requestedE2EExcludeSpecs,
  ],
  mochaOpts: {
    // Bug cause: WDIO config beforeSuite runs through executeHooksWithArgs, so ordinary exceptions are
    // logged and then resolved, and a bad session would still enter product cases. Only a native Mocha root hook counts a
    // preflight rejection as a hook failure and stops before the test body.
    rootHooks: createE2ERendererBridgeRootHooks(
      async () => {
        await measureE2ELifecyclePhase(
          "before-suite",
          { specs: currentE2EWorkerSpecs },
          async () => {
            await runE2ERendererBridgePreflight(currentE2EWorkerSpecs);
          },
        );
      },
      () => currentE2EBeforeSessionError,
    ),
    ui: "bdd",
    // The remote e2e queue has a formal spec containing only one remote case (settings-ui-polish's
    // MP-UI-05-remote): running the whole spec would pull the same spec's local cases into the remote results, and failures
    // unrelated to remote would be counted against the remote account (measured: MP-UI-06 dragged MP-UI-05-remote's pass conclusion down).
    // When unset, keep the full run, which does not affect local regression.
    ...(process.env.ZCODE_E2E_MOCHA_GREP?.trim()
      ? { grep: process.env.ZCODE_E2E_MOCHA_GREP.trim() }
      : {}),
    // Fix reason: real model config plus first-session warmup can exceed 30s, so keep a wider per-case cap to avoid Mocha truncating before the upstream response arrives.
    // The real GitHub Archive smoke downloads the Claude official marketplace and the target plugin; the E2E capture proxy also
    // records full binary responses, so it cannot reuse the 120-second cap that only covers local fixtures.
    // WPL-011 goes through SSH assets, marketplace mirror, remote install and runtime refresh;
    // a fixed 120 seconds would truncate the case before the UI has a chance to report the specific sync result.
    // Bug cause: the Mocha adapter wraps the case with the config timeout before entering the test body,
    // so this.timeout inside the case cannot add budget for manual phases. The explicit hold only extends
    // manual-review runs and does not change the ordinary E2E 120-second cap.
    timeout:
      (configuredE2ESpecs.some(
        (spec) =>
          spec.endsWith("conversation-session-remote-sidebar-menus.test.ts") ||
          spec.endsWith("conversation-session-ssh-probe-validation.test.ts"),
      )
        ? // This case includes a real SSH first install, directory reuse, settings location, 16 screenshots and reconnection to the original directory;
          // The probe-validation case likewise goes through a real first install and recovery from existing device faults, so it cannot be truncated before the state assertions.
          // The Mocha outer timeout must match the case's 15-minute budget, so it is not truncated at the default 120 seconds during first-install extraction.
          15 * 60_000
        : configuredE2ESpecs.some((spec) =>
              spec.endsWith("conversation-session-remote-ui-walkthrough.test.ts"),
            )
          ? // The walkthrough case serially completes a real first install, failure/cancel/background, settings page and container-stop disconnection recovery, recording the whole run;
            // Matches the 30-minute budget inside the case.
            30 * 60_000
          : configuredE2ESpecs.some((spec) =>
                spec.endsWith("conversation-session-r3-mobile.test.ts"),
              )
            ? // This case serially completes a real SSH install, two relay pairings and network-disconnect recovery; its original budget is kept in sync,
              // avoid WDIO truncating at the default 120 seconds while the phone is offline; this.timeout cannot cover the outer layer.
              40 * 60_000
            : pluginNoGitGitHubArchiveE2E ||
                workspacePluginRemoteExplicitSyncE2E ||
                configuredE2ESpecs.some((spec) =>
                  spec.endsWith("conversation-session-subagent-cross-host.test.ts"),
                )
              ? 600000
              : // Background Bash cold-recovery regression waits for the real child to finish, the 120s publisher grace and the 60s cleanup cadence.
                configuredE2ESpecs.some((spec) =>
                    spec.endsWith("conversation-session-background-bash-output.test.ts"),
                  )
                ? 360000
                : requestSecuritySpecTimeout(configuredE2ESpecs, 120000)) + manualReviewHoldMs,
  },
  async onPrepare() {
    try {
      e2eReporter.prepare(configuredE2ESpecs);
      await measureE2ELifecyclePhase("prepare", { specs: configuredE2ESpecs }, async () => {
        await cleanupE2EElectronProcesses("onPrepare");
        await cleanupE2EDirectory("onPrepare", E2E_CHROMIUM_USER_DATA_ROOT_DIR, true);
        // Bug cause: beforeSession runs inside the WDIO worker, while the Electron/ChromeDriver startup chain inherits
        // the environment from the launcher that spawned the worker. If the reset mock only starts inside the worker,
        // Main -> Host would keep requesting the real ZCode domain; so, like the upgrade mock, start it before dispatching the worker,
        // and pass the same dynamic port to Electron and the test control side via the environment.
        await startCodingPlanTeamMockIfNeeded(configuredE2ESpecs);
        if (codingPlanTeamMockBaseUrl) {
          // WDIO config that explicitly provides runnerEnv no longer passes through the launcher's process.env; the
          // dynamic port allocated in onPrepare must be written back into runnerEnv so the worker, ChromeDriver and Electron
          // inherit the same mock, rather than starting a separate service in beforeSession that only test code can reach.
          if (!config.runnerEnv) {
            // Fail fast: if runnerEnv is removed, Object.assign into a temporary object silently drops the port,
            // which shows up as the worker's mock going missing, much harder to debug than failing here directly.
            throw new Error(
              "wdio config 缺少 runnerEnv，coding plan reset mock 端口无法透传给 worker",
            );
          }
          Object.assign(config.runnerEnv, {
            [CODING_PLAN_TEAM_MOCK_BASE_URL_ENV]: codingPlanTeamMockBaseUrl,
            ...(offPeakTeamGateway
              ? { ZCODE_OFFPEAK_MOCK_PORT: String(offPeakTeamGateway.port) }
              : {}),
          });
        }
        // Bugfix: the Coding Plan webview origin is a Vite compile-time constant; the mock must start before
        // build and inject env, otherwise the renderer would bake in the online official-site origin.
        await startCodingPlanUpgradeE2EMock(configuredE2ESpecs, {
          prepareForBuild: true,
        });
        const codingPlanUpgradeMockBaseUrl =
          process.env[CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV]?.trim();
        if (codingPlanUpgradeMockBaseUrl) {
          // The formal Rewards cases use a self-hosted web page and do not depend on a developer's localhost:3000 service.
          if (configuredE2ESpecs.some((spec) => spec.includes("marketing-touch-rewards"))) {
            process.env.VITE_REWARDS_WEBVIEW_ORIGIN = codingPlanUpgradeMockBaseUrl;
          }
          if (!config.runnerEnv) {
            throw new Error(
              "wdio config 缺少 runnerEnv，coding plan upgrade mock 端口无法透传给 worker",
            );
          }
          Object.assign(config.runnerEnv, {
            [CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV]: codingPlanUpgradeMockBaseUrl,
          });
        }
        const buildAndStage = async () =>
          withE2EDesktopBuildLock({}, async () => {
            prepareDesktopAppBuild();
            if (!E2E_PACKAGED_APP_BINARY_PATH) await stageDesktopE2EAppOutput();
          });
        // The old coverage report only has paths and cannot prove the source version; a reused build must not certify the current working tree.
        if (process.env.ZCODE_E2E_SOURCE_EVIDENCE === "1") {
          await withE2ESourceEvidence({
            freshBuild: !E2E_PACKAGED_APP_BINARY_PATH && !shouldReuseDesktopE2EBuild(process.env),
            captureSources: () => captureWorkspaceSources(REPO_ROOT),
            build: buildAndStage,
            appOutputDir: E2E_APP_OUTPUT_DIR,
            artifactDir: e2eReporter.artifactDir,
          });
        } else await buildAndStage();
        prepareZCodeAgentServer();
      });
    } catch (error) {
      // Fix reason: WDIO records onPrepare exceptions as hook errors and keeps dispatching workers;
      // a build failure turns into dozens of DevToolsActivePort/bridge timeout errors that mask the real cause.
      console.error("[e2e] fatal onPrepare failure", error);
      process.exit(1);
    }
  },
  onWorkerStart(cid, _caps, specs) {
    e2eRunnerFinalizationGuard.disarm();
    e2eWorkerLifecycleStarts.set(cid, {
      specs,
      startedAt: new Date(),
    });
  },
  async beforeSession(_config, capabilities, specs, cid) {
    // Bugfix: existing e2e reads and writes ~/.zcode/v2; if multiple specs reuse the real HOME,
    // credentials, recent projects and localStorage from the previous spec leak into the next one,
    // polluting the developer's local data and making "first launch" assertions random.
    // Here an isolated HOME is prepared separately for e2e and reset before each session starts, so every spec starts from a clean environment.
    // process.env set in onPrepare is not reliably passed into WDIO workers; in the worker, before Electron starts,
    // clear the custom Agent override so database preparation still goes through the bundled resolver.
    currentE2EWorkerSessionSpecs = specs;
    applyUpstreamE2EHttpModeForWorker(specs);
    applyAskUserQuestionClockScaleForWorker(specs);
    applyE2EProviderEnv(specs);
    configureHighspeedE2EMock(specs);
    currentE2EBeforeSessionError = null;
    applyE2EWorkerModelRetryEnv(process.env, specs, configuredModelRetryMaxRetries);
    currentE2EChromiumUserDataDir = resolveE2EWorkerChromiumProfileDir(
      E2E_CHROMIUM_USER_DATA_ROOT_DIR,
      cid,
    );
    const chromeCapabilities = capabilities as {
      "goog:chromeOptions"?: { args?: string[] };
    };
    const chromeOptions = chromeCapabilities["goog:chromeOptions"] ?? {};
    // Fix reason: when all workers reuse and repeatedly delete the same profile, Chromium in long batches
    // leaves stale documents, the CDP target still shows file://, but at runtime it drifts to chrome-error://.
    // Inject an independent profile per cid before session creation, so worker lifecycles do not pollute each other.
    chromeOptions.args = replaceChromeUserDataDirArg(
      chromeOptions.args ?? [],
      currentE2EChromiumUserDataDir,
    );
    const storageDiagnostics =
      process.env.ZCODE_E2E_STORAGE_WORKER_DIAGNOSTICS === "1" &&
      specs.some((spec) =>
        spec.endsWith("conversation-session-r3-desktop-settings-authority.test.ts"),
      );
    if (
      !E2E_PACKAGED_APP_BINARY_PATH &&
      (storageDiagnostics ||
        specs.some((spec) =>
          /conversation-session-subagent-(context-boundaries|multi-workspace|cross-host)\.test\.ts/.test(
            spec,
          ),
        ))
    ) {
      // ChromeDriver clears NODE_OPTIONS; the test startup file sets the proxy preload before the formal Main imports.
      // The file sits next to the original Main, preserving the app path; the formal Host/CLI resolver and storage preparation are not replaced.
      const entry = resolve(E2E_APP_OUTPUT_DIR, "main/subagent-e2e.mjs");
      const proxy = resolve(
        REPO_ROOT,
        storageDiagnostics
          ? "packages/desktop/test/e2e/helpers/storage-worker-diagnostics.mjs"
          : "packages/desktop/test/e2e/helpers/subagent-config-proxy.mjs",
      );
      const preload = `--import=${JSON.stringify(proxy)}`;
      const diagnostics = storageDiagnostics
        ? `process.env.ZCODE_E2E_STORAGE_WORKER_DIAGNOSTICS_DIR = ${JSON.stringify(resolve(e2eReporter.artifactDir, "storage-workers"))};\n`
        : "";
      await writeFile(
        entry,
        `${diagnostics}process.env.NODE_OPTIONS = ${JSON.stringify(preload)};\nawait import(${JSON.stringify(pathToFileURL(E2E_APP_ENTRY_POINT).href)});\n`,
      );
      chromeOptions.args = chromeOptions.args.map((arg) =>
        arg.startsWith("--app=") ? `--app=${entry}` : arg,
      );
    }
    chromeCapabilities["goog:chromeOptions"] = chromeOptions;
    try {
      await measureE2ELifecyclePhase("before-session", { cid, specs }, async () => {
        // Fix reason: when a worker fails before the WebDriver session is created, it does not reliably reach afterSession;
        // the next worker must first clean up leftover Electron/host by this run's id, so old targets
        // do not pollute the new launcher session.
        await cleanupE2EElectronProcesses("beforeSession-start", {
          requireExit: true,
        });
        // Reason: onPrepare and the Electron launcher are not in the same process, so the dynamic port can only be injected
        // in the worker's beforeSession to be inherited through the Main -> Host environment chain.
        await startModelContextBudgetConfigE2EMock(specs);
        // Dynamic workflow gray release likewise can only inject the dynamic port in the worker's beforeSession; so the Main -> Host
        // environment chain inherits the case-local /client/configs gateway.
        await startDynamicWorkflowConfigE2EMock(specs);
        // This SSH case verifies session ownership; enable the mode before Electron starts so the local mock loopback is not handed to the remote.
        if (specs.some((spec) => spec.endsWith("conversation-session-r3-subagent.test.ts"))) {
          process.env.ZCODE_DYNAMIC_WORKFLOW_MODE = "alwaysOn";
        }
        await runE2EBeforeSessionSetup({
          cid,
          specs,
          configureAgentServerEnv: configureZCodeAgentServerEnv,
          configureCodingPlanTeamMockForSpecs,
          recordBeforeSession: e2eReporter.beforeSession,
          resetHome: resetE2EHome,
          startCodingPlanTeamMockIfNeeded,
          startCodingPlanUpgradeMockIfNeeded: startCodingPlanUpgradeE2EMock,
          startUpstreamHttpIfNeeded: startUpstreamE2EHttp,
          startCodingPlanDataPlaneProxyIfNeeded: startCodingPlanDataPlaneProxy,
          startPluginCdnZipFixtureIfNeeded,
          startOffPeakMockIfNeeded: startOffPeakE2EMock,
        });
        // Client Scenes is a remote directory dependency of the layout cases; it must override the endpoint after resetHome completes and before Electron
        // starts, so Main → Host gets the case-local fixture on its first import.
        await startClientScenesE2EMockIfNeeded(specs);
        await stopTtftOtlpFixture?.();
        stopTtftOtlpFixture = await prepareTtftOtlpFixture(specs);
        await startRequestSecurityFixture(specs, E2E_HOME_DIR);
        stopOAuthCompletionRaceFixture = await prepareOAuthCompletionRaceFixture(specs);
        stopAccessToken401Fixture = await prepareAccessToken401Fixture({
          specs,
          credentialsFile: E2E_APP_CREDENTIALS_FILE,
          settingsFile: E2E_APP_SETTINGS_FILE,
        });
        // Install after resetHome and before Electron starts, so Main -> Host -> Agent all inherit
        // the case-owned PATH; other specs are kept as a no-op by the helper.
        await installBashPrefixPermissionPnpmShim({
          environment: process.env,
          homeDir: E2E_HOME_DIR,
          specs,
        });
        // Root cause: WDIO probes and then releases the port, and ChromeDriver binding later hit it while occupied; the driver allocates and holds the port itself.
        // Each worker owns one; a cold restart of Electron keeps connecting to this driver without adding startup retries.
        try {
          e2eChromedriverServer ??= await startE2EChromedriverServer({
            executablePath: resolveE2EChromedriverExecutable({
              explicitPath: process.env.CHROMEDRIVER_PATH,
              electronVersion: ELECTRON_VERSION,
              cacheDir: containerE2E ? E2E_BROWSER_DRIVER_CACHE_DIR : tmpdir(),
            }),
            logPath: resolve(e2eReporter.artifactDir, `chromedriver-${cid}.log`),
          });
          Object.assign(_config, {
            hostname: e2eChromedriverServer.hostname,
            port: e2eChromedriverServer.port,
          });
        } catch (error) {
          // WDIO swallows beforeSession exceptions and continues starting; here the worker is ended directly, forbidding fallback to a second driver.
          console.error("[e2e] ChromeDriver startup failed", error);
          process.exit(1);
        }
      });
    } catch (error) {
      // Bug cause: WDIO executeHooksWithArgs swallows the beforeSession rejection; the original
      // failure is saved and handed to the Mocha root hook to throw, ensuring the product test body does not run in a broken environment.
      currentE2EBeforeSessionError =
        error ?? new Error("beforeSession setup rejected without an error value");
    }
  },
  async before(_capabilities, specs) {
    // Bug cause: WDIO puts the project's and wdio-electron-service's before hooks in Promise.all;
    // sending renderer/CDP commands here would race with the service's ContextId, Puppeteer and window initialization.
    // before only records worker ownership; browser commands are deferred to the Mocha root hook timing barrier.
    currentE2EWorkerSpecs = specs;
  },
  async beforeTest(test) {
    resetDraftRegenerationResend();
    // Fix reason: in the current Electron runner's before hook phase, `browser.electron` is not yet injected;
    // only when sampling starts at beforeTest can electron.execute be called continuously.
    await e2eReporter.startUICoverage(browser);
    await e2eReporter.startProcessSampling(browser, currentE2EWorkerSpecs);
    e2eFailureArtifacts ??= new E2EFailureArtifactCollector({
      artifactDir: e2eReporter.artifactDir,
      browser,
    });
    try {
      await e2eFailureArtifacts.start(test);
    } catch (error) {
      // Fix reason: failures initializing diagnostic artifacts must not make beforeTest become a new E2E failure root cause.
      console.warn("[e2e] failure artifact collection could not start", error);
    }
  },
  async beforeCommand(commandName) {
    if (commandName !== "refresh") {
      return;
    }
    try {
      // Fix reason: a renderer refresh rebuilds globalThis.__coverage__; the counters must be merged before the page is destroyed,
      // otherwise interactions already walked before the refresh vanish from the suite coverage.
      await e2eReporter.snapshotUICoverage();
    } catch (error) {
      console.warn("[e2e-coverage] renderer pre-refresh snapshot failed", error);
    }
  },
  async after(_result, _capabilities, specs) {
    await measureE2ELifecyclePhase("after", { specs }, async () => {
      try {
        await e2eReporter.stopProcessSampling(browser, specs);
        await e2eReporter.stopUICoverage();
      } finally {
        // First let ChromeDriver close the renderer normally; the closed listener in the same process then triggers
        // app.quit, and afterSession finally verifies the whole process tree has exited.
        await armCurrentElectronAppQuit("after");
        currentE2EWorkerSpecs = [];
      }
    });
  },
  async afterSession() {
    await measureE2ELifecyclePhase(
      "after-session",
      { specs: currentE2EWorkerSessionSpecs },
      async () => {
        try {
          await cleanupE2EElectronProcesses("afterSession", {
            requireExit: true,
            waitForGracefulExit: true,
          });
          if (currentE2EChromiumUserDataDir) {
            await cleanupE2EDirectory("afterSession", currentE2EChromiumUserDataDir, true);
          }
          // Electron/Host/CLI have all exited, so the V8 JSON is now fully sealed; normalize it in place before the next worker starts
          // to avoid full manual-review accumulating duplicate source maps until the disk limit.
          e2eReporter.compactNodeCoverage();
        } finally {
          await e2eChromedriverServer?.stop();
          e2eChromedriverServer = undefined;
          await stopRequestSecurityFixture();
          await stopModelContextBudgetConfigE2EMock();
          await stopDynamicWorkflowConfigE2EMock();
          currentE2EElectronAppPid = null;
          await stopOAuthCompletionRaceFixture?.();
          stopOAuthCompletionRaceFixture = null;
          await stopTtftOtlpFixture?.();
          stopTtftOtlpFixture = null;
          await stopAccessToken401Fixture?.();
          stopAccessToken401Fixture = null;
          currentE2EBeforeSessionError = null;
          e2eFailureArtifacts = null;
          currentE2EWorkerSessionSpecs = [];
          currentE2EChromiumUserDataDir = null;
        }
      },
    );
  },
  onWorkerEnd(cid, exitCode, specs) {
    e2eRunnerFinalizationGuard.arm();
    const workerLifecycle = e2eWorkerLifecycleStarts.get(cid);
    if (!workerLifecycle) {
      return;
    }
    e2eWorkerLifecycleStarts.delete(cid);
    const completedAt = new Date();
    e2eReporter.recordLifecycleEvent({
      cid,
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - workerLifecycle.startedAt.getTime(),
      error: exitCode === 0 ? undefined : `worker exited with code ${exitCode}`,
      phase: "worker",
      specs: specs.length > 0 ? specs : workerLifecycle.specs,
      startedAt: workerLifecycle.startedAt.toISOString(),
      status: exitCode === 0 ? "passed" : "failed",
    });
  },
  async afterTest(test, _context, result) {
    let failureArtifacts;
    const collectionErrors: string[] = [];
    try {
      // The clearAppData in the Mocha suite's after exits Electron first; afterTest is the last stable moment to read renderer coverage;
      // WDIO after keeps only the failure fallback.
      await e2eReporter.stopUICoverage();
    } catch (error) {
      console.warn("[e2e-coverage] renderer snapshot failed", error);
      collectionErrors.push(
        `renderer coverage: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      failureArtifacts = await runE2EDiagnosticWithTimeout(
        async () =>
          e2eFailureArtifacts?.complete(test, {
            ...result,
            errorCategory: result.passed
              ? undefined
              : classifyError(
                  result.error instanceof Error ? result.error.message : String(result.error ?? ""),
                ),
          }),
        E2E_FAILURE_ARTIFACT_COLLECTION_TIMEOUT_MS,
        "E2E failure artifact collection",
      );
    } catch (error) {
      // Fix reason: failure evidence collection is supplementary diagnostics; a collector's own exception must not mask the original E2E failure.
      console.warn("[e2e] failure artifact collection failed", error);
      collectionErrors.push(
        `failure artifacts: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    e2eReporter.recordTestResult(test, result, failureArtifacts, collectionErrors);
  },
  async onComplete(exitCode) {
    e2eRunnerFinalizationGuard.disarm();
    let onCompleteError: unknown;
    try {
      await measureE2ELifecyclePhase("complete", { specs: configuredE2ESpecs }, async () => {
        try {
          await stopUpstreamE2EHttp();
          await stopCodingPlanTeamMock();
          await stopCodingPlanUpgradeE2EMock();
          await stopRequestSecurityFixture();
          await stopModelContextBudgetConfigE2EMock();
          await stopDynamicWorkflowConfigE2EMock();
          await stopClientScenesE2EMock();
          await stopOAuthCompletionRaceFixture?.();
          stopOAuthCompletionRaceFixture = null;
          await stopAccessToken401Fixture?.();
          stopAccessToken401Fixture = null;
          await stopPluginCdnZipFixture();
        } finally {
          await cleanupE2EElectronProcesses("onComplete");
          // Fix reason: deleting the same app data worker by worker repeatedly pays SQLite lock retries; the next
          // beforeSession already handles the reset, and the last worker's HOME is deleted uniformly after all processes exit.
          // Failure keeps the diagnostic scene: when the batch runner (run.mjs) injects ZCODE_E2E_KEEP_HOME_ON_FAIL=1,
          // a failed run keeps HOME (setting.json/credentials/db are key evidence for failure diagnosis;
          // r3-rerun §49 once had to infer settings from run.log because the home was deleted). PASS behavior is unchanged.
          if (exitCode !== 0 && process.env.ZCODE_E2E_KEEP_HOME_ON_FAIL === "1") {
            console.warn(`[e2e] keeping failure home for diagnosis: ${E2E_HOME_DIR}`);
          } else {
            await cleanupE2EDirectory("onComplete-home", E2E_HOME_DIR, true);
          }
          await cleanupE2EDirectory("onComplete", E2E_RUN_CACHE_DIR);
        }
      });
    } catch (error) {
      onCompleteError = error;
    } finally {
      e2eReporter.writeSummary(exitCode);
      armE2ERunnerExitWatchdog(exitCode);
    }
    if (onCompleteError) {
      throw onCompleteError;
    }
  },
};
