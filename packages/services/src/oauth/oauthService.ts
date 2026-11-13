/* eslint-disable max-lines -- OAuthService coordinates OAuth session lifecycle and provider-switch boundaries; the current review fix only narrows background migration write conditions. */
import { randomBytes } from "node:crypto";
import { Emitter } from "@zcode/rpc";
import {
  ApiError,
  formatLogPrefix,
  type ApiClient,
  BIGMODEL_PROVIDER_ID,
  CHATGPT_OAUTH_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  ZAI_CN_PROVIDER_ID,
  isBuiltinOAuthProvider,
  isZaiOAuthProvider,
  type OAuthCallbackResult,
  type OAuthAccountAvailability,
  type OAuthCachedSessionRestoreResult,
  type OAuthProviderId,
  type OAuthProviderMeta,
  type OAuthSessionState,
  type OAuthStartResponse,
  type OAuthTokenSet,
  type OAuthUserProfile,
  type SiwcLoginCompletionResult,
  type SiwcLoginStart,
  type SiwcPlanAccountsStatus,
  type UserInfo,
  resolveJwtExpiration,
} from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import type { CredentialFileGuard } from "@zcode/shared/node";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { readApiJson } from "../providers/api/apiJson.js";
import type { IOAuthService } from "./oauth.js";
import { isCurrentOAuthCredentialRequest } from "#src/oauth/oauthUnauthorizedRequest.js";
import { hasOAuthAuthorizationCode, parseOAuthLoginAttribution } from "./callbackAttribution.js";
import {
  mergeOAuthDisplayProfile,
  refreshLegacyBigModelCachedProfile,
  withProviderProfileSchema,
} from "./oauthProfileSchema.js";
import {
  createOAuthProviderAdapters,
  readLinkedBigModel,
  type OAuthProviderAdapter,
} from "./providers/index.js";
import { OAuthCredentialRepo } from "./repo/oauthCredentialRepo.js";
import { createOAuthRuntimeConfig } from "./runtimeConfig.js";
import { SiwcAuthService } from "./siwc/siwcAuthService.js";
import {
  buildDesktopOAuthRedirectUriFromEnv,
  buildZCodeApiUrlFromEnv,
} from "./providers/configUtils.js";

/** OAuth timeout (5 minutes). */
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const OAUTH_PROFILE_TIMEOUT_MS = 10_000;
const COMPLETED_POLLING_STATE_GRACE_MS = 30 * 1000;
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("oauthService", process.pid), ...args);
const serviceLog = createServiceLogger("oauthService");

interface PendingState {
  credentialGuard?: CredentialFileGuard;
  state: string;
  provider: OAuthProviderId;
  timeout: NodeJS.Timeout;
  phase: "awaiting-attribution-or-code" | "awaiting-code-after-attribution";
  completions?: Set<Promise<OAuthCallbackResult | null>>;
  expectedSession: Readonly<Record<string, string | null>>;
  redirectUri?: string;
  polling?: {
    expiresAt: number;
    flowId: string;
    nextPollAt: number;
    pollIntervalMs: number;
    pollToken: string;
    pollUrl: string;
  };
}

interface OAuthFlowEnvelope {
  code?: unknown;
  msg?: unknown;
  data?: unknown;
}

interface OAuthServiceDependencies {
  captureCredentialGuard?: () => Promise<CredentialFileGuard>;
  adapters?: OAuthProviderAdapter[];
  apiClient?: ApiClient;
  /** Shared with the Host's request-auth path when composed by createLocalServices. */
  siwcAuthService?: SiwcAuthService;
  now?: () => number;
  monotonicNow?: () => number;
  env?: NodeJS.ProcessEnv;
  onProviderLogout?: (provider: OAuthProviderId, accountIdentity?: string | null) => Promise<void>;
  /** Fired after a ChatGPT plan (SIWC) login completion or logout so account overlays refresh. */
  onChatGptPlanSessionChange?: () => Promise<void>;
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toUserInfo(profile: OAuthUserProfile): UserInfo {
  return {
    id: profile.id,
    username: profile.username,
    displayName: profile.displayName,
    ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
  };
}

function isSameOAuthProfile(left: OAuthUserProfile, right: OAuthUserProfile): boolean {
  return (
    left.id === right.id &&
    left.username === right.username &&
    left.displayName === right.displayName &&
    left.avatarUrl === right.avatarUrl &&
    JSON.stringify(left.rawProfile ?? null) === JSON.stringify(right.rawProfile ?? null)
  );
}

/**
 * OAuth authentication service implementation.
 *
 * Runs in the host process and manages the full lifecycle of OAuth flows.
 */
export class OAuthService implements IOAuthService {
  private readonly sessionChanges = new Emitter<OAuthSessionState>();
  readonly onDidChangeSession = this.sessionChanges.event;
  private readonly credentialService: ICredentialService;
  private readonly captureCredentialGuard?: () => Promise<CredentialFileGuard>;
  private readonly repo: OAuthCredentialRepo;
  private readonly adapters = new Map<OAuthProviderId, OAuthProviderAdapter>();
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly onProviderLogout?: (
    provider: OAuthProviderId,
    accountIdentity?: string | null,
  ) => Promise<void>;
  private readonly onChatGptPlanSessionChange?: () => Promise<void>;
  private readonly apiClient?: ApiClient;
  private readonly env: NodeJS.ProcessEnv;
  private readonly siwcAuth: SiwcAuthService;
  private readonly profileRefreshes = new Map<string, Promise<OAuthAccountAvailability>>();
  private pendingState: PendingState | null = null;
  private oauthFlowStartGeneration = 0;
  private oauthFlowStartProvider: OAuthProviderId | null = null;
  private oauthSessionGeneration = 0;
  private sessionMutationQueue: Promise<unknown> = Promise.resolve();
  private recentlyCompletedPollingState: {
    credentialGuard?: CredentialFileGuard;
    generation: number;
    expiresAt: number;
    provider: OAuthProviderId;
    state: string;
  } | null = null;
  /** Host 定时器清除的 polling flow 的发起代次；新登录或取消推进代次后自然失效。 */
  private expiredPollingGeneration: number | null = null;

  constructor(credentialService: ICredentialService, dependencies: OAuthServiceDependencies = {}) {
    this.credentialService = credentialService;
    this.captureCredentialGuard = dependencies.captureCredentialGuard;
    this.now = dependencies.now ?? Date.now;
    this.monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
    this.onProviderLogout = dependencies.onProviderLogout;
    this.onChatGptPlanSessionChange = dependencies.onChatGptPlanSessionChange;
    this.apiClient = dependencies.apiClient;
    this.env = dependencies.env ?? process.env;

    const adapters =
      dependencies.adapters ??
      createOAuthProviderAdapters(createOAuthRuntimeConfig(dependencies.env), {
        apiClient: dependencies.apiClient,
      });

    for (const adapter of adapters) {
      this.adapters.set(adapter.providerId, adapter);
    }
    this.repo = new OAuthCredentialRepo(credentialService, {
      providerIds: adapters.map((adapter) => adapter.providerId),
      onCorruptOAuthSessionCleared: async () => {
        // Corrupt recovery has no account identity, so the provider logout handler would only enqueue an
        // account refresh. That refresh shares the single-flight queue with login refreshes and runs the
        // SIWC status probe, so it would delay a login that follows the corrupt boot. Signal sign-out only;
        // the account snapshot reconciles on the next login, logout, or settings refresh.
        this.sessionChanges.fire("signed-out");
      },
    });
    // ChatGPT plan (SIWC) is an independent identity domain: it never touches the zai/bigmodel
    // pending-state machine, `oauth:active_provider`, or `zcodejwttoken`.
    this.siwcAuth =
      dependencies.siwcAuthService ??
      new SiwcAuthService(credentialService, {
        env: this.env,
        ...(dependencies.now ? { now: dependencies.now } : {}),
      });
  }

