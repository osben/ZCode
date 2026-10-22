/* eslint-disable max-lines -- Keep OAuth credential storage and the ZAI/BigModel login-mirror key boundary together; splitting it would make the authentication source of truth harder to trace. */
import { Buffer } from "node:buffer";
import type {
  OAuthLoginAttribution,
  OAuthProviderId,
  OAuthTokenSet,
  OAuthUserProfile,
} from "@zcode/shared";
import { BIGMODEL_PROVIDER_ID, isCredentialDecryptError, ZAI_PROVIDER_ID } from "@zcode/shared";
import type { ICredentialService } from "../../credential/credential.js";
import { createServiceLogger } from "../../logger/serviceLogger.js";

const ACTIVE_PROVIDER_KEY = "oauth:active_provider";
const LOGIN_ATTRIBUTION_KEY = "oauth:login_attribution";
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
const KNOWN_OAUTH_PROVIDER_IDS = [BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID] as const;
const log = createServiceLogger("oauthCredentialRepo");

interface OAuthCredentialRepoOptions {
  providerIds?: readonly OAuthProviderId[];
  onCorruptOAuthSessionCleared?: (providerIds: readonly OAuthProviderId[]) => Promise<void>;
}

function accessTokenKey(provider: OAuthProviderId): string {
  return `oauth:${provider}:access_token`;
}

function refreshTokenKey(provider: OAuthProviderId): string {
  return `oauth:${provider}:refresh_token`;
}

function userInfoKey(provider: OAuthProviderId): string {
  return `oauth:${provider}:user_info`;
}

function collectKnownOAuthProviderIds(
  providerIds: readonly OAuthProviderId[] = [],
): OAuthProviderId[] {
  const uniqueProviderIds = new Set<OAuthProviderId>(KNOWN_OAUTH_PROVIDER_IDS);
  for (const providerId of providerIds) {
    uniqueProviderIds.add(providerId);
  }
  return [...uniqueProviderIds];
}

function inferBase64ImageMimeType(decoded: Buffer): string {
  if (
    decoded.length >= 8 &&
    decoded[0] === 0x89 &&
    decoded[1] === 0x50 &&
    decoded[2] === 0x4e &&
    decoded[3] === 0x47
  ) {
    return "image/png";
  }

  if (decoded.length >= 3 && decoded[0] === 0xff && decoded[1] === 0xd8 && decoded[2] === 0xff) {
    return "image/jpeg";
  }

  if (decoded.length >= 6 && decoded.toString("ascii", 0, 3) === "GIF") {
    return "image/gif";
  }

  if (
    decoded.length >= 12 &&
    decoded.toString("ascii", 0, 4) === "RIFF" &&
    decoded.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  return "image/png";
}

function toBase64ImageDataUrl(raw: string): string | null {
  const normalized = raw.replace(/\s/g, "");
  if (normalized.length < 16 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    return null;
  }

  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length === 0) {
    return null;
  }

  const encoded = decoded.toString("base64").replace(/=+$/, "");
  if (encoded !== normalized.replace(/=+$/, "")) {
    return null;
  }

  return `data:${inferBase64ImageMimeType(decoded)};base64,${normalized}`;
}

function normalizeStoredZaiAvatarUrl(avatar: string | undefined): string | undefined {
  const trimmed = avatar?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^data:image\/[^;]+;base64,/i.test(trimmed) || /^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  const dataUrl = toBase64ImageDataUrl(trimmed);
  if (dataUrl) {
    return dataUrl;
  }

  return trimmed;
}

function toOAuthUserProfileFromRawZaiUser(raw: Record<string, unknown>): OAuthUserProfile | null {
  const id = typeof raw.user_id === "string" ? raw.user_id : "unknown";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const email = typeof raw.email === "string" ? raw.email : "";
  const username = name || email || id;
  const avatarUrl = normalizeStoredZaiAvatarUrl(
    typeof raw.avatar === "string" ? raw.avatar : undefined,
  );

  if (!name && !email && id === "unknown") {
    return null;
  }

  return {
    id,
    username,
    displayName: username,
    ...(avatarUrl ? { avatarUrl } : {}),
    rawProfile: raw,
  };
}

