// Model and pure state machine for the binary split tree in pane layout.
// Alignment: Focus points to a Layout pane,
// and each pane points to (workspaceScope, sessionId); SessionDataLayer is unaware of both layers.
//
// Design boundaries:
// - Layout is a binary split tree (like VS Code editor groups): any pane can split right or down,
//   with nesting for 2×2 grids and other layouts. Limit leaves to MAX_WORKBENCH_PANES (performance baseline: four panes).
// - Pane binding is { workspaceScope, sessionId }: each pane owns its workspace (including remoteSessionId);
//   there is no same-workspace restriction. Removed the old rule that hid splits belonging to another workspace:
//   panes persist while switching workspace tabs.
// - workspaceScope means the primary workspace owned by the session and is a connection-routing key;
//   it does not mean every path the session can access. Future auxiliary paths for cross-workspace sessions are
//   session properties and do not belong in the layout layer.
// - The primary pane (workspace-main) is a reserved leaf: it is not part of panes, and its binding follows
//   existing selection state (activeTaskId → shell props), avoiding duplicate writes to zcodeSessionStore/tabStore.
//   tabStore workspace-tab semantics remain unchanged.
// All transition functions are side-effect free; when nothing changes, return the original reference so Zustand avoids rerendering.

/** Fixed ID for the primary pane (keeps the hard-coded paneId and testid contract unchanged). */
export const V4_PRIMARY_PANE_ID = "workspace-main";

/** Maximum leaf panes (performance acceptance baseline: four panes streaming simultaneously without dropped frames); also a soft limit on CLI subprocesses. */
export const MAX_WORKBENCH_PANES = 4;

/** Split-ratio bounds: first subtree occupies 25%–75%; drag and persistence share the same clamp. */
export const SPLIT_RATIO_MIN = 0.25;
export const SPLIT_RATIO_MAX = 0.75;
export const DEFAULT_SPLIT_RATIO = 0.5;

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) {
    return DEFAULT_SPLIT_RATIO;
  }
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio));
}

/** Workspace ownership for a pane (= session’s primary workspace and connection-routing key). Local: workspacePath only. Remote (SSH/WSL/Docker): workspaceIdentity is required by the Workspace Identity rule; remoteSessionId points to the connection in remoteWorkspaceSessionStore (if absent, resolve by identity). */
export interface PaneWorkspaceScope {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly remoteSessionId?: string;
}

/** Shared identity/isolation rule: workspaceKey = workspaceIdentity?.trim() || workspacePath. */
export function paneWorkspaceKey(scope: PaneWorkspaceScope): string {
  return scope.workspaceIdentity?.trim() || scope.workspacePath;
}

export function paneBindingMatchesSession(
  binding: PaneBinding | null | undefined,
  scope: PaneWorkspaceScope,
  sessionId: string,
): boolean {
  return Boolean(
    binding?.sessionId === sessionId &&
    paneWorkspaceKey(binding.workspaceScope) === paneWorkspaceKey(scope),
  );
}

export interface PaneBinding {
  /** Primary workspace owned by the session (connection-routing key); auxiliary paths do not belong here. */
  readonly workspaceScope: PaneWorkspaceScope;
  /** Bound CLI session; null means draft (empty pane flow: bind in place after first-send createSession). */
  readonly sessionId: string | null;
  /** Read-only pane does not render a composer/input; currently used for a child session opened inline from a subagent row. */
  readonly readOnly?: boolean;
  /** Binding restored from persistence but not yet verified by sessions-index for this scope (the marker itself is not persisted). If present, confirmRestoredPaneSession clears it; if the session was deleted, closePane collapses gracefully. */
  readonly restoredUnvalidated?: boolean;
}

export type SplitDirection = "row" | "column";

/** IDE-style split direction: left/up inserts before the anchor; right/down inserts after it. */
export type PaneSplitSide = "left" | "right" | "up" | "down";

