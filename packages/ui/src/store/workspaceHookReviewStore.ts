import { create } from "zustand";
import type {
  CommandAck,
  CommandEnvelope,
  WorkspaceHookReviewRequestPayload,
} from "@zcode/shared/zcode-protocol-v4";
// The review-monotonicity decision has one source of truth; the store’s application policy accepts the new Runtime authority for cross_flow
// (the renderer follows the latest delivery of the canonical snapshot).
import { verdictWorkspaceHookReviewRequest } from "@zcode/shared/workspace-hook-review-monotonicity";

export interface WorkspaceHookCommandBinding {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sendCommand(envelope: CommandEnvelope): Promise<CommandAck>;
  onCommandSettled?: (commandId: string) => void;
}

interface WorkspaceHookReviewBinding {
  request: WorkspaceHookReviewRequestPayload;
  workspacePath: string;
  sendCommand(envelope: CommandEnvelope): Promise<CommandAck>;
  onCommandSettled?: (commandId: string) => void;
}

interface WorkspaceHookReviewState {
  bindings: Record<string, WorkspaceHookReviewBinding>;
  commandBindings: Record<string, WorkspaceHookCommandBinding>;
  connect(sessionId: string, binding: WorkspaceHookCommandBinding): void;
  disconnect(sessionId: string, sendCommand: WorkspaceHookCommandBinding["sendCommand"]): void;
  upsert(sessionId: string, binding: WorkspaceHookReviewBinding): void;
  clear(sessionId: string, interactionId?: string): void;
}

export const useWorkspaceHookReviewStore = create<WorkspaceHookReviewState>((set) => ({
  bindings: {},
  commandBindings: {},
  connect: (sessionId, binding) =>
    set((state) => ({
      commandBindings: { ...state.commandBindings, [sessionId]: binding },
    })),
  disconnect: (sessionId, sendCommand) =>
    set((state) => {
      const current = state.commandBindings[sessionId];
      if (!current || current.sendCommand !== sendCommand) return state;
      const commandBindings = { ...state.commandBindings };
      delete commandBindings[sessionId];
      const review = state.bindings[sessionId];
      if (!review || review.sendCommand !== sendCommand) return { commandBindings };
      // Once the command channel is disconnected, do not retain a review binding for that same connection; otherwise Settings
      // may receive a disposed client. The sendCommand identity guard prevents old-connection cleanup from clearing a new connection.
      const bindings = { ...state.bindings };
      delete bindings[sessionId];
      return { bindings, commandBindings };
    }),
  upsert: (sessionId, binding) =>
    set((state) => {
      const commandBinding = state.commandBindings[sessionId];
      if (commandBinding && commandBinding.sendCommand !== binding.sendCommand) {
        // During renderer reconnect, an old effect may arrive late; only the current session command channel may refresh
        // the review binding, preventing an equal-generation replay from replacing a new client with a disposed one.
        return state;
      }
      const current = state.bindings[sessionId];
      if (current) {
        const verdict = verdictWorkspaceHookReviewRequest(current.request, binding.request);
        // Generation values are comparable only within one Runtime flow. A new Runtime gets a new
        // reviewFlowId and starts again from 1; across flows (cross_flow), follow the latest canonical snapshot delivery,
        // or a high generation from the old Runtime permanently blocks requests from the new authority. Within a flow,
        // require strictly monotonic generations; replay/conflict/stale values must not replace the current binding.
        if (
          verdict === "same_flow_stale" ||
          verdict === "same_flow_replay" ||
          verdict === "same_flow_conflict"
        ) {
          return state;
        }
      }
      return { bindings: { ...state.bindings, [sessionId]: binding } };
    }),
  clear: (sessionId, interactionId) =>
    set((state) => {
      const current = state.bindings[sessionId];
      if (!current || (interactionId && current.request.interactionId !== interactionId)) {
        return state;
      }
      const bindings = { ...state.bindings };
      delete bindings[sessionId];
      return { bindings };
    }),
}));

export function findWorkspaceHookReviewBinding(
  bindings: Record<string, WorkspaceHookReviewBinding>,
  workspacePath?: string | null,
  workspaceIdentity?: string,
): WorkspaceHookReviewBinding | undefined {
  return Object.values(bindings)
    .filter((binding) =>
      matchesWorkspaceBinding({
        bindingWorkspaceIdentity: binding.request.workspaceIdentity,
        bindingWorkspacePath: binding.workspacePath,
        workspaceIdentity,
        workspacePath,
      }),
    )
    .sort((left, right) => right.request.createdAt - left.request.createdAt)[0];
}

