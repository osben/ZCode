import {
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  ZCODE_VERSION,
  buildZCodeEndpointUrls,
  getForceUpdateMinimalVersionFromConfig,
  resolveForceUpdateRequirement,
  type ForceUpdateRequirement,
  type Locale,
} from "@zcode/shared";
import { requestForceAutoUpdate, type ForceAutoUpdateState } from "./autoUpdater.js";
import { showForceUpdatePrompt } from "./forceUpdatePrompt.js";

const ZCODE_CLIENT_CONFIG_API_PATH = "/api/v1/client/configs";
const FORCE_UPDATE_CONFIG_REQUEST_TIMEOUT_MS = 10_000;
const FORCE_UPDATE_CONFIG_MAX_RESPONSE_BYTES = 1024 * 1024;

export interface ForceUpdateDialogText {
  title: string;
  message: string;
  detail: string;
  autoUpdateButton: string;
  manualUpdateButton: string;
  quitButton: string;
}

export interface ForceUpdateGuardLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface ForceUpdateGuardResult {
  blocked: boolean;
  requirement?: ForceUpdateRequirement;
}

export interface ForceUpdateGuardOptions {
  locale: Locale;
  logger: ForceUpdateGuardLogger;
  endpointOrigin?: string;
  fetchRemoteConfig?: () => Promise<unknown>;
  requestAutoUpdate?: (
    onStateChange?: (state: ForceAutoUpdateState) => void,
  ) => (() => void) | void;
  onBlocked?: (requirement: ForceUpdateRequirement) => void;
}

export function resolveForceUpdateClientConfigUrl(
  endpointOrigin = DEFAULT_ZCODE_ENDPOINT_ORIGIN,
): string {
  const url = new URL(
    `${buildZCodeEndpointUrls(endpointOrigin).origin}${ZCODE_CLIENT_CONFIG_API_PATH}`,
  );
  url.searchParams.set("app_version", ZCODE_VERSION);
  url.searchParams.set("platform", `${process.platform}-${process.arch}`);
  return url.toString();
}

function getForceUpdateMinimalVersionFromClientConfig(config: unknown): string | undefined {
  if (typeof config !== "object" || config === null) {
    return undefined;
  }

  const envelope = config as {
    code?: unknown;
    data?: {
      configs?: unknown;
    };
  };
  if (typeof envelope.code === "number" && envelope.code !== 0) {
    // As in the service layer, trust /client/configs only when code=0 so an error envelope with stale data cannot trigger a forced update at startup.
    throw new Error(`ZCode client config failed: ${envelope.code}`);
  }
  return getForceUpdateMinimalVersionFromConfig(envelope.data?.configs);
}