export type PaneLayoutNode =
  | { readonly type: "leaf"; readonly paneId: string }
  | {
      readonly type: "split";
      /** Split-node ID (CSS drag variable and lookup key for setSplitRatio). */
      readonly id: string;
      readonly direction: SplitDirection;
      /** Proportion assigned to the first subtree, clamped to [0.25, 0.75]. */
      readonly ratio: number;
      readonly first: PaneLayoutNode;
      readonly second: PaneLayoutNode;
    };

export interface PaneLayoutSnapshot {
  readonly root: PaneLayoutNode;
  /** Bindings for non-primary panes; the primary binding comes from shell props (activeTaskId) and is not stored here. */
  readonly panes: Readonly<Record<string, PaneBinding>>;
  /** The single focused pane across the whole application (one value at the Focus layer). */
  readonly focusedPaneId: string;
}

export const PRIMARY_LEAF: PaneLayoutNode = {
  type: "leaf",
  paneId: V4_PRIMARY_PANE_ID,
};

export const INITIAL_PANE_LAYOUT: PaneLayoutSnapshot = {
  root: PRIMARY_LEAF,
  panes: {},
  focusedPaneId: V4_PRIMARY_PANE_ID,
};

// ============================================================================
// Tree utilities (structural sharing preserves original references along unchanged paths).
// ============================================================================

/** Collect pane IDs in preorder. */
export function leafPaneIds(node: PaneLayoutNode): string[] {
  if (node.type === "leaf") {
    return [node.paneId];
  }
  return [...leafPaneIds(node.first), ...leafPaneIds(node.second)];
}

export function countPanes(state: PaneLayoutSnapshot): number {
  return leafPaneIds(state.root).length;
}

/** Whether another pane can be split (leaf count < MAX_WORKBENCH_PANES). */
export function canAddPane(state: PaneLayoutSnapshot): boolean {
  return countPanes(state) < MAX_WORKBENCH_PANES;
}

function leafExists(node: PaneLayoutNode, paneId: string): boolean {
  if (node.type === "leaf") {
    return node.paneId === paneId;
  }
  return leafExists(node.first, paneId) || leafExists(node.second, paneId);
}

/** Fall back to primary when the focused pane is absent from the tree (for example, after close or malformed restored data). */
export function effectiveFocusedPaneId(state: PaneLayoutSnapshot): string {
  return leafExists(state.root, state.focusedPaneId) ? state.focusedPaneId : V4_PRIMARY_PANE_ID;
}

