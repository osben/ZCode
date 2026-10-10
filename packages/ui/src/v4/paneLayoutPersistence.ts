// Persist the split-view layout in localStorage; gracefully degrade on try/catch.
// Discard corrupted data as a whole and return to the initial layout (do not partially recover it).
// Continue reading legacy v1 (single splitPane value), migrating only when the v1 workspaceKey is a trusted local path.
import {
  clampSplitRatio,
  leafPaneIds,
  MAX_WORKBENCH_PANES,
  PRIMARY_LEAF,
  V4_PRIMARY_PANE_ID,
  type PaneBinding,
  type PaneLayoutNode,
  type PaneLayoutSnapshot,
  type PaneWorkspaceScope,
  type SplitDirection,
} from "@/v4/paneLayoutTree.js";

const PANE_LAYOUT_STORAGE_KEY = "zcode-v4-pane-layout:v2";
/** Key for the legacy single-value split view (read-only migration; no longer written). */
const PANE_LAYOUT_STORAGE_KEY_V1 = "zcode-v4-pane-layout:v1";

/** Reserved pane ID for v1 migration (the legacy split pane had a fixed ID retained by the e2e/testid contract). */
const V4_LEGACY_SPLIT_PANE_ID = "split";

interface PersistedScopeV2 {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

interface PersistedBindingV2 {
  workspaceScope: PersistedScopeV2;
  sessionId: string | null;
}

type PersistedNodeV2 =
  | { type: "leaf"; paneId: string }
  | {
      type: "split";
      id: string;
      direction: SplitDirection;
      ratio: number;
      first: PersistedNodeV2;
      second: PersistedNodeV2;
    };

interface PersistedPaneLayoutV2 {
  root: PersistedNodeV2;
  panes: Record<string, PersistedBindingV2>;
  focusedPaneId: string;
}

function sanitizeNode(raw: unknown): PaneLayoutNode | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Partial<PersistedNodeV2> & Record<string, unknown>;
  if (record.type === "leaf") {
    return typeof record.paneId === "string" && record.paneId.length > 0
      ? { type: "leaf", paneId: record.paneId }
      : null;
  }
  if (record.type === "split") {
    if (
      typeof record.id !== "string" ||
      record.id.length === 0 ||
      (record.direction !== "row" && record.direction !== "column")
    ) {
      return null;
    }
    const first = sanitizeNode(record.first);
    const second = sanitizeNode(record.second);
    if (!first || !second) {
      return null;
    }
    return {
      type: "split",
      id: record.id,
      direction: record.direction,
      ratio: clampSplitRatio(typeof record.ratio === "number" ? record.ratio : Number.NaN),
      first,
      second,
    };
  }
  return null;
}

function sanitizeScope(raw: unknown): PaneWorkspaceScope | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Partial<PersistedScopeV2>;
  if (typeof record.workspacePath !== "string" || record.workspacePath.length === 0) {
    return null;
  }
  return {
    workspacePath: record.workspacePath,
    ...(typeof record.workspaceIdentity === "string" && record.workspaceIdentity.trim().length > 0
      ? { workspaceIdentity: record.workspaceIdentity }
      : {}),
    ...(typeof record.remoteSessionId === "string" && record.remoteSessionId.length > 0
      ? { remoteSessionId: record.remoteSessionId }
      : {}),
  };
}

/**
 * Normalize any (possibly corrupted) v2 persisted value into a valid layout snapshot; return null if it cannot be recovered (the caller uses the initial layout).
 * Integrity requirements (discard the entire value if any fail): valid tree structure, unique leaf IDs, exactly one primary,
 * number of leaves ≤ limit, and a valid binding for each non-primary leaf. Add restoredUnvalidated to restored
 * session bindings (pending sessions-index validation); if focusedPaneId is not in the tree, use the primary.
 */
function sanitizePersistedPaneLayout(raw: unknown): PaneLayoutSnapshot | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Partial<PersistedPaneLayoutV2>;
  const root = sanitizeNode(record.root);
  if (!root) {
    return null;
  }
  const paneIds = leafPaneIds(root);
  if (
    paneIds.length > MAX_WORKBENCH_PANES ||
    new Set(paneIds).size !== paneIds.length ||
    paneIds.filter((paneId) => paneId === V4_PRIMARY_PANE_ID).length !== 1
  ) {
    return null;
  }
  const rawPanes =
    typeof record.panes === "object" && record.panes !== null
      ? (record.panes as Record<string, unknown>)
      : {};
  const panes: Record<string, PaneBinding> = {};
  for (const paneId of paneIds) {
    if (paneId === V4_PRIMARY_PANE_ID) {
      continue;
    }
    const rawBinding = rawPanes[paneId];
    if (typeof rawBinding !== "object" || rawBinding === null) {
      return null;
    }
    const scope = sanitizeScope((rawBinding as Partial<PersistedBindingV2>).workspaceScope);
    if (!scope) {
      return null;
    }
    const rawSessionId = (rawBinding as Partial<PersistedBindingV2>).sessionId;
    const sessionId =
      typeof rawSessionId === "string" && rawSessionId.length > 0 ? rawSessionId : null;
    panes[paneId] = {
      workspaceScope: scope,
      sessionId,
      ...(sessionId !== null ? { restoredUnvalidated: true as const } : {}),
    };
  }
  const focusedPaneId =
    typeof record.focusedPaneId === "string" && paneIds.includes(record.focusedPaneId)
      ? record.focusedPaneId
      : V4_PRIMARY_PANE_ID;
  return { root, panes, focusedPaneId };
}