async function fetchRemoteForceUpdateConfig(
  endpointOrigin?: string,
  fetchRemoteConfig?: () => Promise<unknown>,
): Promise<unknown> {
  if (fetchRemoteConfig) {
    return fetchRemoteConfig();
  }

  const { net } = await import("electron");
  return new Promise<unknown>((resolve, reject) => {
    let request: ReturnType<typeof net.request>;
    let timer: ReturnType<typeof setTimeout>;
    let data = "";
    let receivedBytes = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      request?.abort();
      reject(error);
    };

    const finish = (value: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    timer = setTimeout(() => {
      fail(new Error("force update config request timeout"));
    }, FORCE_UPDATE_CONFIG_REQUEST_TIMEOUT_MS);
    timer.unref?.();

    request = net.request(resolveForceUpdateClientConfigUrl(endpointOrigin));
    request.on("response", (response) => {
      const statusCode = response.statusCode ?? 0;
      if (statusCode < 200 || statusCode >= 300) {
        // The pre-start forced-update gate must not parse 4xx/5xx/HTML error pages as valid config; use the offline fallback path for all of them.
        fail(new Error(`force update config request failed with status ${statusCode}`));
        return;
      }

      response.on("data", (chunk) => {
        receivedBytes += Buffer.byteLength(chunk);
        if (receivedBytes > FORCE_UPDATE_CONFIG_MAX_RESPONSE_BYTES) {
          // Remote config is read before the main window is created; cap the response body so an abnormal response cannot exhaust main-process memory.
          fail(new Error("force update config response too large"));
          return;
        }
        data += chunk.toString();
      });
      response.on("end", () => {
        try {
          finish(JSON.parse(data));
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      response.on("error", (error) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      });
    });
    request.on("error", (error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
    request.end();
  });
}

export async function resolveDesktopForceUpdateRequirement(options: {
  logger: ForceUpdateGuardLogger;
  endpointOrigin?: string;
  fetchRemoteConfig?: () => Promise<unknown>;
}): Promise<ForceUpdateRequirement | null> {
  const resolveFromConfig = (config: unknown) =>
    resolveForceUpdateRequirement({
      currentVersion: ZCODE_VERSION,
      forceUpdate: {
        minimalVersion:
          getForceUpdateMinimalVersionFromClientConfig(config) ??
          getForceUpdateMinimalVersionFromConfig(config) ??
          "",
      },
    });

  try {
    const remoteConfig = await fetchRemoteForceUpdateConfig(
      options.endpointOrigin,
      options.fetchRemoteConfig,
    );
    const remoteRequirement = resolveFromConfig(remoteConfig);
    if (remoteRequirement) {
      return remoteRequirement;
    }
  } catch (error) {
    // Reserved for offline bypass: do not block startup when fully offline; an explicit offline-bypass policy can be added here later.
    options.logger.warn("[force-update] 读取远端强制升级配置失败，跳过强制升级校验", { error });
    return null;
  }

  return null;
}

export function resolveForceUpdateDownloadUrl(
  locale: Locale,
  endpointOrigin = DEFAULT_ZCODE_ENDPOINT_ORIGIN,
): string {
  const origin = buildZCodeEndpointUrls(endpointOrigin).origin;
  return locale === "zh-CN" ? `${origin}/cn` : `${origin}/en`;
}

export function formatForceUpdateDialogText(
  requirement: ForceUpdateRequirement,
  locale: Locale,
): ForceUpdateDialogText {
  if (locale === "zh-CN") {
    return {
      title: "需要升级 ZCode",
      message: "当前版本无法继续使用",
      detail: `当前版本：v${requirement.currentVersion}\n最低可用版本：v${requirement.minimalVersion}`,
      autoUpdateButton: "自动升级",
      manualUpdateButton: "手动升级",
      quitButton: "退出",
    };
  }

  if (locale === "uk-UA") {
    return {
      title: "Оновіть ZCode",
      message: "Цією версією більше не можна користуватися",
      detail: `Поточна версія: v${requirement.currentVersion}\nМінімальна підтримувана версія: v${requirement.minimalVersion}`,
      autoUpdateButton: "Оновити автоматично",
      manualUpdateButton: "Оновити вручну",
      quitButton: "Вийти",
    };
  }

  return {
    title: "Update ZCode",
    message: "The current version can no longer be used",
    detail: `Current version: v${requirement.currentVersion}\nMinimum supported version: v${requirement.minimalVersion}`,
    autoUpdateButton: "Auto update",
    manualUpdateButton: "Manual update",
    quitButton: "Quit",
  };
}

export async function maybeBlockStartupForForceUpdate(
  options: ForceUpdateGuardOptions,
): Promise<ForceUpdateGuardResult> {
  const requirement = await resolveDesktopForceUpdateRequirement({
    ...options,
    endpointOrigin: options.endpointOrigin,
  });
  if (!requirement) {
    return { blocked: false };
  }

  options.logger.warn("[force-update] 远端配置要求强制升级，阻止创建主窗口", requirement);
  options.onBlocked?.(requirement);
  const { app, shell } = await import("electron");
  const action = await showForceUpdatePrompt(
    formatForceUpdateDialogText(requirement, options.locale),
    options.locale,
    options.logger,
    {
      startAutoUpdate: (onStateChange) =>
        options.requestAutoUpdate?.(onStateChange) ??
        requestForceAutoUpdate(onStateChange, "force-update", requirement.minimalVersion),
    },
  );
  if (action === "auto") {
    return { blocked: true, requirement };
  }

  if (action === "manual") {
    const url = resolveForceUpdateDownloadUrl(options.locale, options.endpointOrigin);
    options.logger.info(`[force-update] 用户选择手动升级：${url}`);
    await shell.openExternal(url);
  }

  // If a forced update applies, do not enter the main UI; after handling the dialog, exit on non-automatic-update paths to avoid exposing old client features.
  app.quit();
  return { blocked: true, requirement };
}