/** Allocate pane-<n>, where n is the largest existing tree number + 1 (avoids collisions with reserved workspace-main/split IDs). */
function allocatePaneId(root: PaneLayoutNode): string {
  let max = 0;
  for (const paneId of leafPaneIds(root)) {
    const match = /^pane-(\d+)$/.exec(paneId);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return `pane-${max + 1}`;
}

function splitNodeIds(node: PaneLayoutNode): string[] {
  if (node.type === "leaf") {
    return [];
  }
  return [node.id, ...splitNodeIds(node.first), ...splitNodeIds(node.second)];
}

/** Allocate a new split-node ID: n<k> (short ID used in the CSS variable name --v4-split-<id>). */
function allocateSplitNodeId(root: PaneLayoutNode): string {
  let max = 0;
  for (const id of splitNodeIds(root)) {
    const match = /^n(\d+)$/.exec(id);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return `n${max + 1}`;
}

/** Replace the paneId leaf with replacement; preserve the original reference when the path does not match. */
function replaceLeaf(
  node: PaneLayoutNode,
  paneId: string,
  replacement: PaneLayoutNode,
): PaneLayoutNode {
  if (node.type === "leaf") {
    return node.paneId === paneId ? replacement : node;
  }
  const first = replaceLeaf(node.first, paneId, replacement);
  const second = replaceLeaf(node.second, paneId, replacement);
  if (first === node.first && second === node.second) {
    return node;
  }
  return { ...node, first, second };
}

/** Remove a leaf and collapse its parent split node to the sibling subtree; return null if the entire tree was removed (only when the root is that leaf). */
function removeLeaf(node: PaneLayoutNode, paneId: string): PaneLayoutNode | null {
  if (node.type === "leaf") {
    return node.paneId === paneId ? null : node;
  }
  const first = removeLeaf(node.first, paneId);
  if (first === null) {
    return node.second;
  }
  const second = removeLeaf(node.second, paneId);
  if (second === null) {
    return node.first;
  }
  if (first === node.first && second === node.second) {
    return node;
  }
  return { ...node, first, second };
}

function replaceSplitRatio(node: PaneLayoutNode, splitId: string, ratio: number): PaneLayoutNode {
  if (node.type === "leaf") {
    return node;
  }
  if (node.id === splitId) {
    return node.ratio === ratio ? node : { ...node, ratio };
  }
  const first = replaceSplitRatio(node.first, splitId, ratio);
  const second = replaceSplitRatio(node.second, splitId, ratio);
  if (first === node.first && second === node.second) {
    return node;
  }
  return { ...node, first, second };
}

// ============================================================================
// Pure state machine (unit-test target).
// ============================================================================

/**
 * Split at the anchor pane: replace the anchor leaf with a split node { anchor, new pane },
 * bind the new pane to binding (draft or existing session), and give it focus.
 * If the anchor is not in the tree or the leaf limit is reached, no-op (return the original reference).
 */
export function splitPaneAt(
  state: PaneLayoutSnapshot,
  anchorPaneId: string,
  direction: SplitDirection,
  binding: PaneBinding,
): PaneLayoutSnapshot {
  if (!leafExists(state.root, anchorPaneId) || !canAddPane(state)) {
    return state;
  }
  const newPaneId = allocatePaneId(state.root);
  const splitNode: PaneLayoutNode = {
    type: "split",
    id: allocateSplitNodeId(state.root),
    direction,
    ratio: DEFAULT_SPLIT_RATIO,
    first: { type: "leaf", paneId: anchorPaneId },
    second: { type: "leaf", paneId: newPaneId },
  };
  return {
    root: replaceLeaf(state.root, anchorPaneId, splitNode),
    panes: { ...state.panes, [newPaneId]: binding },
    focusedPaneId: newPaneId,
  };
}

/**
 * Split around the anchor pane: left/up place the new pane before the anchor; right/down place it after.
 * Drag-to-split must preserve the user's directional intent; the existing splitPaneAt keeps its “anchor first, new pane second” contract.
 */
export function splitPaneAtSide(
  state: PaneLayoutSnapshot,
  anchorPaneId: string,
  side: PaneSplitSide,
  binding: PaneBinding,
): PaneLayoutSnapshot {
  if (!leafExists(state.root, anchorPaneId) || !canAddPane(state)) {
    return state;
  }
  const newPaneId = allocatePaneId(state.root);
  const anchorLeaf: PaneLayoutNode = { type: "leaf", paneId: anchorPaneId };
  const newLeaf: PaneLayoutNode = { type: "leaf", paneId: newPaneId };
  const before = side === "left" || side === "up";
  const splitNode: PaneLayoutNode = {
    type: "split",
    id: allocateSplitNodeId(state.root),
    direction: side === "left" || side === "right" ? "row" : "column",
    ratio: DEFAULT_SPLIT_RATIO,
    first: before ? newLeaf : anchorLeaf,
    second: before ? anchorLeaf : newLeaf,
  };
  return {
    root: replaceLeaf(state.root, anchorPaneId, splitNode),
    panes: { ...state.panes, [newPaneId]: binding },
    focusedPaneId: newPaneId,
  };
}

/**
 * Close a pane: remove the leaf, collapse the parent split to its sibling subtree, and remove its binding.
 * The primary pane cannot be closed; if the pane is not in the tree, no-op. If it had focus, return focus to primary.
 * Closing a pane does not stop the session: it only unsubscribes the view while the session keeps running in CLI.
 */
export function closePane(state: PaneLayoutSnapshot, paneId: string): PaneLayoutSnapshot {
  if (paneId === V4_PRIMARY_PANE_ID || !leafExists(state.root, paneId)) {
    return state;
  }
  const root = removeLeaf(state.root, paneId) ?? PRIMARY_LEAF;
  const panes = { ...state.panes };
  delete panes[paneId];
  return {
    root,
    panes,
    focusedPaneId: state.focusedPaneId === paneId ? V4_PRIMARY_PANE_ID : state.focusedPaneId,
  };
}

/** Bind the session in place after the draft pane's first createSession. No-op if the pane is unbound/unchanged and has no pending validation marker. */
export function bindPaneSession(
  state: PaneLayoutSnapshot,
  paneId: string,
  sessionId: string,
): PaneLayoutSnapshot {
  const binding = state.panes[paneId];
  if (!binding || (binding.sessionId === sessionId && !binding.restoredUnvalidated)) {
    return state;
  }
  // A live binding is authoritative and needs no further validation; rebuild without restoredUnvalidated.
  return {
    ...state,
    panes: {
      ...state.panes,
      [paneId]: { workspaceScope: binding.workspaceScope, sessionId },
    },
  };
}

/**
 * Replace the full session binding of a non-primary pane in place.
 * After a draft split, clicking a regular session previously updated only shell activeTaskId, causing the new session to overwrite the primary
 * draft; replace the focused secondary pane's scope + session owner first.
 */
export function replacePaneBinding(
  state: PaneLayoutSnapshot,
  paneId: string,
  binding: PaneBinding,
): PaneLayoutSnapshot {
  if (!state.panes[paneId] || paneId === V4_PRIMARY_PANE_ID) {
    return state;
  }
  return {
    ...state,
    panes: {
      ...state.panes,
      [paneId]: binding,
    },
    focusedPaneId: paneId,
  };
}

export function findPaneIdForSession(
  state: PaneLayoutSnapshot,
  scope: PaneWorkspaceScope,
  sessionId: string,
): string | null {
  for (const [paneId, binding] of Object.entries(state.panes)) {
    if (paneBindingMatchesSession(binding, scope, sessionId)) {
      return paneId;
    }
  }
  return null;
}

/** Commit a resize drag: locate by split-node ID and clamp to [25%, 75%]; return the original reference when unchanged. */
export function setSplitNodeRatio(
  state: PaneLayoutSnapshot,
  splitId: string,
  ratio: number,
): PaneLayoutSnapshot {
  const root = replaceSplitRatio(state.root, splitId, clampSplitRatio(ratio));
  if (root === state.root) {
    return state;
  }
  return { ...state, root };
}

/** Focus a pane: accept only leaves present in the current tree; otherwise no-op (return the original reference). */
export function focusPane(state: PaneLayoutSnapshot, paneId: string): PaneLayoutSnapshot {
  if (state.focusedPaneId === paneId || !leafExists(state.root, paneId)) {
    return state;
  }
  return { ...state, focusedPaneId: paneId };
}

/** Clear the pending-validation marker after sessions-index confirms that a restored pane binding is present. No-op if there is no marker. */
export function confirmRestoredPaneSession(
  state: PaneLayoutSnapshot,
  paneId: string,
): PaneLayoutSnapshot {
  const binding = state.panes[paneId];
  if (!binding?.restoredUnvalidated) {
    return state;
  }
  return {
    ...state,
    panes: {
      ...state.panes,
      [paneId]: {
        workspaceScope: binding.workspaceScope,
        sessionId: binding.sessionId,
      },
    },
  };
}

/**
 * Sidebar/drill-in “Open in split view”: if the session is already in a pane (compare by workspaceKey + sessionId,
 * preserving ownership/isolation semantics), focus it; otherwise split the currently focused pane to the right. If at the limit with no existing pane, no-op.
 */
export function openSessionInNewPane(
  state: PaneLayoutSnapshot,
  scope: PaneWorkspaceScope,
  sessionId: string,
): PaneLayoutSnapshot {
  const workspaceKey = paneWorkspaceKey(scope);
  for (const [paneId, binding] of Object.entries(state.panes)) {
    if (
      binding.sessionId === sessionId &&
      paneWorkspaceKey(binding.workspaceScope) === workspaceKey
    ) {
      return focusPane(state, paneId);
    }
  }
  return splitPaneAt(state, effectiveFocusedPaneId(state), "row", {
    workspaceScope: scope,
    sessionId,
  });
}
