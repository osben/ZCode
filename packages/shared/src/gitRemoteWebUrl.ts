/** Convert supported Git remote syntaxes into HTTPS repository web URLs. */
export function gitRemoteUrlToWebUrl(rawUrl: string): string | null {
  const value = rawUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  if (value.length === 0) return null;

  const scpLikeMatch = value.match(/^[^@/]+@([^:/]+):(.+)$/);
  if (scpLikeMatch) {
    const [, host, path] = scpLikeMatch;
    if (host === undefined || path === undefined) return null;
    return buildRepositoryWebUrl(host, path);
  }

  const schemeMatch = value.match(/^(?:https?|ssh|git):\/\/(.+)$/i);
  if (!schemeMatch?.[1]) return null;
  const withoutUser = schemeMatch[1].replace(/^[^/@]+@/, "");
  const pathIndex = withoutUser.indexOf("/");
  if (pathIndex < 0) return null;
  const host = withoutUser.slice(0, pathIndex).split(":")[0] ?? "";
  return buildRepositoryWebUrl(host, withoutUser.slice(pathIndex + 1));
}

function buildRepositoryWebUrl(host: string, rawPath: string): string | null {
  const normalizedHost = host.trim().toLowerCase();
  const path = rawPath.replace(/^\/+/, "");
  if (!normalizedHost || !path) return null;
  return `https://${normalizedHost}/${path}`;
}