const TRUSTABLE_WORKSPACE_HOOK_STATES = new Set(["pending_trust", "revoked", "stale_digest"]);

/**
 * Find the exact immutable review binding that can authorize a specified static Settings row.
 *
 * Settings trustState is display-only and must never become mutation authority. Before committing, match workspace, bundle, and opaque reviewItemId
 * together to avoid using another request across a generation/bundle change while waiting.
 */
export function findWorkspaceHookReviewBindingForItem(
  bindings: Record<string, WorkspaceHookReviewBinding>,
  input: {
    workspacePath?: string | null;
    workspaceIdentity?: string;
    bundleDigest: string;
    reviewItemId: string;
  },
): WorkspaceHookReviewBinding | undefined {
  return Object.values(bindings)
    .filter(
      (binding) =>
        matchesWorkspaceBinding({
          bindingWorkspaceIdentity: binding.request.workspaceIdentity,
          bindingWorkspacePath: binding.workspacePath,
          workspaceIdentity: input.workspaceIdentity,
          workspacePath: input.workspacePath,
        }) &&
        binding.request.bundleDigest === input.bundleDigest &&
        binding.request.items.some(
          (item) =>
            item.reviewItemId === input.reviewItemId &&
            TRUSTABLE_WORKSPACE_HOOK_STATES.has(item.trustState),
        ),
    )
    .sort((left, right) => right.request.createdAt - left.request.createdAt)[0];
}

export function waitForWorkspaceHookReviewBindingForItem(
  input: {
    workspacePath?: string | null;
    workspaceIdentity?: string;
    bundleDigest: string;
    reviewItemId: string;
  },
  timeoutMs: number,
): Promise<WorkspaceHookReviewBinding | undefined> {
  const current = findWorkspaceHookReviewBindingForItem(
    useWorkspaceHookReviewStore.getState().bindings,
    input,
  );
  if (current) return Promise.resolve(current);

  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    const timer = globalThis.setTimeout(() => finish(undefined), timeoutMs);
    const finish = (binding: WorkspaceHookReviewBinding | undefined) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      unsubscribe();
      resolve(binding);
    };
    unsubscribe = useWorkspaceHookReviewStore.subscribe((state) => {
      const binding = findWorkspaceHookReviewBindingForItem(state.bindings, input);
      if (binding) finish(binding);
    });

    // A synchronous upsert may occur between subscribe and the initial read; check once more after subscribing to close that race.
    const afterSubscribe = findWorkspaceHookReviewBindingForItem(
      useWorkspaceHookReviewStore.getState().bindings,
      input,
    );
    if (afterSubscribe) finish(afterSubscribe);
  });
}

export function findWorkspaceHookCommandBinding(
  bindings: Record<string, WorkspaceHookCommandBinding>,
  workspacePath?: string | null,
  workspaceIdentity?: string,
): WorkspaceHookCommandBinding | undefined {
  return Object.values(bindings).find((binding) =>
    matchesWorkspaceBinding({
      bindingWorkspaceIdentity: binding.workspaceIdentity,
      bindingWorkspacePath: binding.workspacePath,
      workspaceIdentity,
      workspacePath,
    }),
  );
}

function matchesWorkspaceBinding(input: {
  bindingWorkspaceIdentity?: string;
  bindingWorkspacePath: string;
  workspaceIdentity?: string;
  workspacePath?: string | null;
}): boolean {
  const workspaceKey = input.workspaceIdentity?.trim() || input.workspacePath;
  if (!workspaceKey) return false;
  const bindingWorkspaceIdentity = input.bindingWorkspaceIdentity?.trim();
  if (bindingWorkspaceIdentity) {
    // OR-matching on identity or path alone is insufficient: a remote tab at the same path could be selected by local Settings
    // as a trusted submission channel based on path equality, causing cross-workspace authorization.
    // Fix: when a binding has identity, require an exact workspaceKey match. Only older local bindings without their own
    // identity may fall back to path matching.
    return bindingWorkspaceIdentity === workspaceKey;
  }
  // If the current query carries an identity, also forbid path fallback; otherwise an unknown remote identity could accidentally select
  // an older local binding that has no identity.
  return !input.workspaceIdentity?.trim() && input.bindingWorkspacePath === input.workspacePath;
}
