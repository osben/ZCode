// specs/incognito-session.md scenario 21: resuming an incognito session in the CLI (TUI or
// headless) must re-apply the persisted profile before createZCodeApp composes capabilities.
import assert from "node:assert/strict";
import test from "node:test";
import type { SessionInfo } from "@zcode/contracts";
import { INCOGNITO_LOCKDOWN_PROFILE } from "@zcode/shared";
import { createTuiSubmitPrompt } from "../src/tui-prompt-handler.js";
import { resolveResumeSession } from "../src/resume.js";
import type { RunDependencies } from "../src/run.js";

const PROFILE = { ...INCOGNITO_LOCKDOWN_PROFILE, memory: true };
const WORKSPACE = "/workspace/incognito-resume";

test("resolveResumeSession returns the persisted profile with the session id", async () => {
  const deps = {
    readPersistedIncognitoProfile: async () => PROFILE,
    resolveLatestSession: async () =>
      ({ id: "session-latest", incognito: PROFILE }) as SessionInfo,
  } as RunDependencies;

  const explicit = await resolveResumeSession(
    { continueSession: false, resumeSessionId: "session-explicit" },
    WORKSPACE,
    {},
    deps,
  );
  assert.deepEqual(explicit, { sessionId: "session-explicit", incognito: PROFILE });

  const continued = await resolveResumeSession({ continueSession: true }, WORKSPACE, {}, deps);
  assert.deepEqual(continued, { sessionId: "session-latest", incognito: PROFILE });
});

test("resolveResumeSession omits the profile for normal sessions", async () => {
  const deps = {
    readPersistedIncognitoProfile: async () => undefined,
    resolveLatestSession: async () => ({ id: "session-normal" }) as SessionInfo,
  } as RunDependencies;

  assert.deepEqual(
    await resolveResumeSession(
      { continueSession: false, resumeSessionId: "session-normal-explicit" },
      WORKSPACE,
      {},
      deps,
    ),
    { sessionId: "session-normal-explicit" },
  );
  assert.deepEqual(
    await resolveResumeSession({ continueSession: true }, WORKSPACE, {}, deps),
    { sessionId: "session-normal" },
  );
});

test("TUI resume forwards the persisted profile into createZCodeApp runtimeConfig", async () => {
  const createZCodeAppCalls: unknown[] = [];
  const deps: RunDependencies = {
    createModelAdapter: () => ({}) as never,
    createZCodeApp: async (options) => {
      createZCodeAppCalls.push(options);
      return {
        close: async () => {},
        getModel: () => "openai/gpt-test",
        listModels: () => [{ label: "test", ref: { providerId: "openai", modelId: "gpt-test" } }],
        runtime: {} as never,
      } as never;
    },
    loadDotenv: () => ({ keys: [], loaded: false }),
    readPersistedIncognitoProfile: async () => PROFILE,
    skipUserConfig: true,
    startProcessProviderRegistryRuntime: async () =>
      ({ dispose: () => {}, runtime: { registryService: {} } }) as never,
  };

  const handler = createTuiSubmitPrompt(
    deps,
    {},
    "test",
    { continueSession: false, resumeSessionId: "session-incognito" },
  );
  await handler.getSessionMetadata!();

  assert.equal(createZCodeAppCalls.length, 1);
  const runtimeConfig = (createZCodeAppCalls[0] as { runtimeConfig?: { incognito?: unknown } })
    .runtimeConfig;
  assert.deepEqual(runtimeConfig?.incognito, PROFILE);
});
