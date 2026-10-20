/** Convert supported Git remote syntaxes into HTTPS repository web URLs. */
export function gitRemoteUrlToWebUrl(rawUrl: string): string | null {
  const trimmedUrl = rawUrl.trim();
  let end = trimmedUrl.length;
  while (end > 0 && trimmedUrl.charCodeAt(end - 1) === 47) end -= 1;
  const value = trimmedUrl.slice(0, end).replace(/\.git$/i, "");
  if (value.length === 0) return null;

  const schemeMatch = value.match(/^(?:https?|ssh|git):\/\/(.+)$/i);
  if (schemeMatch?.[1]) {
    const withoutUser = schemeMatch[1].replace(/^[^/@]+@/, "");
    const pathIndex = withoutUser.indexOf("/");
    if (pathIndex < 0) return null;
    const host = withoutUser.slice(0, pathIndex).split(":")[0] ?? "";
    return buildRepositoryWebUrl(host, withoutUser.slice(pathIndex + 1));
  }

  // A one-letter prefix followed by a colon is a Windows drive path, not an SSH host.
  if (/^[a-z]:/i.test(value)) return null;
  const scpLikeMatch = value.match(/^(?:[^@/:]+@)?([^@/:]+):(.+)$/);
  if (!scpLikeMatch) return null;
  const [, host, path] = scpLikeMatch;
  if (host === undefined || path === undefined) return null;
  return buildRepositoryWebUrl(host, path);
}

function buildRepositoryWebUrl(host: string, rawPath: string): string | null {
  const normalizedHost = host.trim().toLowerCase();
  const webHost = normalizedHost === "ssh.github.com" ? "github.com" : normalizedHost;
  const path = rawPath.replace(/^\/+/, "");
  if (!webHost || !path) return null;
  return `https://${webHost}/${path}`;
}

export interface GitRemoteRepository {
  /** Lowercase host; ssh.github.com is normalized to github.com. */
  host: string;
  owner: string;
  name: string;
}

/**
 * Structured { host, owner, name } for supported remote syntaxes, sharing the web-URL
 * normalization (GHE hosts, SSH over 443, SCP-style URLs). Nested group paths keep the
 * first segment as owner and the last as name.
 */
export function gitRemoteUrlToRepository(rawUrl: string): GitRemoteRepository | null {
  const webUrl = gitRemoteUrlToWebUrl(rawUrl);
  if (!webUrl) return null;
  const withoutScheme = webUrl.slice("https://".length);
  const hostEnd = withoutScheme.indexOf("/");
  if (hostEnd <= 0) return null;
  const host = withoutScheme.slice(0, hostEnd);
  const segments = withoutScheme
    .slice(hostEnd + 1)
    .split("/")
    .filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;
  return { host, owner: segments[0] ?? "", name: segments[segments.length - 1] ?? "" };
}
