// Authoritative version for tasks-index rows/membership.
// sessions-index carries only list activity and detail; task create/delete and organization state such as pin/archive/unread
// are persisted in tasks-index.sqlite, so derived lists cannot detect row additions or membership changes from session updates.
// Bump this version after a mutation so every task-row left list + session detail join rereads and filters the data.
import { useSyncExternalStore } from "react";

let version = 0;
const listeners = new Set<() => void>();

/** Call after a task-row or membership mutation to notify all sessions-index derived lists to refetch the left table. */
export function bumpTaskListMembershipVersion(): void {
  version += 1;
  for (const listener of [...listeners]) {
    listener();
  }
}

function subscribeTaskListMembershipVersion(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getTaskListMembershipVersion(): number {
  return version;
}

// The same workspace_task_list_changed event arrives through multiple subscriptions (shared subscription fan-out from useGlobalTaskList
// + independent subscription from useWorkspaceTaskLists; object references differ after RPC deserialization),
// each bumping the version and making one membership mutation trigger multiple global refetches. Deduplicate by event-content key
// over a short window: the key includes meta timestamps (updatedAt/unreadAt), so only “duplicate deliveries of the same event” are merged;
// fast consecutive real mutations (pin→unpin, etc.) have different reasons/timestamps and are not swallowed.
// Events without meta (bulk archive / group operations) cannot produce a reliable key, so pass them through without deduplication.
const BUMP_DEDUPE_WINDOW_MS = 500;
const BUMP_DEDUPE_MAX_KEYS = 256;
const recentBumpAtByKey = new Map<string, number>();

interface MembershipBumpEventLike {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId?: string;
  reason: string;
  taskMeta?: {
    updatedAt: number;
    unreadAt?: number;
  };
}

export function bumpTaskListMembershipVersionForWorkspaceEvent(
  event: MembershipBumpEventLike,
): void {
  if (!event.taskMeta || !event.taskId) {
    bumpTaskListMembershipVersion();
    return;
  }
  const workspaceKey = event.workspaceIdentity?.trim() || event.workspacePath;
  const dedupeKey = [
    workspaceKey,
    event.taskId,
    event.reason,
    event.taskMeta.updatedAt,
    event.taskMeta.unreadAt ?? "",
  ].join("::");
  const now = Date.now();
  const lastBumpAt = recentBumpAtByKey.get(dedupeKey);
  if (lastBumpAt !== undefined && now - lastBumpAt < BUMP_DEDUPE_WINDOW_MS) {
    return;
  }
  for (const [key, bumpedAt] of recentBumpAtByKey) {
    if (now - bumpedAt >= BUMP_DEDUPE_WINDOW_MS) {
      recentBumpAtByKey.delete(key);
    }
  }
  if (recentBumpAtByKey.size < BUMP_DEDUPE_MAX_KEYS) {
    recentBumpAtByKey.set(dedupeKey, now);
  }
  bumpTaskListMembershipVersion();
}

/** React binding: rerender when the version changes (subscribe/get are module-level functions with stable references). */
export function useTaskListMembershipVersion(): number {
  return useSyncExternalStore(subscribeTaskListMembershipVersion, getTaskListMembershipVersion);
}
