import {
  ZCODE_AGENT_PROVIDER,
  ZCODE_AGENT_PROVIDER_LABEL,
  type ZCodeProvider,
} from "@zcode/shared";

export const ZCODE_AGENT_PROVIDERS: ZCodeProvider[] = [ZCODE_AGENT_PROVIDER];

export const ZCODE_AGENT_PROVIDER_LABELS: Record<ZCodeProvider, string> = {
  glm: ZCODE_AGENT_PROVIDER_LABEL,
};

export function supportsZCodeSessionFork(provider: ZCodeProvider): boolean {
  void provider;
  // Feature flag: the fork entry point is restored for all ZCode providers; actual operability is
  // still gated by task state, the assistant target, and the running-protection guard, so
  // active/failed branches are never exposed as forkable.
  return true;
}

export function shouldHideZCodeSessionForkAction(provider: ZCodeProvider): boolean {
  return !supportsZCodeSessionFork(provider);
}