  async getProviders(): Promise<OAuthProviderMeta[]> {
    return [...this.adapters.values()]
      .map((adapter) => adapter.meta)
      .filter((meta) => meta.enabled)
      .sort((a, b) => a.order - b.order);
  }

  async getActiveProvider(): Promise<OAuthProviderId | null> {
    return this.repo.getActiveProvider();
  }

  async getAccountAvailability(): Promise<OAuthAccountAvailability> {
    return this.repo.loadAccountAvailability();
  }

  getWebsiteSession() {
    return this.repo.loadWebsiteSession();
  }

  async refreshAccountProfile(
    expected?: Pick<OAuthAccountAvailability, "loginProvider" | "userId" | "sessionRevision">,
  ): Promise<OAuthAccountAvailability> {
    const snapshot = await this.repo.loadSessionSnapshot();
    const provider = snapshot["oauth:active_provider"];
    const profile = provider ? this.repo.profileFromSnapshot(snapshot, provider) : null;
    const tokens = provider ? this.repo.tokenSetFromSnapshot(snapshot, provider) : null;
    const jwt = tokens?.zcodeJwtToken;
    // 拒绝来自旧业务请求的刷新：分类后可能已在另一进程完成重登或退出。
    if (
      expected &&
      (expected.loginProvider !== provider ||
        expected.userId !== profile?.id ||
        expected.sessionRevision !== (snapshot["oauth:session_revision"] ?? null))
    ) {
      return this.getAccountAvailability();
    }
    if (!provider || !profile || !tokens || !jwt || !this.apiClient)
      return this.getAccountAvailability();
    const key = JSON.stringify([provider, profile.id, snapshot["oauth:session_revision"], jwt]);
    const existing = this.profileRefreshes.get(key);
    if (existing) return existing;
    const refresh = (async () => {
      const response = await readApiJson<OAuthFlowEnvelope>(
        this.apiClient!,
        buildZCodeApiUrlFromEnv(this.env, "/api/v1/oauth/profile"),
        {
          headers: { Authorization: `Bearer ${jwt}` },
          authFailurePolicy: "caller-handled",
          timeoutMs: OAUTH_PROFILE_TIMEOUT_MS,
        },
      );
      const data = response.data;
      if (
        response.code !== 0 ||
        !isUnknownRecord(data) ||
        !isUnknownRecord(data.user) ||
        readTrimmedString(data.user.user_id) !== profile.id
      ) {
        throw new Error("账号关联响应无效或主体不一致");
      }
      const linkedBigModel = readLinkedBigModel(data.bigmodel);
      // 缺失关联块尚不能证明解除关联；只接受明确合法的正向结果，不清除原有材料。
      if (
        linkedBigModel &&
        JSON.stringify(linkedBigModel) !== JSON.stringify(tokens.linkedBigModel)
      ) {
        await this.runSessionMutation(async () => {
          // 补关联不能抢占用户正在进行的新登录；整组 CAS 再防御另一进程的退出或换人。
          if (this.pendingState || this.oauthFlowStartProvider) return;
          if (
            await this.repo.commitSession(
              snapshot,
              provider,
              { ...tokens, linkedBigModel },
              profile,
            )
          )
            this.oauthSessionGeneration += 1;
        });
      }
      return this.getAccountAvailability();
    })();
    this.profileRefreshes.set(key, refresh);
    try {
      return await refresh;
    } finally {
      if (this.profileRefreshes.get(key) === refresh) this.profileRefreshes.delete(key);
    }
  }

  async restoreCachedSession(): Promise<UserInfo | null> {
    const result = await this.restoreCachedSessionState();
    return result.status === "authenticated" ? result.userInfo : null;
  }

  async restoreCachedSessionState(): Promise<OAuthCachedSessionRestoreResult> {
    return this.withCurrentCredentialStore(() => this.restoreCachedSessionStateInternal());
  }

  private async withCurrentCredentialStore<T>(operation: () => Promise<T>): Promise<T> {
    const guard = await this.captureCredentialGuard?.();
    return guard ? guard(operation) : operation();
  }

  private async restoreCachedSessionStateInternal(): Promise<OAuthCachedSessionRestoreResult> {
    const restoreGeneration = this.oauthSessionGeneration;
    const snapshot = await this.repo.loadSessionSnapshot();
    const activeProvider = snapshot["oauth:active_provider"];
    if (!activeProvider) {
      log("restoreCachedSession skipped: no active provider");
      return { status: "signed-out" };
    }

    const adapter = this.adapters.get(activeProvider);
    if (!adapter || !adapter.meta.enabled) {
      log(
        "restoreCachedSession aborted: provider unavailable, clearing active provider:",
        activeProvider,
      );
      if (!(await this.repo.clearActiveSession(snapshot))) return this.restoreCachedSessionState();
      return { status: "signed-out" };
    }

    const profile = this.repo.profileFromSnapshot(snapshot, activeProvider);
    if (!profile) {
      // OAuth tokens for providers such as ZAI/BigModel have short lifetimes. If startup strictly requires remote userinfo validation,
      // a user who just signed in may be misclassified as signed out because access_token has expired.
      // Prefer user_info persisted after successful sign-in; restore the displayed state from cache unless the user explicitly signed out.
      log("restoreCachedSession skipped: missing cached user profile:", activeProvider);
      return { status: "signed-out" };
    }

    // Startup cache restoration checks only the shared zcode JWT. Reading the provider access token here would put the
    // BigModel profile migration, which should run in the background, back on the first-screen restoration path.
    // Upstream also checks the business JWT here; that is deferred because the fork test pins this path to the shared JWT only.
    const zcodeJwtToken = snapshot[ZCODE_JWT_TOKEN_KEY]?.trim() ?? "";
    if (zcodeJwtToken && resolveJwtExpiration(zcodeJwtToken, this.now()).kind === "expired") {
      serviceLog.info("cached session invalidated because zcode JWT expired", {
        provider: activeProvider,
      });
      const invalidated = await this.invalidateExpiredCachedSession(
        restoreGeneration,
        activeProvider,
        profile,
        zcodeJwtToken,
        snapshot,
      );
      if (!invalidated) {
        return this.restoreCachedSessionState();
      }
      return { status: "reauthentication-required", reason: "jwt-expired" };
    }

    if (activeProvider === BIGMODEL_PROVIDER_ID) {
      const migrationGeneration = this.oauthSessionGeneration;
      void refreshLegacyBigModelCachedProfile({
        adapter,
        cachedProfile: profile,
        loadTokenSet: () =>
          this.loadBigModelCachedProfileMigrationTokenSet(migrationGeneration, profile),
        now: this.now,
        runWithAdapterError: (run) => this.runWithAdapterError(adapter, run),
        saveProfile: (nextProfile) =>
          this.saveBigModelCachedProfileMigration(
            migrationGeneration,
            profile,
            nextProfile,
            snapshot,
          ),
      })
        .then((migratedProfile) => {
          if (migratedProfile !== profile) {
            log(
              "restoreCachedSession migrated cached profile:",
              activeProvider,
              migratedProfile.id,
            );
          }
        })
        .catch((error: unknown) => {
          log(
            "restoreCachedSession background profile migration failed:",
            activeProvider,
            error instanceof Error ? error.message : String(error),
          );
        });
    }

    if (isZaiOAuthProvider(activeProvider)) {
      if (!zcodeJwtToken) {
        // The sidebar sign-in entry previously checked only cached user_info and misclassified a missing zcodejwttoken as signed in.
        // Add the zcodejwttoken requirement so missing backend JWTs are consistently treated as signed out.
        log("restoreCachedSession skipped: missing zcodejwttoken:", activeProvider);
        return { status: "signed-out" };
      }
    }

    log("restoreCachedSession restored:", activeProvider, profile.id);
    return { status: "authenticated", userInfo: toUserInfo(profile) };
  }

