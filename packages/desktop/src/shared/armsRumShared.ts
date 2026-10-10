import {
  mapZCodeEnvToArmsRumEnv,
  type ZCodeRuntimeEnv,
  ZCODE_ARMS_RUM_ENDPOINT,
  ZCODE_VERSION,
} from "@zcode/shared";

/** browserCollectors from main-process initialization, injected into renderer's RumSDK.init(collectors) through autoInject. */
export const ARMS_BROWSER_COLLECTORS = {
  perf: true,
  webvitals: true,
  exception: true,
  whiteScreen: true,
  api: true,
  staticResource: true,
  // Enable click collection for user behavior. Desktop interaction is dense, so report volume and noise
  // will increase; monitor ARMS usage.
  click: true,
  longTask: true,
} as const;

/** Resolve ARMS page names with the same file:// and dev-server rules in main and renderer. */
export function parseArmsViewName(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") {
      const fileName = parsed.pathname.split("/").pop() ?? "index.html";
      return fileName.replace(/\.html$/i, "") || "index";
    }
    const path = parsed.pathname || "/";
    return path.length > 120 ? `${path.slice(0, 120)}…` : path;
  } catch {
    return url.length > 120 ? `${url.slice(0, 120)}…` : url;
  }
}

/** Renderer Browser SDK initialization config, aligned with the main-process endpoint/environment/version. */
export function buildArmsBrowserInitConfig(runtimeEnv: ZCodeRuntimeEnv) {
  return {
    enable: true,
    version: ZCODE_VERSION,
    endpoint: ZCODE_ARMS_RUM_ENDPOINT,
    env: mapZCodeEnvToArmsRumEnv(runtimeEnv),
    sessionConfig: {
      sampleRate: 1,
    },
    spaMode: false as const,
    parseViewName: parseArmsViewName,
    collectors: { ...ARMS_BROWSER_COLLECTORS },
  };
}