/** OAuth credential repository: unified provider namespace. */
export class OAuthCredentialRepo {
  private readonly knownProviderIds: OAuthProviderId[];

  constructor(
    private credentialService: ICredentialService,
    options: OAuthCredentialRepoOptions = {},
  ) {
    this.knownProviderIds = collectKnownOAuthProviderIds(options.providerIds);
    this.onCorruptOAuthSessionCleared = options.onCorruptOAuthSessionCleared;
  }

  private readonly onCorruptOAuthSessionCleared?: (
    providerIds: readonly OAuthProviderId[],
  ) => Promise<void>;

  async getActiveProvider(): Promise<OAuthProviderId | null> {
    return this.loadActiveProvider();
  }

  async setActiveProvider(provider: OAuthProviderId | null): Promise<void> {
    await this.saveActiveProvider(provider);
  }

  async loadActiveProvider(): Promise<OAuthProviderId | null> {
    try {
      return await this.credentialService.load(ACTIVE_PROVIDER_KEY);
    } catch (error) {
      if (!isCredentialDecryptError(error)) {
        throw error;
      }

      await this.clearCorruptOAuthSession();
      return null;
    }
  }

  async saveActiveProvider(provider: OAuthProviderId | null): Promise<void> {
    if (!provider) {
      await this.credentialService.delete(ACTIVE_PROVIDER_KEY);
      return;
    }

    // App login restoration uses oauth:* mirrors; active provider is the sole source of truth for mutually exclusive provider domains.
    await this.credentialService.save(ACTIVE_PROVIDER_KEY, provider);
  }

  async loadActiveTokenSet(): Promise<OAuthTokenSet | null> {
    const provider = await this.loadActiveProvider();
    if (!provider) {
      return null;
    }

    const tokenSet = await this.loadTokenSet(provider);
    if (tokenSet) {
      return tokenSet;
    }

    return null;
  }

  async saveActiveTokenSet(tokenSet: OAuthTokenSet): Promise<void> {
    const provider = await this.loadActiveProvider();
    if (!provider) {
      throw new Error("保存当前登录 token 前缺少 active provider");
    }
    await this.saveTokenSet(provider, tokenSet);
  }

  async loadActiveUserProfile(): Promise<OAuthUserProfile | null> {
    const provider = await this.loadActiveProvider();
    if (!provider) {
      return null;
    }

    const profile = await this.loadUserProfile(provider);
    if (profile) {
      return profile;
    }

    return null;
  }

  async saveActiveUserProfile(profile: OAuthUserProfile): Promise<void> {
    const provider = await this.loadActiveProvider();
    if (!provider) {
      throw new Error("保存当前登录 user 前缺少 active provider");
    }
    await this.saveUserProfile(provider, profile);
  }

  async saveLoginAttribution(attribution: OAuthLoginAttribution): Promise<void> {
    const persistAttribution = Object.fromEntries(
      Object.entries(attribution).flatMap(([key, value]) => {
        const trimmed = typeof value === "string" ? value.trim() : "";
        return trimmed ? [[key, trimmed]] : [];
      }),
    );

    if (Object.keys(persistAttribution).length === 0) {
      return;
    }

    await this.credentialService.save(LOGIN_ATTRIBUTION_KEY, JSON.stringify(persistAttribution));
  }

