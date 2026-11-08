import {
  buildForkAgentRuntimeHostEnv,
  getForkAgentRuntimeSelection,
  primeForkAgentRuntimeSelection,
} from "./contract.js";

/** Main primes once before the first Host fork, then every Host spawn reads the same decision. */
export async function exampleForkAgentRuntimeHostEnv(
  readAgentRuntimeSetting: () => Promise<unknown>,
  hostEnv: Record<string, string>,
): Promise<Record<string, string>> {
  await primeForkAgentRuntimeSelection({
    readStoredSetting: readAgentRuntimeSetting,
    logger: { info: () => {}, warn: () => {} },
    isPackaged: false,
  });
  return buildForkAgentRuntimeHostEnv(hostEnv, getForkAgentRuntimeSelection());
}
