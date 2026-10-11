import type { RemoteWorkspaceSessionEntry } from "@zcode/shared";

interface SshConnectionHistorySuggestions {
  hosts: string[];
  ports: string[];
  usernames: string[];
  privateKeyPaths: string[];
}

function dedupeSuggestions(values: readonly string[]): string[] {
  const seen = new Set<string>();

  return values.flatMap((value) => {
    const normalizedValue = value.trim();
    if (!normalizedValue || seen.has(normalizedValue)) {
      return [];
    }

    seen.add(normalizedValue);
    return [normalizedValue];
  });
}

export function buildSshConnectionHistorySuggestions(
  remoteWorkspaceSessions: readonly RemoteWorkspaceSessionEntry[],
): SshConnectionHistorySuggestions {
  const sshSnapshots = remoteWorkspaceSessions.flatMap((entry) =>
    entry.target.kind === "ssh" ? [entry.target] : [],
  );

  return {
    // Deduplicate SSH history suggestions and show them in most-recent-connection order; otherwise the same host/username
    // would appear repeatedly after multiple connections, making the most recently used item hard to find when focus opens the dropdown.
    hosts: dedupeSuggestions(sshSnapshots.map((snapshot) => snapshot.host)),
    ports: dedupeSuggestions(sshSnapshots.map((snapshot) => String(snapshot.port ?? 22))),
    usernames: dedupeSuggestions(sshSnapshots.map((snapshot) => snapshot.username)),
    privateKeyPaths: dedupeSuggestions(
      sshSnapshots.map((snapshot) => snapshot.privateKeyPath ?? ""),
    ),
  };
}
