import { app } from "electron";
import { join } from "node:path";
import { ZCODE_ENV } from "@zcode/shared";

export function resolveZCodeBuiltinProviderConfigFilePath(options?: {
  readonly appPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isPackaged?: boolean;
  readonly resourcesPath?: string;
}): string {
  const explicitPath = (options?.env ?? process.env)["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"]?.trim();
  if (explicitPath) return explicitPath;
  if (options?.isPackaged ?? app.isPackaged) {
    return join(
      options?.resourcesPath ?? process.resourcesPath,
      "config/provider/zcode-builtin.json",
    );
  }
  // Development has no resources-copy step and must read the same source file as the production
  // environment injected by the build.
  const filename = ZCODE_ENV === "production" ? "zcode-builtin.json" : "zcode-builtin.test.json";
  return join(options?.appPath ?? app.getAppPath(), "../../config/provider", filename);
}