  async loadLoginAttribution(): Promise<OAuthLoginAttribution | null> {
    let raw: string | null;
    try {
      raw = await this.credentialService.load(LOGIN_ATTRIBUTION_KEY);
    } catch (error) {
      if (!isCredentialDecryptError(error)) {
        throw error;
      }
      return null;
    }

    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // Support the { params, expiresAt } structure saved earlier on this branch; after removing TTL, read only params.
      const storedParams =
        parsed.params && typeof parsed.params === "object"
          ? (parsed.params as Record<string, unknown>)
          : parsed;

      const params = Object.fromEntries(
        Object.entries(storedParams).flatMap(([key, value]) =>
          (key === "channel_id" || key === "utm_source" || key === "utm_campaign") &&
          typeof value === "string" &&
          value.trim()
            ? [[key, value.trim()]]
            : [],
        ),
      ) as OAuthLoginAttribution;
      if (Object.keys(params).length === 0) {
        await this.credentialService.delete(LOGIN_ATTRIBUTION_KEY);
        return null;
      }
      return params;
    } catch {
      await this.credentialService.delete(LOGIN_ATTRIBUTION_KEY);
      return null;
    }
  }

  async clearActiveSession(): Promise<void> {
    const activeProvider = await this.loadActiveProvider();
    if (activeProvider) {
      await this.clearProvider(activeProvider);
    }
    await this.credentialService.delete(ACTIVE_PROVIDER_KEY);
  }

  async loadTokenSet(provider: OAuthProviderId): Promise<OAuthTokenSet | null> {
    try {
      const accessToken = await this.credentialService.load(accessTokenKey(provider));
      if (!accessToken) {
        return null;
      }

      const refreshToken = await this.credentialService.load(refreshTokenKey(provider));

      const zcodeJwtToken =
        provider === ZAI_PROVIDER_ID || provider === BIGMODEL_PROVIDER_ID
          ? await this.credentialService.load(ZCODE_JWT_TOKEN_KEY)
          : null;

      return {
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
        ...(zcodeJwtToken ? { zcodeJwtToken } : {}),
      };
    } catch (error) {
      if (!isCredentialDecryptError(error)) {
        throw error;
      }

      await this.clearCorruptOAuthSession();
      return null;
    }
  }

  async loadCachedSessionTokens(
    provider: OAuthProviderId,
  ): Promise<{ key: string; value: string }[] | null> {
    try {
      return await Promise.all(
        [ZCODE_JWT_TOKEN_KEY, accessTokenKey(provider)].map(async (key) => ({
          key,
          value: (await this.credentialService.load(key))?.trim() ?? "",
        })),
      );
    } catch (error) {
      if (!isCredentialDecryptError(error)) throw error;
      // 启动轻量检查曾绕过仓储的解密异常分类，导致业务 token 损坏时恢复直接失败。
      // 复用既有 OAuth 清理边界，不读取 refresh token，也不触发远端资料迁移。
      await this.clearCorruptOAuthSession();
      return null;
    }
  }

  async saveTokenSet(provider: OAuthProviderId, tokenSet: OAuthTokenSet): Promise<void> {
    await this.credentialService.save(accessTokenKey(provider), tokenSet.accessToken);

    if (tokenSet.refreshToken) {
      await this.credentialService.save(refreshTokenKey(provider), tokenSet.refreshToken);
    } else {
      await this.credentialService.delete(refreshTokenKey(provider));
    }

    if (provider === ZAI_PROVIDER_ID || provider === BIGMODEL_PROVIDER_ID) {
      if (tokenSet.zcodeJwtToken) {
        // BigModel Start Plan, like Z.AI Start Plan, consumes the zcode JWT.
        // Persist the JWT with tokenSet during the OAuth callback; later balance/runtime code reads it only,
        // and must not assemble another /oauth/token body from the BigModel access token for an ad hoc exchange.
        await this.credentialService.save(ZCODE_JWT_TOKEN_KEY, tokenSet.zcodeJwtToken);
      } else {
        await this.credentialService.delete(ZCODE_JWT_TOKEN_KEY);
      }
    }
  }

  async loadUserProfile(provider: OAuthProviderId): Promise<OAuthUserProfile | null> {
    return this.loadUserProfileFromKey(userInfoKey(provider), provider);
  }

  private async loadUserProfileFromKey(
    key: string,
    provider?: OAuthProviderId,
  ): Promise<OAuthUserProfile | null> {
    let raw: string | null;
    try {
      raw = await this.credentialService.load(key);
    } catch (error) {
      if (!isCredentialDecryptError(error)) {
        throw error;
      }

      await this.clearCorruptOAuthSession();
      return null;
    }

    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<OAuthUserProfile>;
      if (
        typeof parsed.id === "string" &&
        typeof parsed.username === "string" &&
        typeof parsed.displayName === "string"
      ) {
        const avatarUrl = typeof parsed.avatarUrl === "string" ? parsed.avatarUrl : undefined;
        const rawProfile =
          typeof parsed.rawProfile === "object" && parsed.rawProfile !== null
            ? parsed.rawProfile
            : undefined;
        return {
          id: parsed.id,
          username: parsed.username,
          displayName: parsed.displayName,
          ...(avatarUrl ? { avatarUrl } : {}),
          ...(rawProfile ? { rawProfile } : {}),
        };
      }

      if (provider === ZAI_PROVIDER_ID && typeof parsed === "object" && parsed !== null) {
        // ZAI user_info is now persisted as the backend data.user value;
        // map display fields from user_id/name/avatar again during startup restoration.
        const zaiProfile = toOAuthUserProfileFromRawZaiUser(parsed as Record<string, unknown>);
        if (zaiProfile) {
          return zaiProfile;
        }
      }
    } catch {
      // ignore parse error and fallback to null
    }

    return null;
  }

  async saveUserProfile(provider: OAuthProviderId, profile: OAuthUserProfile): Promise<void> {
    // The ZAI backend's data.user is the source data for later account-state troubleshooting and restoration;
    // storing only normalized display fields previously lost the original email/name/avatar structure.
    const persistProfile =
      provider === ZAI_PROVIDER_ID && profile.rawProfile ? profile.rawProfile : profile;

    await this.credentialService.save(userInfoKey(provider), JSON.stringify(persistProfile));
  }

  async clearUserProfile(provider: OAuthProviderId): Promise<void> {
    await this.credentialService.delete(userInfoKey(provider));
  }

  async clearProvider(provider: OAuthProviderId): Promise<void> {
    await this.credentialService.delete(accessTokenKey(provider));
    await this.credentialService.delete(refreshTokenKey(provider));
    await this.credentialService.delete(userInfoKey(provider));
    if (shouldClearZcodeJwtOnLogout(provider)) {
      await this.credentialService.delete(ZCODE_JWT_TOKEN_KEY);
    }
  }

  async clearAll(providers: OAuthProviderId[]): Promise<void> {
    for (const provider of providers) {
      await this.clearProvider(provider);
    }

    await this.saveActiveProvider(null);
  }

  private async clearCorruptOAuthSession(): Promise<void> {
    // AES-GCM decryption failure means the current runtime can no longer trust the local OAuth login state.
    // Treat it as signing out of registered OAuth providers: clear the provider namespace and shared zcode JWT first,
    // then notify the service layer to clear derived model credentials such as Start/Coding Plan, while avoiding unrelated credentials such as SSH.
    for (const provider of this.knownProviderIds) {
      await this.clearProvider(provider);
    }
    await this.credentialService.delete(ACTIVE_PROVIDER_KEY);
    // Derived cleanup (account refresh, network probes) can hang or reject. It must not sit on the
    // startup restore path, so it runs detached: the caller resolves as signed-out without waiting.
    // The callback is invoked synchronously inside the executor, so a synchronous throw is also caught.
    const onCleared = this.onCorruptOAuthSessionCleared;
    if (!onCleared) {
      return;
    }
    void new Promise<void>((resolve) => {
      resolve(onCleared(this.knownProviderIds));
    }).catch((error: unknown) => {
      // Failure to clear a derived model provider must not block recovery from a corrupted OAuth state.
      // The main OAuth credentials are already deleted, and the user must be able to return to a signed-out state and log in again.
      log.warn(undefined, "clear derived provider keys after corrupt OAuth session failed", error);
    });
  }
}

function shouldClearZcodeJwtOnLogout(provider: OAuthProviderId): boolean {
  return provider === ZAI_PROVIDER_ID || provider === BIGMODEL_PROVIDER_ID;
}