  private async invalidateExpiredCachedSession(
    expectedGeneration: number,
    expectedProvider: OAuthProviderId,
    expectedProfile: OAuthUserProfile,
    expectedJwt: string,
    expectedSnapshot: Readonly<Record<string, string | null>>,
    credentialKey = ZCODE_JWT_TOKEN_KEY,
  ): Promise<boolean> {
    const invalidated = await this.runSessionMutation(async () => {
      const snapshot = await this.repo.loadSessionSnapshot();
      const currentProvider = snapshot["oauth:active_provider"];
      const currentProfile = this.repo.profileFromSnapshot(snapshot, expectedProvider);
      const currentJwt = snapshot[credentialKey]?.trim() ?? "";
      if (
        this.oauthSessionGeneration !== expectedGeneration ||
        currentProvider !== expectedProvider ||
        !currentProfile ||
        !isSameOAuthProfile(currentProfile, expectedProfile) ||
        currentJwt !== expectedJwt
      ) {
        // A new sign-in or provider switch may complete after startup restoration reads expired credentials;
        // an old restoration task may clear only a session that still exactly matches its snapshot, never newly written auth state.
        serviceLog.info("skipped stale expired JWT session invalidation", {
          provider: expectedProvider,
        });
        return false;
      }
      if (!(await this.repo.clearActiveSession(expectedSnapshot))) return false;
      this.oauthSessionGeneration += 1;
      this.sessionChanges.fire("signed-out");
      return true;
    });
    if (!invalidated) {
      return false;
    }
    await this.cancelPending(expectedProvider);
    try {
      await this.notifyProviderLogout(expectedProvider, expectedProfile.id);
    } catch (error) {
      // When the JWT expires, invalidate the primary authentication state first; failure to clear derived providers must not leave the UI in a false signed-in state.
      serviceLog.warn("expired JWT derived provider cleanup failed", {
        provider: expectedProvider,
        error,
      });
    }
    return true;
  }

  private async loadBigModelCachedProfileMigrationTokenSet(
    expectedGeneration: number,
    expectedCachedProfile: OAuthUserProfile,
  ): Promise<OAuthTokenSet | null> {
    return this.runSessionMutation(async () => {
      if (this.oauthSessionGeneration !== expectedGeneration) {
        log("restoreCachedSession skipped stale BigModel token migration");
        return null;
      }

      const activeProvider = await this.repo.getActiveProvider();
      const currentProfile = await this.repo.loadUserProfile(BIGMODEL_PROVIDER_ID);
      if (
        activeProvider !== BIGMODEL_PROVIDER_ID ||
        !currentProfile ||
        !isSameOAuthProfile(currentProfile, expectedCachedProfile)
      ) {
        // The migration request always targets BigModel, so read the token only from the BigModel namespace;
        // recheck the persisted snapshot before sending to avoid sending another provider's token to BigModel after a switch to ZAI.
        log("restoreCachedSession skipped stale BigModel token migration:", activeProvider);
        return null;
      }

      return this.repo.loadTokenSet(BIGMODEL_PROVIDER_ID);
    });
  }

  private async saveBigModelCachedProfileMigration(
    expectedGeneration: number,
    expectedCachedProfile: OAuthUserProfile,
    nextProfile: OAuthUserProfile,
    expectedSnapshot: Readonly<Record<string, string | null>>,
  ): Promise<void> {
    await this.runSessionMutation(async () => {
      if (this.oauthSessionGeneration !== expectedGeneration) {
        log("restoreCachedSession skipped stale BigModel profile migration");
        return;
      }

      const activeProvider = await this.repo.getActiveProvider();
      if (activeProvider !== BIGMODEL_PROVIDER_ID) {
        log("restoreCachedSession skipped stale BigModel profile migration:", activeProvider);
        return;
      }

      const currentProfile = await this.repo.loadUserProfile(BIGMODEL_PROVIDER_ID);
      if (!currentProfile || !isSameOAuthProfile(currentProfile, expectedCachedProfile)) {
        // BigModel legacy cache migration runs in the background, during which the user may sign out, switch to ZAI,
        // or sign in to BigModel again. Persist the migration result only if the current cache still matches the legacy cache from startup.
        log("restoreCachedSession skipped outdated BigModel profile migration");
        return;
      }

      if (!(await this.repo.saveUserProfile(BIGMODEL_PROVIDER_ID, nextProfile, expectedSnapshot)))
        throw new Error("OAuth session changed during cached profile migration");
    });
  }

  private runSessionMutation<T>(run: () => Promise<T>): Promise<T> {
    // Background profile migration, logout, and provider switching all modify OAuth credentials;
    // serialize them so an old migration cannot rewrite user_info after logout or switch cleanup.
    const next = this.sessionMutationQueue.catch(() => undefined).then(run);
    this.sessionMutationQueue = next.catch(() => undefined);
    return next;
  }

  private async persistOAuthSession(
    provider: OAuthProviderId,
    tokenSet: OAuthTokenSet,
    profile: OAuthUserProfile,
    expected: Readonly<Record<string, string | null>>,
    isStillCurrent: () => boolean,
  ): Promise<void> {
    const committed = await this.repo.commitSession(
      expected,
      provider,
      tokenSet,
      withProviderProfileSchema(provider, profile),
      () => {
        if (!isStillCurrent()) throw new Error("OAuth flow 已取消");
      },
    );
    // 条件失败表示另一写入者已经改变会话；不能用回滚再覆盖对方的新登录。
    if (!committed) throw new Error("OAuth 会话已变化，请重新发起登录");
    this.oauthSessionGeneration += 1;
    this.sessionChanges.fire("signed-in");
  }

