import type { IncognitoProfile } from "@zcode/shared";
import type { ZCodeAppOptions } from "@zcode/bootstrap";
import type { CliEnv } from "./env.js";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import type { CliResumeRequest, RunDependencies } from "./cli-types.js";

export interface ResolvedResumeSession {
  sessionId: NonNullable<ZCodeAppOptions["sessionId"]>;
  /**
   * Frozen incognito profile of the resumed session (root specs/incognito-session.md).
   * createZCodeApp composes plugins/MCP/hooks/agents before core resume runs, so the profile
   * must ride along here or an incognito session resumes fail-open as a normal one.
   */
  incognito?: IncognitoProfile;
}

export const resolveResumeSession = async (
  request: CliResumeRequest,
  workingDirectory: string,
  env: CliEnv,
  deps: RunDependencies,
): Promise<ResolvedResumeSession | undefined> => {
  if (request.resumeSessionId) {
    const readPersistedIncognitoProfile =
      deps.readPersistedIncognitoProfile ??
      (await loadBootstrapModule()).readPersistedIncognitoProfile;
    const incognito = await readPersistedIncognitoProfile({
      sessionId: request.resumeSessionId,
      env,
    });
    return {
      sessionId: request.resumeSessionId as ResolvedResumeSession["sessionId"],
      ...(incognito ? { incognito } : {}),
    };
  }

  if (!request.continueSession) {
    return undefined;
  }

  const resolveLatest =
    deps.resolveLatestSession ?? (await loadBootstrapModule()).resolveLatestSession;
  const latest = await resolveLatest({
    directory: workingDirectory,
    env,
  });
  if (!latest) {
    throw new Error(`No resumable session found for ${workingDirectory}`);
  }
  return {
    sessionId: latest.id as ResolvedResumeSession["sessionId"],
    ...(latest.incognito ? { incognito: latest.incognito } : {}),
  };
};
