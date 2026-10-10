import { resolveZCodeRuntimeEnv } from "@zcode/shared";

type EffectiveNodeEnv = "development" | "production";

function resolveEffectiveNodeEnv(
  env: Record<string, string | undefined> = process.env,
): EffectiveNodeEnv {
  const runtimeEnv = resolveZCodeRuntimeEnv(env);
  // NODE_ENV is a shared variable used by user shells and the Node ecosystem, so it cannot determine the ZCode runtime mode.
  // Only honor ZCODE_RUNTIME_ENV explicitly injected by the app or CLI, preventing NODE_ENV from Bash or a login shell from leaking into
  // the host/agent runtime. Treat the test runtime as normal mode and do not enable development debug logging.
  return runtimeEnv === "development" ? "development" : "production";
}

export function isEffectiveDevelopmentNodeEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return resolveEffectiveNodeEnv(env) === "development";
}
