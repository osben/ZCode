import { materializeZCodeBuiltinProviderConfig } from "@zcode/services/node";

declare const __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: string | undefined;

interface MaterializeBundledZCodeBuiltinProviderConfigOptions {
  readonly environmentConfigRoot: string;
  readonly content: string;
}

/** Return the ZCode Built-in Provider Config embedded in the remote Server at build time. */
export function readBundledZCodeBuiltinProviderConfig(): string {
  if (typeof __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__ !== "string") {
    throw new Error("当前构建未嵌入 ZCode Built-in Provider Config");
  }
  return __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__;
}

/**
 * Atomically materialize the ZCode Built-in Config to a fixed resource copy in its owning environment.
 * Exit the old process before upgrade; do not retain historical files that grow by content hash.
 */
export async function materializeBundledZCodeBuiltinProviderConfig(
  options: MaterializeBundledZCodeBuiltinProviderConfigOptions,
): Promise<string> {
  return materializeZCodeBuiltinProviderConfig(options);
}