  private async runPendingSessionCompletion(
    pending: PendingState,
    complete: () => Promise<{ tokenSet: OAuthTokenSet; profile: OAuthUserProfile }>,
    preserveAttribution?: () => Promise<void>,
  ): Promise<OAuthCallbackResult | null> {
    // The recovery generation is fixed when the flow starts; admission attribution and final commit both reuse it, so late results cannot write into the restored store.
    const guarded = <T>(operation: () => Promise<T>): Promise<T> =>
      pending.credentialGuard ? pending.credentialGuard(operation) : operation();
    const completion = (async (): Promise<OAuthCallbackResult | null> => {
      const admitted = await this.runSessionMutation(() =>
        guarded(async () => {
          if (this.pendingState !== pending) {
            if (
              !this.pendingState &&
              this.recentlyCompletedPollingState?.state === pending.state &&
              this.recentlyCompletedPollingState.generation === this.oauthFlowStartGeneration
            )
              await preserveAttribution?.();
            return false;
          }
          await preserveAttribution?.();
          return true;
        }),
      );
      if (!admitted) {
        return !this.pendingState &&
          this.recentlyCompletedPollingState?.state === pending.state &&
          this.recentlyCompletedPollingState.generation === this.oauthFlowStartGeneration
          ? { kind: "duplicate", provider: pending.provider }
          : null;
      }
      // Network calls do not occupy the session queue, so cancellation need not wait for slow requests; only final commit and cancellation are linearized in queue order.
      const { tokenSet, profile } = await complete();
      return this.runSessionMutation(() =>
        guarded(async () => {
          if (this.pendingState !== pending) {
            return !this.pendingState &&
              this.recentlyCompletedPollingState?.state === pending.state &&
              this.recentlyCompletedPollingState.generation === this.oauthFlowStartGeneration
              ? { kind: "duplicate", provider: pending.provider }
              : null;
          }
          await this.persistOAuthSession(
            pending.provider,
            tokenSet,
            profile,
            pending.expectedSession,
            () => this.pendingState === pending,
          );
          this.clearPendingState();
          this.recentlyCompletedPollingState = {
            credentialGuard: pending.credentialGuard,
            generation: this.oauthFlowStartGeneration,
            expiresAt: this.now() + COMPLETED_POLLING_STATE_GRACE_MS,
            provider: pending.provider,
            state: pending.state,
          };
          return { kind: "session", provider: pending.provider, userInfo: toUserInfo(profile) };
        }),
      );
    })();
    // A single "last candidate" would miss a slow earlier request, which a later failure would then cancel early.
    // Record all in-flight candidates; wait for the original candidates rather than each other's error handling to avoid mutual waits.
    const completions = (pending.completions ??= new Set());
    completions.add(completion);
    void completion.then(
      () => completions.delete(completion),
      () => completions.delete(completion),
    );
    try {
      return await completion;
    } catch (error) {
      if (
        !this.pendingState &&
        this.recentlyCompletedPollingState?.state === pending.state &&
        this.recentlyCompletedPollingState.generation === this.oauthFlowStartGeneration
      )
        return { kind: "duplicate", provider: pending.provider };
      if (this.pendingState !== pending) return null;
      serviceLog.warn(undefined, "OAuth completion candidate failed", {
        provider: pending.provider,
      });
      while (completions.size > 0 && this.pendingState === pending) {
        await Promise.allSettled(completions);
        if (
          !this.pendingState &&
          this.recentlyCompletedPollingState?.state === pending.state &&
          this.recentlyCompletedPollingState.generation === this.oauthFlowStartGeneration
        ) {
          return { kind: "duplicate", provider: pending.provider };
        }
        if (this.pendingState !== pending) return null;
      }
      throw error;
    }
  }

  async restoreSession(): Promise<UserInfo | null> {
    return this.withCurrentCredentialStore(() => this.restoreSessionInternal());
  }

  private async restoreSessionInternal(): Promise<UserInfo | null> {
    const snapshot = await this.repo.loadSessionSnapshot();
    const activeProvider = snapshot["oauth:active_provider"];
    if (!activeProvider) {
      log("restoreSession skipped: no active provider");
      return null;
    }

    log("restoreSession started:", activeProvider);

    const adapter = this.adapters.get(activeProvider);
    if (!adapter || !adapter.meta.enabled) {
      log(
        "restoreSession aborted: provider unavailable, clearing active provider:",
        activeProvider,
      );
      await this.repo.clearActiveSession(snapshot);
      return null;
    }

    let tokenSet = this.repo.tokenSetFromSnapshot(snapshot, activeProvider);
    if (!tokenSet && adapter.loadLegacyTokenSet) {
      log("restoreSession fallback: trying provider legacy token set:", activeProvider);
      tokenSet = await adapter.loadLegacyTokenSet((key) => this.credentialService.load(key));
    }

    if (!tokenSet || !adapter.fetchUserInfo) {
      log(
        "restoreSession failed: missing token or user-info capability, logging out:",
        activeProvider,
      );
      await this.logoutActiveSession(
        async () =>
          JSON.stringify(await this.repo.loadSessionSnapshot()) === JSON.stringify(snapshot),
      );
      return null;
    }

    try {
      log("restoreSession validating token with provider userinfo endpoint:", activeProvider);
      const fetchedProfile = await this.runWithAdapterError(adapter, () =>
        adapter.fetchUserInfo!(tokenSet, {
          providerId: activeProvider,
          state: "",
          redirectUri: adapter.redirectUri,
          now: this.now,
        }),
      );

      const cachedProfile = this.repo.profileFromSnapshot(snapshot, activeProvider);
      // Explicit recovery and background profile migration share one boundary: upstream userinfo may update display only, never replace the primary identity.
      // Without trusted cache, ZCode login must be completed again; never build the primary user from customerNumber or sub.
      if (
        (activeProvider === BIGMODEL_PROVIDER_ID || activeProvider === ZAI_PROVIDER_ID) &&
        (!cachedProfile || cachedProfile.id === "unknown")
      )
        return null;
      const profile =
        activeProvider === BIGMODEL_PROVIDER_ID || activeProvider === ZAI_PROVIDER_ID
          ? mergeOAuthDisplayProfile(cachedProfile!, fetchedProfile)
          : fetchedProfile;

      // The profile may only supplement the original principal; never combine an old JWT with another user ID into a new login.
      if (
        activeProvider === ZAI_CN_PROVIDER_ID &&
        profile.id !== this.repo.profileFromSnapshot(snapshot, activeProvider)?.id
      ) {
        throw new Error("profile 返回的账号与当前会话不一致");
      }
      if (
        !(await this.repo.commitSession(
          snapshot,
          activeProvider,
          {
            ...tokenSet,
            zcodeJwtToken: tokenSet.zcodeJwtToken ?? snapshot[ZCODE_JWT_TOKEN_KEY] ?? undefined,
          },
          withProviderProfileSchema(activeProvider, profile),
        ))
      )
        return null;
      log("restoreSession validated:", activeProvider, profile.id);
      return toUserInfo(profile);
    } catch (error) {
      const normalized = adapter.normalizeError(error);

      // Startup restoration that relies only on local credentials would misclassify an expired token as signed in.
      // When the remote explicitly returns unauthorized (401/403), clear local sign-in state immediately through the logout flow.
      if (activeProvider !== ZAI_CN_PROVIDER_ID && this.isUnauthorizedError(normalized)) {
        log("restoreSession unauthorized, logging out:", activeProvider, normalized.message);
        await this.logoutActiveSession(
          async () =>
            JSON.stringify(await this.repo.loadSessionSnapshot()) === JSON.stringify(snapshot),
        );
        return null;
      }

      log("restoreSession validation error:", activeProvider, normalized.message);

      throw normalized;
    }
  }

