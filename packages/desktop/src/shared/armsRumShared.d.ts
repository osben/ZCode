import { type ZCodeRuntimeEnv } from "@zcode/shared";
/** browserCollectors from main-process initialization, injected into renderer's RumSDK.init(collectors) through autoInject. */
export declare const ARMS_BROWSER_COLLECTORS: {
  readonly perf: true;
  readonly webvitals: true;
  readonly exception: true;
  readonly whiteScreen: true;
  readonly api: true;
  readonly staticResource: true;
  readonly click: true;
  readonly longTask: true;
};
/** Resolve ARMS page names with the same file:// and dev-server rules in main and renderer. */
export declare function parseArmsViewName(url: string): string;
/** Renderer Browser SDK initialization config, aligned with the main-process endpoint/environment/version. */
export declare function buildArmsBrowserInitConfig(runtimeEnv: ZCodeRuntimeEnv): {
  enable: boolean;
  version: string;
  endpoint: string;
  env: import("@zcode/shared").ArmsRumEnv;
  sessionConfig: {
    sampleRate: number;
  };
  spaMode: false;
  parseViewName: typeof parseArmsViewName;
  collectors: {
    perf: true;
    webvitals: true;
    exception: true;
    whiteScreen: true;
    api: true;
    staticResource: true;
    click: true;
    longTask: true;
  };
};
//# sourceMappingURL=armsRumShared.d.ts.map
