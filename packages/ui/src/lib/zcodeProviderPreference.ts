import {
  normalizeAgentProviderToZCodeAgent,
  ZCODE_AGENT_PROVIDER,
  type ZCodeProvider,
} from "@zcode/shared";
import { ZCODE_AGENT_PROVIDERS } from "./zcodeProviders.js";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const LAST_SELECTED_AGENT_PROVIDER_STORAGE_KEY = "zcode-last-agent-provider";

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isAgentProvider(value: unknown): value is ZCodeProvider {
  return typeof value === "string" && ZCODE_AGENT_PROVIDERS.includes(value as ZCodeProvider);
}

export function readLastSelectedAgentProvider(
  storage: StorageLike | null = getBrowserStorage(),
): ZCodeProvider | null {
  const rawValue = storage?.getItem(LAST_SELECTED_AGENT_PROVIDER_STORAGE_KEY);
  if (!isAgentProvider(rawValue)) {
    return ZCODE_AGENT_PROVIDER;
  }

  // Bugfix: after the single ZCode Agent migration, third-party provider values removed from the
  // old local storage must no longer take part in first-screen warm-up. Otherwise the UI briefly
  // prepares/creates against the old provider as its source of truth, racing the agent server's
  // glm state.
  return normalizeAgentProviderToZCodeAgent(rawValue);
}

export function persistLastSelectedAgentProvider(
  provider: ZCodeProvider,
  storage: StorageLike | null = getBrowserStorage(),
) {
  // Bugfix: after migrating to the single ZCode Agent, the old local storage may still hold a
  // removed third-party provider. Reading it as-is would briefly send draft warm-up and the first
  // createTask down the wrong provider at the UI layer; converge uniformly to glm here.
  storage?.setItem(
    LAST_SELECTED_AGENT_PROVIDER_STORAGE_KEY,
    normalizeAgentProviderToZCodeAgent(provider),
  );
}
