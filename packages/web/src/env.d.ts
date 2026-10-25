declare module "*.css";
declare module "@zcode/ui/styles.css";

interface ImportMetaEnv {
  // This file declares the Vite env shape manually, so the built-in BASE_URL must also be declared explicitly.
  // Otherwise typecheck fails when mobile remote control distinguishes /remote from /remote/v3 by the build base.
  readonly BASE_URL: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly VITE_DEV_ORIGIN?: string;
  readonly VITE_CONVERSATION_SHARE_PREVIEW_MOCK?: string;
  readonly VITE_WEB_REMOTE_ALLOW_DEV_RETURN_TO?: string;
  // For multi-version OSS releases, the asset base includes a version directory and this variable specifies the page route.
  readonly VITE_WEB_REMOTE_CONTROL_ROUTE_PATH?: string;
  readonly VITE_ZCODE_BASE_URL?: string;
  readonly VITE_ZCODE_ENDPOINT_ORIGIN?: string;
  readonly VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
