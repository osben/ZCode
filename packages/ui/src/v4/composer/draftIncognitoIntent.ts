import { create } from "zustand";
import {
  buildIncognitoProfile,
  type IncognitoCapabilities,
  type IncognitoCapabilityKey,
  type IncognitoProfile,
} from "@zcode/shared";

/**
 * Draft incognito intent (specs/incognito-session.md "Draft state"): UI-local, keyed by the
 * workspace identity key. Presence means the next session started from this draft is incognito;
 * the value is the per-session capability selection, seeded from the Settings defaults.
 */
interface DraftIncognitoIntentState {
  capabilitiesByWorkspaceKey: Record<string, IncognitoCapabilities>;
  activate: (workspaceKey: string, defaults: IncognitoCapabilities) => void;
  deactivate: (workspaceKey: string) => void;
  setCapability: (
    workspaceKey: string,
    capability: IncognitoCapabilityKey,
    included: boolean,
  ) => void;
}

export const useDraftIncognitoIntentStore = create<DraftIncognitoIntentState>((set) => ({
  capabilitiesByWorkspaceKey: {},
  activate: (workspaceKey, defaults) =>
    set((state) =>
      workspaceKey in state.capabilitiesByWorkspaceKey
        ? state
        : {
            capabilitiesByWorkspaceKey: {
              ...state.capabilitiesByWorkspaceKey,
              [workspaceKey]: { ...defaults },
            },
          },
    ),
  deactivate: (workspaceKey) =>
    set((state) => {
      if (!(workspaceKey in state.capabilitiesByWorkspaceKey)) return state;
      const { [workspaceKey]: _removed, ...rest } = state.capabilitiesByWorkspaceKey;
      return { capabilitiesByWorkspaceKey: rest };
    }),
  setCapability: (workspaceKey, capability, included) =>
    set((state) => {
      const current = state.capabilitiesByWorkspaceKey[workspaceKey];
      if (!current || current[capability] === included) return state;
      return {
        capabilitiesByWorkspaceKey: {
          ...state.capabilitiesByWorkspaceKey,
          [workspaceKey]: { ...current, [capability]: included },
        },
      };
    }),
}));

export function selectDraftIncognito(
  state: DraftIncognitoIntentState,
  workspaceKey: string,
): IncognitoCapabilities | null {
  return state.capabilitiesByWorkspaceKey[workspaceKey] ?? null;
}

/** The frozen profile to send with the first createSession, or undefined for a normal session. */
export function resolveDraftIncognitoProfile(workspaceKey: string): IncognitoProfile | undefined {
  const capabilities = selectDraftIncognito(useDraftIncognitoIntentStore.getState(), workspaceKey);
  return capabilities ? buildIncognitoProfile(capabilities) : undefined;
}
