import {
  buildRuntimeZCodeEndpointUrls,
  ZCODE_ENV,
  type RuntimeZCodeEndpointEnv,
} from "@zcode/shared";

interface RendererImportMetaEnv {
  VITE_ZCODE_BASE_URL?: string;
  VITE_ZCODE_ENDPOINT_ORIGIN?: string;
}

function readRendererImportMetaEnv(): RendererImportMetaEnv {
  return ((import.meta as ImportMeta & { env?: RendererImportMetaEnv }).env ??
    {}) as RendererImportMetaEnv;
}

function createRendererZCodeEndpointEnv(
  env: RendererImportMetaEnv = readRendererImportMetaEnv(),
): RuntimeZCodeEndpointEnv {
  return {
    ZCODE_ENV,
    // The UI's zcode-plan placeholder provider previously read only ZCODE_ENV
    // and ignored Vite's injected base URL, which could make the renderer differ from the host/service on custom test domains.
    ZCODE_BASE_URL: env.VITE_ZCODE_BASE_URL,
    ZCODE_ENDPOINT_ORIGIN: env.VITE_ZCODE_ENDPOINT_ORIGIN,
  };
}

export const RENDERER_ZCODE_ENDPOINT_URLS = buildRuntimeZCodeEndpointUrls(
  createRendererZCodeEndpointEnv(),
);
