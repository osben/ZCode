// Unified parser for remote workspace identities (Workspace Identity constraint: both construction and parsing
// must use this shared utility; business code must not assemble or split the format itself).
// Construction counterpart: buildRemoteWorkspaceIdentity in packages/ui/src/lib/remoteWorkspaceHistory.ts.
// Format contract:
//   remote:ssh:<host>:<port>:<username>:<posixPath>
//   remote:wsl:<distro>[:<user>]:<posixPath>
//   remote:docker:<container>:<posixPath>
// The path segment is normalized by normalizeWorkspacePathForIdentity (separators become "/", trailing
// slashes are removed, and an empty path becomes "/"), so it always starts with "/". Authority segments
// contain no "/" (hosts are lowercase, ports numeric, and valid Docker container / WSL distribution names
// contain neither ":" nor "/").
// Consumer: CLI v4 createSession receives workspaceId (workspaceKey = identity in a remote pane) and must
// recover the real workspacePath for the session workingDirectory.
import type { RemoteTarget } from "./remoteTarget.js";

export type RemoteWorkspaceIdentityKind = "ssh" | "wsl" | "docker" | "server";

export interface ParsedRemoteWorkspaceIdentity {
  kind: RemoteWorkspaceIdentityKind;
  /** kind=server 时的稳定 Source Server id。 */
  sourceServerId?: string;
  /** 远端真实路径（posix 归一形态）。 */
  workspacePath: string;
}

const REMOTE_IDENTITY_PREFIX = "remote:";

/** Required authority segments (excluding kind): ssh = host/port/username; all other remote types = one segment. */
const AUTHORITY_SEGMENTS: Record<RemoteWorkspaceIdentityKind, number> = {
  ssh: 3,
  wsl: 1,
  docker: 1,
  server: 1,
};

function isRemoteWorkspaceIdentityKind(value: string): value is RemoteWorkspaceIdentityKind {
  return value === "ssh" || value === "wsl" || value === "docker" || value === "server";
}

function normalizeWorkspacePathForIdentity(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, "/").replace(/\/+/g, "/");
  const trimmed = normalized.replace(/^\/+|\/+$/g, "");
  return `/${trimmed}`;
}

function resolveServerIdentityId(target: Extract<RemoteTarget, { kind: "server" }>): string {
  const explicit = target.serverId?.trim() || target.name?.trim();
  if (explicit) {
    return explicit;
  }
  try {
    return new URL(target.url.trim()).host;
  } catch {
    return target.url.trim();
  }
}

function normalizeServerIdForIdentity(serverId: string): string {
  const normalized = serverId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    throw new Error("serverId must contain at least one identity-safe character");
  }
  return normalized;
}

export interface BuildServerRemoteWorkspaceIdentityOptions {
  serverId: string;
  workspacePath: string;
}

export function buildServerRemoteWorkspaceIdentity(
  options: BuildServerRemoteWorkspaceIdentityOptions,
): string {
  const serverId = normalizeServerIdForIdentity(options.serverId);
  const workspacePath = normalizeWorkspacePathForIdentity(options.workspacePath);
  return `${REMOTE_IDENTITY_PREFIX}server:${serverId}:${workspacePath}`;
}

/**
 * Construct a remote workspace identity in one place. Host, Main, and UI must not assemble authority themselves.
 * `workspacePath` is normalized here only for the identity key; actual I/O continues to use the caller's original path.
 */
export function buildRemoteWorkspaceIdentity(workspacePath: string, target: RemoteTarget): string {
  const normalizedPath = normalizeWorkspacePathForIdentity(workspacePath);
  switch (target.kind) {
    case "ssh":
      return `remote:ssh:${target.host.trim().toLowerCase()}:${target.port ?? 22}:${target.username.trim()}:${normalizedPath}`;
    case "wsl": {
      const distro = target.distro?.trim() || "default";
      const user = target.user?.trim();
      return user
        ? `remote:wsl:${distro}:${user}:${normalizedPath}`
        : `remote:wsl:${distro}:${normalizedPath}`;
    }
    case "docker":
      return `remote:docker:${target.container}:${normalizedPath}`;
    case "server":
      return buildServerRemoteWorkspaceIdentity({
        serverId: resolveServerIdentityId(target),
        workspacePath: normalizedPath,
      });
  }
}

