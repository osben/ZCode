import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * 桌面构建期可选能力的唯一解析入口：ARMS RUM 上报、事件上报、自动更新。
 * 优先级：构建进程环境变量 > config/private/build-defaults.json（仅内部仓库存在）> 关闭。
 * 规则见 docs/desktop/build-time-optional-capabilities.md。
 */
export const PRIVATE_BUILD_DEFAULTS_PATH = resolve(
  import.meta.dirname,
  "../config/private/build-defaults.json",
);

const ENABLED_VALUES = new Set(["1", "true", "yes"]);

async function readPrivateDefaults(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`构建期私有默认配置必须是 JSON 对象：${path}`);
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function pickValue(env, defaults, key) {
  // 环境变量显式设置（包括空字符串）时优先，空字符串表示关闭该项能力
  if (typeof env[key] === "string") return env[key].trim();
  const value = defaults[key];
  return typeof value === "string" ? value.trim() : "";
}

export async function resolveBuildTimeConfig(
  env = process.env,
  { defaultsPath = PRIVATE_BUILD_DEFAULTS_PATH } = {},
) {
  const defaults = await readPrivateDefaults(defaultsPath);
  return {
    armsRumEndpoint: pickValue(env, defaults, "ZCODE_ARMS_RUM_ENDPOINT"),
    telemetryReportEndpoint: pickValue(env, defaults, "ZCODE_TELEMETRY_REPORT_ENDPOINT"),
    autoUpdateEnabled: ENABLED_VALUES.has(
      pickValue(env, defaults, "ZCODE_AUTO_UPDATE").toLowerCase(),
    ),
    ...resolveWebRemoteControlReleaseDefaults({
      relayWsUrl: pickValue(env, defaults, "ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL"),
      webUrl: pickValue(env, defaults, "ZCODE_WEB_REMOTE_CONTROL_URL"),
    }),
    ...identityModeEntry(pickValue(env, defaults, "ZCODE_WEB_REMOTE_CONTROL_RELAY_IDENTITY_MODE")),
  };
}

/**
 * Fork 发布版内建的自托管 remote-control 默认地址（公开部署输入，不是机密）。
 * 规则见 docs/web-remote-control/self-hosted-remote-relay.md：
 * 两项要么同时配置，要么都不配置；只配置一项或协议不符必须让构建明确失败，
 * 而不是让 QR/WS 静默指向另一个运营方。未配置时保持上游外部 relay 行为。
 */
export function resolveWebRemoteControlReleaseDefaults({ relayWsUrl, webUrl }) {
  const relay = (relayWsUrl ?? "").trim();
  const web = (webUrl ?? "").trim();
  if (!relay && !web) {
    return { webRemoteControlRelayWsUrl: "", webRemoteControlUrl: "" };
  }
  if (!relay || !web) {
    throw new Error(
      "Web remote-control release defaults are incomplete: set both " +
        "ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL and ZCODE_WEB_REMOTE_CONTROL_URL, or neither.",
    );
  }
  let relayParsed;
  let webParsed;
  try {
    relayParsed = new URL(relay);
  } catch {
    throw new Error(`Invalid ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL: ${relay}`);
  }
  try {
    webParsed = new URL(web);
  } catch {
    throw new Error(`Invalid ZCODE_WEB_REMOTE_CONTROL_URL: ${web}`);
  }
  if (relayParsed.protocol !== "wss:") {
    throw new Error(
      `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL must use the wss: scheme, got: ${relay}`,
    );
  }
  if (webParsed.protocol !== "https:") {
    throw new Error(`ZCODE_WEB_REMOTE_CONTROL_URL must use the https: scheme, got: ${web}`);
  }
  return { webRemoteControlRelayWsUrl: relay, webRemoteControlUrl: web };
}

/**
 * Fork: baked default for the relay identity mode, so an app launched from Finder/Explorer (no shell env)
 * still talks to a `device-key` relay. Only the mode is baked; the enrollment secret never is.
 */
export function resolveWebRemoteControlIdentityModeDefault(value) {
  const mode = (value ?? "").trim();
  if (mode === "" || mode === "zai-jwt" || mode === "device-key") return mode;
  throw new Error(
    `Invalid ZCODE_WEB_REMOTE_CONTROL_RELAY_IDENTITY_MODE: expected zai-jwt or device-key, got: ${mode}`,
  );
}

// Present only when configured, so builds that do not use device-key keep their config shape unchanged.
function identityModeEntry(value) {
  const mode = resolveWebRemoteControlIdentityModeDefault(value);
  return mode ? { webRemoteControlIdentityMode: mode } : {};
}

export function createBuildTimeConfigDefines(config) {
  return {
    __ZCODE_ARMS_RUM_ENDPOINT__: JSON.stringify(config.armsRumEndpoint),
    __ZCODE_TELEMETRY_REPORT_ENDPOINT__: JSON.stringify(config.telemetryReportEndpoint),
    __ZCODE_AUTO_UPDATE_ENABLED__: JSON.stringify(config.autoUpdateEnabled),
    __ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL__: JSON.stringify(
      config.webRemoteControlRelayWsUrl ?? "",
    ),
    __ZCODE_WEB_REMOTE_CONTROL_URL__: JSON.stringify(config.webRemoteControlUrl ?? ""),
    __ZCODE_WEB_REMOTE_CONTROL_RELAY_IDENTITY_MODE__: JSON.stringify(
      config.webRemoteControlIdentityMode ?? "",
    ),
  };
}
