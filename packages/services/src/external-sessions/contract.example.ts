/**
 * Usage example for the external-sessions contract (architecture-governance managed module).
 * Not imported by runtime code.
 */
import type { IExternalSessionsService } from "#src/external-sessions/contract.js";

export async function exampleListClaudeSessions(
  service: IExternalSessionsService,
  workspacePath: string,
): Promise<string[]> {
  const result = await service.listExternalSessions({ workspacePath, sources: ["claude"] });
  return result.sessions.map((session) => session.title);
}
