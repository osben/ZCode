import { validateServerInstallOwnership } from "../runtime/installationOwnership.js";
import { resolveServerLayout } from "../runtime/paths.js";

/**
 * Read the installation-level Server identity. A real Supervisor startup must provide the server root; when it is omitted,
 * preserve compatibility with embedded/HTTP-factory tests and let the caller decide whether to use a hostname fallback.
 */
export async function resolveCoreServerId(
  serverRoot = process.env.ZCODE_SERVER_ROOT?.trim(),
): Promise<string | undefined> {
  if (!serverRoot) return undefined;
  const ownership = await validateServerInstallOwnership(resolveServerLayout(serverRoot));
  return ownership.installationId;
}
