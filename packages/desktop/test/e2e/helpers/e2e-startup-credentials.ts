import { isRequestSecuritySpec } from "./request-security-edition/index.js";
export interface E2EStartupCredentialSeedOptions {
  specs?: string[];
  legacyAuthToken: string;
  restoredOAuthCredentials: Record<string, string>;
}

const PERSONAL_PROVIDER_ONLY_SPEC_NAMES = new Set([
  "conversation-session-composer-draft-switching.test.ts",
  "conversation-session-draft-model-switch-first-send.test.ts",
  "conversation-session-unbound-resume.test.ts",
  "conversation-session-v4-composer-toolbar.test.ts",
  // The SSH config sync cases only need the Personal config; the fake OAuth 401 would cover the wizard entry before connecting.
  "conversation-session-ssh-provisioning-failure.test.ts",
]);

// These fork/goal/tool scenarios also use only the local replay Provider; fake OAuth triggers real
// control-plane auth failures that cover the tested interaction, so like the Personal-only scenarios they start accountless.
const ACCOUNTLESS_FORK_SPEC_NAMES = new Set([
  "conversation-session-automation-cron-create.test.ts",
  "conversation-session-worktree-chat-first.test.ts",
  "conversation-session-fork-merged-assistant.test.ts",
  "conversation-session-goal-run-cases.test.ts",
  // The guide layout regression only depends on the local replay Provider; the fake account would show a login-expired prompt covering the career guide.
  "conversation-session-running-guide-steer.test.ts",
  "conversation-session-tool-cross-product.test.ts",
  "conversation-session-v4-fork-edit-branch.test.ts",
  // Bug cause: the fake OAuth/legacy token makes the plugin market hit the real account control
  // plane (401 login-expired dialog) before the plugin replay starts, so these start accountless.
  "plugin-management-discovery-presentation.test.ts",
  "plugin-management-ui-market.test.ts",
  "conversation-session-plugin-marketplace-installed-roundtrip.test.ts",
  "plugin-store-auto-refresh-throttled.test.ts",
  "plugin-store-auto-refresh-on-enter.test.ts",
]);

export function createE2EStartupCredentialSeed(
  options: E2EStartupCredentialSeedOptions,
): Record<string, string> {
  if (
    options.specs?.some((spec) => {
      const fileName = spec.replaceAll("\\", "/").split("/").at(-1);
      return (
        fileName !== undefined &&
        (PERSONAL_PROVIDER_ONLY_SPEC_NAMES.has(fileName) ||
          ACCOUNTLESS_FORK_SPEC_NAMES.has(fileName))
      );
    })
  ) {
    // Bug cause: these cases only verify the Personal Provider session/Composer behaviour; the default
    // fake JWT would hit the real account control plane and trigger a 401 popup covering the interaction under test.
    // They start from the accountless state and then set up preconditions through the formal API Key/Personal Provider UI.
    return {};
  }
  const restoredOAuthCredentials = { ...options.restoredOAuthCredentials };
  const requiresZCodeJwt = options.specs?.some((spec) => {
    const fileName = spec.replaceAll("\\", "/").split("/").at(-1);
    return (
      // The marketing delivery specs are split by topic into marketing-touch-delivery*.test.ts; the claim cases all need a local JWT.
      fileName?.startsWith("marketing-touch-delivery") ||
      fileName === "marketing-touch-entitlement.test.ts" ||
      // The Rewards suite goes through the local control plane and must verify both OAuth and JWT injection.
      fileName === "marketing-touch-rewards.test.ts" ||
      fileName === "jwt-401-auto-logout.test.ts" ||
      isRequestSecuritySpec(fileName) ||
      fileName === "coding-plan-upgrade-webview-refresh-provider.test.ts" ||
      fileName === "start-plan-manual-claim-experience.test.ts" ||
      fileName === "provider-family-responsive.test.ts" ||
      // The Team regression only replaces HTTP and still goes through real credential resolution; a missing JWT is rejected before creation.
      fileName === "conversation-session-off-peak-team-plan.test.ts"
    );
  });
  // The merge had dropped JWT isolation for regular E2E: a fake JWT would hit the real plan API and show a login-expired prompt.
  // Keep the OAuth display state; only auth-specific suites, local-mock claim and responsive cases need a JWT.
  if (!requiresZCodeJwt) delete restoredOAuthCredentials.zcodejwttoken;
  // Zai restore without a zcodejwttoken is already signed-out, so the seeded fake zai OAuth adds
  // no visible state; it only sends "oauth:zai:access_token" to the real control plane
  // (getCustomerInfo / enterprise pricing), whose 401 triggers the conditional logout and the
  // blocking "Your session has expired" dialog. Drop the zai identity for generic specs; the
  // accountless login fallback in the conversation shell helpers builds the real API-key state.
  // BigModel specs keep their own identity (restore works without a JWT and their workers mock
  // the bigmodel business endpoints), and the JWT-special specs above keep theirs by design.
  if (!requiresZCodeJwt) {
    const seedsBigModelIdentity = Boolean(restoredOAuthCredentials["oauth:bigmodel:access_token"]);
    delete restoredOAuthCredentials["oauth:zai:access_token"];
    delete restoredOAuthCredentials["oauth:zai:user_info"];
    delete restoredOAuthCredentials.zcodejwttoken;
    // BigModel workers keep their own active provider; generic workers had only the zai identity.
    if (!seedsBigModelIdentity) {
      delete restoredOAuthCredentials["oauth:active_provider"];
    }
  }
  return {
    auth_token: options.legacyAuthToken,
    ...restoredOAuthCredentials,
  };
}