/** Migrate a v1 workspaceKey to workspacePath only if it is a trusted local absolute path (POSIX / Windows drive letter). */
function isPlausibleLocalPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * Migrate legacy v1 (single splitPane value) → v2: v1 stored only workspaceKey (identity ?? path),
 * which cannot restore remote scope — migrate to a two-leaf tree only if it is a trusted local path; otherwise discard it and return to a single pane (null).
 */
function migratePersistedPaneLayoutV1(raw: unknown): PaneLayoutSnapshot | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as {
    splitPane?: { workspaceKey?: unknown; sessionId?: unknown } | null;
    focusedPaneId?: unknown;
    splitRatio?: unknown;
  };
  const workspaceKey = record.splitPane?.workspaceKey;
  if (
    typeof workspaceKey !== "string" ||
    workspaceKey.length === 0 ||
    !isPlausibleLocalPath(workspaceKey)
  ) {
    return null;
  }
  const rawSessionId = record.splitPane?.sessionId;
  const sessionId =
    typeof rawSessionId === "string" && rawSessionId.length > 0 ? rawSessionId : null;
  return {
    root: {
      type: "split",
      id: "n1",
      direction: "row",
      ratio: clampSplitRatio(
        typeof record.splitRatio === "number" ? record.splitRatio : Number.NaN,
      ),
      first: PRIMARY_LEAF,
      second: { type: "leaf", paneId: V4_LEGACY_SPLIT_PANE_ID },
    },
    panes: {
      [V4_LEGACY_SPLIT_PANE_ID]: {
        workspaceScope: { workspacePath: workspaceKey },
        sessionId,
        ...(sessionId !== null ? { restoredUnvalidated: true as const } : {}),
      },
    },
    focusedPaneId:
      record.focusedPaneId === V4_LEGACY_SPLIT_PANE_ID
        ? V4_LEGACY_SPLIT_PANE_ID
        : V4_PRIMARY_PANE_ID,
  };
}

/** Read the persisted layout (prefer v2 and try v1 migration if absent); return null if no record, data is corrupted, or storage is unavailable. */
export function readPersistedPaneLayout(): PaneLayoutSnapshot | null {
  try {
    const rawV2 = localStorage.getItem(PANE_LAYOUT_STORAGE_KEY);
    if (rawV2) {
      return sanitizePersistedPaneLayout(JSON.parse(rawV2));
    }
    const rawV1 = localStorage.getItem(PANE_LAYOUT_STORAGE_KEY_V1);
    if (rawV1) {
      return migratePersistedPaneLayoutV1(JSON.parse(rawV1));
    }
    return null;
  } catch {
    return null;
  }
}

function serializeNode(node: PaneLayoutNode): PersistedNodeV2 {
  if (node.type === "leaf") {
    return { type: "leaf", paneId: node.paneId };
  }
  return {
    type: "split",
    id: node.id,
    direction: node.direction,
    ratio: node.ratio,
    first: serializeNode(node.first),
    second: serializeNode(node.second),
  };
}

// Deduplicate writes: subscribe fires on every state change, so skip setItem when serialization is unchanged (for example, clearing restoredUnvalidated
// does not affect persisted data).
let lastPersistedPaneLayout: string | null = null;

export function persistPaneLayout(snapshot: PaneLayoutSnapshot): void {
  const panes: Record<string, PersistedBindingV2> = {};
  for (const [paneId, binding] of Object.entries(snapshot.panes)) {
    panes[paneId] = {
      workspaceScope: {
        workspacePath: binding.workspaceScope.workspacePath,
        ...(binding.workspaceScope.workspaceIdentity
          ? { workspaceIdentity: binding.workspaceScope.workspaceIdentity }
          : {}),
        ...(binding.workspaceScope.remoteSessionId
          ? { remoteSessionId: binding.workspaceScope.remoteSessionId }
          : {}),
      },
      sessionId: binding.sessionId,
    };
  }
  const payload: PersistedPaneLayoutV2 = {
    root: serializeNode(snapshot.root),
    panes,
    focusedPaneId: snapshot.focusedPaneId,
  };
  try {
    const serialized = JSON.stringify(payload);
    if (serialized === lastPersistedPaneLayout) {
      return;
    }
    localStorage.setItem(PANE_LAYOUT_STORAGE_KEY, serialized);
    lastPersistedPaneLayout = serialized;
  } catch {
    // Gracefully degrade when storage is unavailable (tests/private browsing): layout restoration after refresh is unavailable, but split view still works normally.
  }
}
