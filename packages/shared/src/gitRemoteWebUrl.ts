/** Convert supported Git remote syntaxes into HTTPS repository web URLs. */
export function gitRemoteUrlToWebUrl(rawUrl: string): string | null {
  const trimmedUrl = rawUrl.trim();
  let end = trimmedUrl.length;
  while (end > 0 && trimmedUrl.charCodeAt(end - 1) === 47) end -= 1;
  const value = trimmedUrl.slice(0, end).replace(/\.git$/i, "");
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
  const webHost = normalizedHost === "ssh.github.com" ? "github.com" : normalizedHost;
  const path = rawPath.replace(/^\/+/, "");
  if (!webHost || !path) return null;
  return `https://${webHost}/${path}`;
}