  async startOAuth(provider: OAuthProviderId): Promise<OAuthStartResponse> {
    if (provider === ZAI_CN_PROVIDER_ID) return this.startOAuthWithPolling(provider);
    return this.startOAuthInternal(provider);
  }

  async startOAuthWithPolling(provider: OAuthProviderId): Promise<OAuthStartResponse> {
    if (!isBuiltinOAuthProvider(provider)) {
      return this.startOAuthInternal(provider);
    }

    const adapter = this.getEnabledAdapter(provider);
    if (!this.apiClient) {
      throw new Error("ApiClient 注入缺失：OAuth polling 必须通过 Providers 传入 apiClient");
    }
    // If two inits run concurrently, an older response that returns later would overwrite a newer pending flow.
    // generation lets the last user action own the flow; an old response only completes its own caller.
    const { startGeneration, expectedSession, credentialGuard } = await this.runSessionMutation(
      async () => {
        const startGeneration = ++this.oauthFlowStartGeneration;
        this.oauthFlowStartProvider = provider;
        this.clearPendingState();
        // Fix the restore generation before reading the session snapshot so both come from the same credential-store generation.
        const credentialGuard = await this.captureCredentialGuard?.();
        return {
          startGeneration,
          credentialGuard,
          expectedSession: await this.repo.loadSessionSnapshot(),
        };
      },
    );
    if (this.oauthFlowStartGeneration !== startGeneration)
      throw new Error("OAuth flow 已被新的登录请求替换");
    const pollToken = randomBytes(32).toString("hex");
    const initUrl = buildZCodeApiUrlFromEnv(this.env, "/api/v1/oauth/cli/init");
    const envelope = await readApiJson<OAuthFlowEnvelope>(this.apiClient, initUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pollToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ provider }),
    });
    if (this.oauthFlowStartGeneration !== startGeneration) {
      throw new Error("OAuth flow 已被新的登录请求替换");
    }
    this.oauthFlowStartProvider = null;
    const data = envelope.data;
    if (
      envelope.code !== 0 ||
      !isUnknownRecord(data) ||
      !readTrimmedString(data.flow_id) ||
      !readTrimmedString(data.authorize_url) ||
      !Number.isFinite(data.expires_at) ||
      !Number.isFinite(data.poll_interval_sec)
    ) {
      throw new Error(readTrimmedString(envelope.msg) || "OAuth flow 初始化响应无效");
    }

    const flowId = readTrimmedString(data.flow_id)!;
    const authorizeUrlString = readTrimmedString(data.authorize_url)!;
    const expiresAt = (data.expires_at as number) * 1_000;
    const pollIntervalMs = (data.poll_interval_sec as number) * 1_000;
    let authorizeUrl: URL;
    try {
      authorizeUrl = new URL(authorizeUrlString);
    } catch {
      throw new Error("OAuth flow 初始化响应无效");
    }
    if (provider === BIGMODEL_PROVIDER_ID) {
      // The BigModel CLI callback failure page interrupts the existing Desktop deep-link callback experience.
      // Host still polls the flow, but browser callbacks return to the official-site relay page and are forwarded to zcode://oauth/callback.
      authorizeUrl.searchParams.set("redirect", buildDesktopOAuthRedirectUriFromEnv(this.env));
    } else if (isZaiOAuthProvider(provider)) {
      // The China channel once skipped the relay rewrite; pass the channel explicitly so the official site never sends a
      // China authorization code to the overseas callback. Only the callback changes; the authorize host, client_id and
      // state stay with the server.
      const redirectUri = new URL(buildDesktopOAuthRedirectUriFromEnv(this.env));
      if (provider === ZAI_CN_PROVIDER_ID) redirectUri.searchParams.set("provider", provider);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri.toString());
    }
    const state = authorizeUrl.searchParams.get("state")?.trim();
    const remainingLifetimeMs = expiresAt - this.now();
    if (
      authorizeUrl.protocol !== "https:" ||
      !state ||
      !Number.isFinite(expiresAt) ||
      !Number.isFinite(pollIntervalMs) ||
      remainingLifetimeMs <= 0 ||
      pollIntervalMs < 1_000 ||
      pollIntervalMs >= remainingLifetimeMs
    ) {
      throw new Error("OAuth flow 初始化响应无效");
    }

    const timeoutMs = Math.min(OAUTH_TIMEOUT_MS, remainingLifetimeMs);
    // Full-store restoration may happen during initialization; an old flow must not regain write eligibility after restoration.
    await credentialGuard?.(() => this.credentialService.inspectStore());
    if (this.oauthFlowStartGeneration !== startGeneration)
      throw new Error("OAuth flow 已被新的登录请求替换");
    const timeout = setTimeout(() => {
      const pending = this.pendingState;
      // A polling flow timeout must close immediately instead of waiting for the next UI poll; also verify flowId so an old timer cannot clear a new flow.
      void this.runSessionMutation(async () => {
        if (
          this.pendingState === pending &&
          pending?.state === state &&
          pending.polling?.flowId === flowId
        ) {
          this.clearPendingState();
          // Bug cause: this only clears the flow; pollPendingOAuth then returns null because pending is empty, and the UI treats null as still waiting,
          // leaving the login page stuck. Record the expiry fact for this generation so the next poll throws an expired error.
          this.expiredPollingGeneration = startGeneration;
        }
      });
    }, timeoutMs);
    this.pendingState = {
      credentialGuard,
      state,
      expectedSession,
      provider: adapter.providerId,
      timeout,
      phase: "awaiting-attribution-or-code",
      ...(provider === ZAI_CN_PROVIDER_ID
        ? { redirectUri: authorizeUrl.searchParams.get("redirect_uri") ?? undefined }
        : {}),
      polling: {
        expiresAt,
        flowId,
        nextPollAt: this.monotonicNow(),
        pollIntervalMs,
        pollToken,
        pollUrl: buildZCodeApiUrlFromEnv(
          this.env,
          `/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`,
        ),
      },
    };

    serviceLog.info("OAuth polling flow started", {
      expiresInMs: timeoutMs,
      pollIntervalMs,
      provider,
    });
    return { provider, authorizeUrl: authorizeUrl.toString(), state };
  }

  async pollPendingOAuth(): Promise<OAuthCallbackResult | null> {
    const apiClient = this.apiClient;
    if (!apiClient) {
      return null;
    }
    const pending = this.pendingState;
    const polling = pending?.polling;
    if (!pending || !polling) {
      if (this.expiredPollingGeneration === this.oauthFlowStartGeneration)
        throw new Error("OAuth flow 已过期");
      return null;
    }
    if (this.now() >= polling.expiresAt) {
      await this.cancelPending(pending.provider);
      throw new Error("OAuth flow 已过期");
    }
    // A system clock rollback would keep absolute-time intervals from expiring; schedule polling with a monotonic clock only.
    // The server-side absolute expiry check above and the local five-minute cap still apply independently.
    const pollNow = this.monotonicNow();
    if (pollNow < polling.nextPollAt) {
      return null;
    }
    polling.nextPollAt = pollNow + polling.pollIntervalMs;

    let envelope: OAuthFlowEnvelope;
    try {
      envelope = await readApiJson<OAuthFlowEnvelope>(apiClient, polling.pollUrl, {
        headers: { Authorization: `Bearer ${polling.pollToken}` },
      });
    } catch (error) {
      if (this.pendingState !== pending) return null;
      if (
        error instanceof ApiError &&
        error.status &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 429
      ) {
        try {
          return await this.runPendingSessionCompletion(pending, async () => {
            throw error;
          });
        } catch (terminalError) {
          await this.runSessionMutation(async () => {
            if (this.pendingState === pending) this.clearPendingState();
          });
          throw terminalError;
        }
      }
      // Polling is the reliable path when a deep link is lost; one network outage or 5xx must not cancel the flow immediately.
      // Keep the server-provided query interval and try again next time; log high-frequency status only at debug to avoid production log growth.
      serviceLog.debug("OAuth polling request will retry", {
        error: error instanceof Error ? error.message : String(error),
        provider: pending.provider,
      });
      return null;
    }
    if (this.pendingState !== pending) {
      return null;
    }
    if (
      envelope.code === 0 &&
      isUnknownRecord(envelope.data) &&
      readTrimmedString(envelope.data.status) === "pending"
    ) {
      return null;
    }
    try {
      const result = await this.runPendingSessionCompletion(pending, async () => {
        const pollData = envelope.data;
        if (envelope.code !== 0 || !isUnknownRecord(pollData)) {
          throw new Error(readTrimmedString(envelope.msg) || "OAuth flow 查询响应无效");
        }
        const status = readTrimmedString(pollData.status);
        if (status === "failed") {
          throw new Error("OAuth flow 授权失败");
        }
        if (status !== "ready") {
          throw new Error("OAuth flow 查询响应无效");
        }

        const ready = pollData;
        const user = isUnknownRecord(ready.user) ? ready.user : null;
        const zai = isUnknownRecord(ready.zai) ? ready.zai : null;
        const bigmodel = isUnknownRecord(ready.bigmodel) ? ready.bigmodel : null;
        const providerAccessToken = isZaiOAuthProvider(pending.provider)
          ? readTrimmedString(zai?.access_token)
          : readTrimmedString(bigmodel?.access_token) || readTrimmedString(bigmodel?.accessToken);
        const zcodeJwtToken = readTrimmedString(ready.token);
        const userId = readTrimmedString(user?.user_id);
        if (!zcodeJwtToken || !providerAccessToken || !userId) {
          throw new Error("OAuth flow 查询响应无效");
        }
        const username = readTrimmedString(user?.name) || readTrimmedString(user?.email) || userId;
        const avatarUrl = readTrimmedString(user?.avatar);
        const profile: OAuthUserProfile = {
          id: userId,
          username,
          displayName: username,
          ...(avatarUrl ? { avatarUrl } : {}),
          rawProfile: user,
        };
        const adapter = this.getAdapter(pending.provider);
        const refreshToken =
          pending.provider === BIGMODEL_PROVIDER_ID
            ? readTrimmedString(bigmodel?.refresh_token) ||
              readTrimmedString(bigmodel?.refreshToken)
            : undefined;
        const linkedBigModel = isZaiOAuthProvider(pending.provider)
          ? readLinkedBigModel(ready.bigmodel)
          : undefined;
        const tokenSet = adapter.normalizePolledTokenSet
          ? await adapter.normalizePolledTokenSet({
              accessToken: providerAccessToken,
              zcodeJwtToken,
              linkedBigModel,
              ...(refreshToken ? { refreshToken } : {}),
            })
          : {
              accessToken: providerAccessToken,
              zcodeJwtToken,
              linkedBigModel,
              ...(refreshToken ? { refreshToken } : {}),
            };
        return { tokenSet, profile };
      });
      if (result?.kind === "session") {
        serviceLog.info("OAuth polling flow completed", { provider: pending.provider });
      }
      return result;
    } catch (error) {
      await this.runSessionMutation(async () => {
        if (this.pendingState === pending) this.clearPendingState();
      });
      throw error;
    }
  }

  private async startOAuthInternal(provider: OAuthProviderId): Promise<OAuthStartResponse> {
    const adapter = this.getEnabledAdapter(provider);

    // When different providers are clicked quickly in the same window, failing to cancel the old state first lets both flows share one callback channel,
    // so a later callback takes over and causes a state mismatch.
    const start = await this.runSessionMutation(async () => {
      this.oauthFlowStartGeneration += 1;
      this.oauthFlowStartProvider = null;
      this.clearPendingState();
      // Fix the restore generation before reading the session snapshot so both come from the same credential-store generation.
      const credentialGuard = await this.captureCredentialGuard?.();
      return {
        generation: this.oauthFlowStartGeneration,
        credentialGuard,
        expectedSession: await this.repo.loadSessionSnapshot(),
      };
    });
    if (start.generation !== this.oauthFlowStartGeneration)
      throw new Error("OAuth flow 已被新的登录请求替换");

    const state = randomBytes(32).toString("hex");
    const timeout = setTimeout(() => {
      void this.runSessionMutation(async () => {
        if (this.pendingState?.state === state) this.clearPendingState();
      });
    }, OAUTH_TIMEOUT_MS);

    this.pendingState = {
      credentialGuard: start.credentialGuard,
      state,
      expectedSession: start.expectedSession,
      provider: adapter.providerId,
      timeout,
      phase: "awaiting-attribution-or-code",
    };

    const authorizeUrl = adapter.buildAuthorizeUrl({
      providerId: adapter.providerId,
      state,
      redirectUri: adapter.redirectUri,
      now: this.now,
    });

    return {
      provider: adapter.providerId,
      authorizeUrl,
      state,
    };
  }

  async handleCallback(url: string): Promise<OAuthCallbackResult | null> {
    const pending = this.pendingState;
    if (!pending) {
      const callbackState = new URL(url).searchParams.get("state")?.trim();
      const completed = this.recentlyCompletedPollingState;
      if (
        callbackState &&
        completed?.state === callbackState &&
        completed.generation === this.oauthFlowStartGeneration &&
        this.now() < completed.expiresAt
      ) {
        const attribution = parseOAuthLoginAttribution(new URL(url).searchParams);
        await this.runSessionMutation(async () => {
          // Fix rationale: even when polling succeeds first, browser attribution must still be saved; sign-in deduplication must not discard the entire callback.
          if (
            !this.pendingState &&
            this.recentlyCompletedPollingState === completed &&
            completed.generation === this.oauthFlowStartGeneration &&
            attribution
          ) {
            const save = () => this.repo.saveLoginAttribution(attribution);
            await (completed.credentialGuard ? completed.credentialGuard(save) : save());
          }
        });
        return { kind: "duplicate", provider: completed.provider };
      }
      throw new Error("OAuth state 不匹配或已过期");
    }

    const parsedUrl = new URL(url);
    const state = parsedUrl.searchParams.get("state");
    if (!state || state !== pending.state) {
      throw new Error("OAuth state 不匹配或已过期");
    }
    if (pending.polling && this.now() >= pending.polling.expiresAt) {
      await this.cancelPending(pending.provider);
      throw new Error("OAuth flow 已过期");
    }

    const attribution = parseOAuthLoginAttribution(parsedUrl.searchParams);
    if (attribution && !hasOAuthAuthorizationCode(parsedUrl.searchParams)) {
      if (pending.phase === "awaiting-code-after-attribution") {
        throw new Error("OAuth 归因回调已处理");
      }

      // Fix rationale: an attribution-only callback is an intermediate step before the final authorization code and cannot clear state needed to continue sign-in;
      // but without explicitly advancing phase, the same state could write attribution repeatedly and implicitly reuse the pending lifecycle.
      pending.phase = "awaiting-code-after-attribution";
      try {
        // A plain save claims the restored new generation; attribution-only writes must also reuse the pending old generation so late callbacks cannot write into the new store.
        const save = () => this.repo.saveLoginAttribution(attribution);
        await (pending.credentialGuard ? pending.credentialGuard(save) : save());
      } catch (error) {
        if (this.pendingState === pending) {
          pending.phase = "awaiting-attribution-or-code";
        }
        throw error;
      }
      return {
        kind: "attribution",
        provider: pending.provider,
        attribution,
      };
    }

    if (pending.provider === ZAI_CN_PROVIDER_ID && pending.polling) {
      // 官网已把国内授权码交给后端；客户端再次兑换会争抢一次性 code。
      // 唤起只补归因，登录仍由同一 flow 的 polling 提交；旧回调不能写入新会话。
      const generation = this.oauthFlowStartGeneration;
      return this.runSessionMutation(async () => {
        const completed = this.recentlyCompletedPollingState;
        const sameFlow =
          this.oauthFlowStartGeneration === generation &&
          (this.pendingState === pending ||
            (!this.pendingState &&
              completed?.state === pending.state &&
              completed.generation === generation &&
              this.now() < completed.expiresAt));
        if (sameFlow && attribution) {
          const save = () => this.repo.saveLoginAttribution(attribution);
          await (pending.credentialGuard ? pending.credentialGuard(save) : save());
        }
        return null;
      });
    }

    const adapter = this.getAdapter(pending.provider);
    const fallbackProfile: OAuthUserProfile = {
      id: "unknown",
      username: "user",
      displayName: "User",
    };

    return this.runPendingSessionCompletion(
      pending,
      async () => {
        const callback = adapter.parseCallbackParams(url);
        const context = {
          providerId: adapter.providerId,
          state: callback.state,
          redirectUri: pending.redirectUri ?? adapter.redirectUri,
          now: this.now,
        };
        const tokenSet = await this.runWithAdapterError(adapter, () =>
          adapter.exchangeToken(callback, context),
        );
        let profile = fallbackProfile;
        if (adapter.fetchUserInfo) {
          try {
            profile = await this.runWithAdapterError(adapter, () =>
              adapter.fetchUserInfo!(tokenSet, context),
            );
          } catch {
            // Failure to fetch user info does not block sign-in.
          }
        }
        return { tokenSet, profile };
      },
      attribution ? () => this.repo.saveLoginAttribution(attribution) : undefined,
    );
  }

  async refreshToken(provider?: OAuthProviderId): Promise<void> {
    return this.withCurrentCredentialStore(() => this.refreshTokenInternal(provider));
  }

  private async refreshTokenInternal(provider?: OAuthProviderId): Promise<void> {
    const generation = this.oauthSessionGeneration;
    const targetProvider = await this.resolveProvider(provider);
    if (!targetProvider) {
      throw new Error("当前没有可用的登录 provider");
    }

    const adapter = this.getEnabledAdapter(targetProvider);
    if (!adapter.refreshToken) {
      throw new Error(
        `${adapter.meta.displayName} OAuth 暂未提供 refresh token 交换接口，请重新登录`,
      );
    }

    const snapshot = await this.repo.loadSessionSnapshot();
    const activeProvider = snapshot["oauth:active_provider"];
    if (targetProvider !== activeProvider) {
      throw new Error("只能刷新当前 App 登录 provider，请重新登录");
    }

    const tokenSet = this.repo.tokenSetFromSnapshot(snapshot, targetProvider);
    if (!tokenSet?.refreshToken) {
      throw new Error("当前账号缺少 refresh_token，请重新登录");
    }

    const refreshed = await this.runWithAdapterError(adapter, () =>
      adapter.refreshToken!(tokenSet, {
        providerId: targetProvider,
        state: "",
        redirectUri: adapter.redirectUri,
        now: this.now,
      }),
    );

    await this.runSessionMutation(async () => {
      if (this.oauthSessionGeneration !== generation) return;
      await this.repo.saveTokenSet(
        targetProvider,
        {
          ...tokenSet,
          ...refreshed,
          zcodeJwtToken: refreshed.zcodeJwtToken ?? tokenSet.zcodeJwtToken,
        },
        snapshot,
      );
    });
  }

  /** Host-local 401 commit entry point; does not expand the cross-platform IOAuthService contract. */
  logoutIfCurrentCredentialRequest(input: string | URL, headers: Headers): Promise<boolean> {
    return this.withCurrentCredentialStore(() =>
      this.logoutActiveSession(() =>
        isCurrentOAuthCredentialRequest({
          input,
          headers,
          credentialService: this.credentialService,
          env: this.env,
        }),
      ),
    );
  }

  private async logoutActiveSession(isCurrent?: () => Promise<boolean>): Promise<boolean> {
    const result = await this.runSessionMutation(async () => {
      // An async classification of true does not authorize cleanup; credential revalidation and cleanup must share the queue with sign-in writes.
      const snapshot = await this.repo.loadSessionSnapshot();
      if (isCurrent && !(await isCurrent())) return null;
      const activeProvider = snapshot["oauth:active_provider"];
      // Merge boundary: keep the original account identity before cleanup; do not fall back to platform-only cleanup or guess the identity after logout.
      const accountIdentity = activeProvider
        ? (this.repo.profileFromSnapshot(snapshot, activeProvider)?.id ?? null)
        : null;
      if (!(await this.repo.clearActiveSession(snapshot))) return null;
      this.oauthSessionGeneration += 1;
      // Logout has taken effect: even if later provider/settings cleanup fails, the authenticated remote-control connection must be revoked first.
      this.sessionChanges.fire("signed-out");
      return { activeProvider, accountIdentity };
    });
    if (!result) return false;
    if (result.activeProvider) {
      await this.cancelPending(result.activeProvider);
      try {
        await this.notifyProviderLogout(result.activeProvider, result.accountIdentity);
      } catch (error) {
        if (!isCurrent) throw error;
        // Credentials are already cleared; failure to clear derived config must not suppress the original expiration notice. Manual logout keeps its existing error semantics.
        serviceLog.warn("Unauthorized session provider cleanup failed", { error });
      }
    }
    return true;
  }

  async logout(provider?: OAuthProviderId): Promise<void> {
    return this.withCurrentCredentialStore(() => this.logoutInternal(provider));
  }

  private async logoutInternal(provider?: OAuthProviderId): Promise<void> {
    if (!provider) {
      if (!(await this.logoutActiveSession())) throw new Error("OAuth 会话已变化，请重新退出");
      return;
    }

    const loggedOutIdentity = await this.runSessionMutation(async () => {
      const snapshot = await this.repo.loadSessionSnapshot();
      const activeProvider = snapshot["oauth:active_provider"];
      if (provider !== activeProvider) {
        return undefined;
      }
      const accountIdentity = this.repo.profileFromSnapshot(snapshot, provider)?.id ?? null;
      // ZAI/BigModel provider Unlink has converged to App logout.
      // Only the current active provider represents the login fact, preventing a legacy unlink path from deleting a non-current provider token.
      if (!(await this.repo.clearActiveSession(snapshot)))
        throw new Error("OAuth 会话已变化，请重新退出");
      this.oauthSessionGeneration += 1;
      this.sessionChanges.fire("signed-out");
      return accountIdentity;
    });
    if (loggedOutIdentity !== undefined) {
      await this.notifyProviderLogout(provider, loggedOutIdentity);
    }
    await this.cancelPending(provider);
  }

  async logoutAll(): Promise<void> {
    return this.withCurrentCredentialStore(() => this.logoutAllInternal());
  }

  private async logoutAllInternal(): Promise<void> {
    const providers = [...this.adapters.keys()];
    const accountIdentities = await this.runSessionMutation(async () => {
      const snapshot = await this.repo.loadSessionSnapshot();
      const identities = new Map<OAuthProviderId, string | null>();
      for (const provider of providers) {
        identities.set(provider, this.repo.profileFromSnapshot(snapshot, provider)?.id ?? null);
      }
      if (!(await this.repo.clearSession(snapshot)))
        throw new Error("OAuth 会话已变化，请重新退出");
      this.oauthSessionGeneration += 1;
      this.sessionChanges.fire("signed-out");
      return identities;
    });
    if (!accountIdentities) return;
    await this.cancelPending();
    await this.notifyProvidersLogout(providers, accountIdentities);
  }

  async cancelPending(provider?: OAuthProviderId): Promise<void> {
    await this.runSessionMutation(async () => {
      if (provider === CHATGPT_OAUTH_PROVIDER_ID || provider === undefined) {
        await this.siwcAuth.cancelLogin();
        if (provider === CHATGPT_OAUTH_PROVIDER_ID) return;
      }
      if (!this.pendingState) {
        if (provider && this.oauthFlowStartProvider && this.oauthFlowStartProvider !== provider)
          return;
      } else if (provider && this.pendingState.provider !== provider) return;
      this.oauthFlowStartGeneration += 1;
      this.oauthFlowStartProvider = null;
      this.clearPendingState();
    });
  }

  async startChatGptPlanLogin(
    options: { reauthAccountKey?: string } = {},
  ): Promise<SiwcLoginStart> {
    return this.siwcAuth.startLogin(options);
  }

  async pollChatGptPlanLogin(): Promise<SiwcLoginCompletionResult | null> {
    const result = await this.siwcAuth.pollLogin();
    if (result) {
      // The completion RPC must flip the "Waiting for ChatGPT..." UI state as soon as the
      // authorization is exchanged. The account-overlay refresh re-queries plan backends and
      // was observed taking over a minute; run it detached so only the registry/picker update
      // lags, propagated through the account source change events.
      void this.onChatGptPlanSessionChange?.().catch((error) => {
        serviceLog.warn(undefined, "ChatGPT plan account refresh after login failed", { error });
      });
    }
    return result;
  }

  async getChatGptPlanStatus(): Promise<SiwcPlanAccountsStatus> {
    return this.siwcAuth.getStatus();
  }

  async logoutChatGptPlan(
    accountKey?: string,
  ): Promise<{ accountCount: number; revoked: boolean; signedOut: boolean }> {
    const result = await this.siwcAuth.logout(accountKey);
    if (result.signedOut) {
      // Same rationale as pollChatGptPlanLogin: tokens are already cleared locally, so the
      // overlay refresh must not block the sign-out result on slow plan backend queries.
      void this.onChatGptPlanSessionChange?.().catch((error) => {
        serviceLog.warn(undefined, "ChatGPT plan account refresh after logout failed", { error });
      });
    }
    return result;
  }

  private clearPendingState(): void {
    if (!this.pendingState) {
      return;
    }

    clearTimeout(this.pendingState.timeout);
    this.pendingState = null;
  }

  private async notifyProviderLogout(
    provider: OAuthProviderId,
    accountIdentity?: string | null,
  ): Promise<void> {
    if (!this.onProviderLogout) {
      return;
    }

    await this.onProviderLogout(provider, accountIdentity);
  }

  private async notifyProvidersLogout(
    providers: readonly OAuthProviderId[],
    accountIdentities: ReadonlyMap<OAuthProviderId, string | null> = new Map(),
  ): Promise<void> {
    await Promise.all(
      providers.map((provider) =>
        this.notifyProviderLogout(provider, accountIdentities.get(provider)),
      ),
    );
  }

  private getAdapter(provider: OAuthProviderId): OAuthProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`不支持的 OAuth provider: ${provider}`);
    }

    return adapter;
  }

  private getEnabledAdapter(provider: OAuthProviderId): OAuthProviderAdapter {
    const adapter = this.getAdapter(provider);
    if (!adapter.meta.enabled) {
      throw new Error(`OAuth provider 未启用: ${provider}`);
    }

    return adapter;
  }

  private async resolveProvider(provider?: OAuthProviderId): Promise<OAuthProviderId | null> {
    if (provider) {
      return provider;
    }

    return this.repo.getActiveProvider();
  }

  private async runWithAdapterError<T>(
    adapter: OAuthProviderAdapter,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw adapter.normalizeError(error);
    }
  }

  private isUnauthorizedError(error: Error): boolean {
    const lowerMessage = error.message.toLowerCase();
    return (
      /\b401\b|\b403\b/.test(lowerMessage) ||
      lowerMessage.includes("unauthorized") ||
      lowerMessage.includes("forbidden")
    );
  }
}

/**
 * Factory function: create an OAuthService instance.
 */
export function createOAuthService(
  credentialService: ICredentialService,
  dependencies: Omit<OAuthServiceDependencies, "adapters"> = {},
): OAuthService {
  return new OAuthService(credentialService, {
    ...dependencies,
    adapters: createOAuthProviderAdapters(createOAuthRuntimeConfig(dependencies.env), {
      apiClient: dependencies.apiClient,
    }),
  });
}
