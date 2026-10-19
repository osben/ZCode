import { incognitoExcludes, type IncognitoProfile } from "@zcode/shared";

/** Prompt-text toggles that are off for one session (specs/incognito-session.md, "Prompt toggles"). */
export interface IncognitoPromptToggles {
  identityOff: boolean;
  harnessOff: boolean;
  environmentOff: boolean;
}

/** Shared by the main and subagent context builders so both read the same three toggles. */
export function resolveIncognitoPromptToggles(
  profile: IncognitoProfile | undefined,
): IncognitoPromptToggles {
  return {
    identityOff: incognitoExcludes(profile, "identity"),
    harnessOff: incognitoExcludes(profile, "harness"),
    environmentOff: incognitoExcludes(profile, "environment"),
  };
}