/**
 * Parse a remote workspace identity; return null for invalid or non-remote identities (the caller falls back
 * to handling it as a local workspacePath). Extract only workspacePath; authority details (host/port, etc.)
 * are irrelevant to consumers because the CLI runs on the remote machine, so do not expose them.
 */
export function parseRemoteWorkspaceIdentity(
  identity: string,
): ParsedRemoteWorkspaceIdentity | null {
  if (!identity.startsWith(REMOTE_IDENTITY_PREFIX)) {
    return null;
  }
  const rest = identity.slice(REMOTE_IDENTITY_PREFIX.length);
  const kindEnd = rest.indexOf(":");
  if (kindEnd <= 0) {
    return null;
  }
  const kind = rest.slice(0, kindEnd);
  if (!isRemoteWorkspaceIdentityKind(kind)) {
    return null;
  }
  // Consume authority one segment at a time; the path can contain ":" (POSIX paths allow it in theory),
  // so do not split the whole identity. Advance by segment, then take the remainder as the path.
  let cursor = kindEnd + 1;
  let sourceServerId: string | undefined;
  for (let i = 0; i < AUTHORITY_SEGMENTS[kind]; i++) {
    const next = rest.indexOf(":", cursor);
    if (next <= cursor) {
      return null;
    }
    if (kind === "server" && i === 0) sourceServerId = rest.slice(cursor, next);
    cursor = next + 1;
  }
  // WSL identities added an optional user segment to distinguish the default user from an explicit user.
  // The old parser consumed only the distro, so it mistook user for the path and rejected the identity.
  // Remote paths must start with "/", which unambiguously distinguishes the legacy format without user from the explicit-user format.
  if (kind === "wsl" && rest[cursor] !== "/") {
    const userEnd = rest.indexOf(":", cursor);
    if (userEnd <= cursor) {
      return null;
    }
    cursor = userEnd + 1;
  }
  const workspacePath = rest.slice(cursor);
  if (!workspacePath.startsWith("/")) {
    return null;
  }
  return { kind, workspacePath, ...(sourceServerId ? { sourceServerId } : {}) };
}

/** Whether the identity is remote and can be parsed by parseRemoteWorkspaceIdentity. */
export function isRemoteWorkspaceIdentity(identity: string): boolean {
  return parseRemoteWorkspaceIdentity(identity) !== null;
}

/**
 * Whether the identity claims to be remote by its prefix, even when it does not parse. Callers that
 * fall back to a local path must check this first: an unparseable remote identity has to fail closed.
 */
export function claimsRemoteWorkspaceIdentity(identity: string): boolean {
  return identity.trim().startsWith(REMOTE_IDENTITY_PREFIX);
}

/**
 * Re-point a remote identity at another path on the same remote authority (for example a worktree
 * of a remote workspace). The path is part of the identity, so the parent identity cannot be reused
 * verbatim: that would keep the parent path and route the new workspace's sessions to the parent
 * checkout. Returns null when the identity is not a remote identity.
 */
export function rebaseRemoteWorkspaceIdentity(
  identity: string,
  workspacePath: string,
): string | null {
  const trimmed = identity.trim();
  const parsed = parseRemoteWorkspaceIdentity(trimmed);
  if (!parsed) {
    return null;
  }
  const authorityPrefix = trimmed.slice(0, trimmed.length - parsed.workspacePath.length);
  return `${authorityPrefix}${normalizeWorkspacePathForIdentity(workspacePath)}`;
}

/** 虚拟项目的 host 身份；只在统一 identity 模块裁剪路径，业务层不得自行拆 authority。 */
export function remoteHostIdFromWorkspaceIdentity(identity: string): string | null {
  const parsed = parseRemoteWorkspaceIdentity(identity);
  return parsed ? identity.slice(0, -(parsed.workspacePath.length + 1)) : null;
}

/** 从已登记的 Host 身份构造目录身份；不让业务模块拼接或解析 authority。 */
export function buildRemoteHostWorkspaceIdentity(hostId: string, workspacePath: string): string {
  const identity = `${hostId}:${normalizeWorkspacePathForIdentity(workspacePath)}`;
  if (remoteHostIdFromWorkspaceIdentity(identity) !== hostId)
    throw new Error("Invalid remote host identity");
  return identity;
}
