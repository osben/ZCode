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
 *
 * Activation and consumption are asynchronous (the Settings defaults read, the send round-trip),
 * so the store also owns a per-workspace intent generation: a counter bumped on every intent
 * transition and when a draft is submitted. Async continuations capture the generation when the
 * user acts and apply only if it is still current, so a stale draft can neither arm the intent
 * after its send nor clear the intent of a newer draft.
 */
interface DraftIncognitoIntentState {
  capabilitiesByWorkspaceKey: Record<string, IncognitoCapabilities>;
  generationByWorkspaceKey: Record<string, number>;
  activate: (workspaceKey: string, defaults: IncognitoCapabilities) => void;
  /** Applies a defaults read captured for `generation`; discarded when the intent moved on. */
  activateIfCurrent: (
    workspaceKey: string,
    defaults: IncognitoCapabilities,
    generation: number,
  ) => void;
  deactivate: (workspaceKey: string) => void;
  setCapability: (
    workspaceKey: string,
    capability: IncognitoCapabilityKey,
    included: boolean,
  ) => void;
  /**
   * Freezes the intent for a draft submission: bumps the generation (which invalidates activations
   * captured for the submitted draft) and returns the frozen profile with the generation that
   * owns it, or undefined when the draft is not incognito.
   */
  captureForSubmission: (
    workspaceKey: string,
  ) => { profile: IncognitoProfile; generation: number } | undefined;
  /** Deactivates only when the intent generation still matches the one captured at send time. */
  releaseAfterSend: (workspaceKey: string, generation: number) => void;
}

function bumpGeneration(
  generations: Record<string, number>,
  workspaceKey: string,
): Record<string, number> {
  return { ...generations, [workspaceKey]: (generations[workspaceKey] ?? 0) + 1 };
}

export const useDraftIncognitoIntentStore = create<DraftIncognitoIntentState>()((set, get) => ({
  capabilitiesByWorkspaceKey: {},
  generationByWorkspaceKey: {},
  activate: (workspaceKey, defaults) =>
    set((state) =>
      workspaceKey in state.capabilitiesByWorkspaceKey
        ? state
        : {
            capabilitiesByWorkspaceKey: {
              ...state.capabilitiesByWorkspaceKey,
              [workspaceKey]: { ...defaults },
            },
            generationByWorkspaceKey: bumpGeneration(state.generationByWorkspaceKey, workspaceKey),
          },
    ),
  activateIfCurrent: (workspaceKey, defaults, generation) => {
    if (selectDraftIncognitoGeneration(get(), workspaceKey) !== generation) return;
    get().activate(workspaceKey, defaults);
  },
  deactivate: (workspaceKey) =>
    set((state) => {
      // A no-op deactivate still bumps: an explicit "off" cancels a pending activation the same
      // way a consumed intent does.
      const generations = bumpGeneration(state.generationByWorkspaceKey, workspaceKey);
      if (!(workspaceKey in state.capabilitiesByWorkspaceKey)) {
        return { generationByWorkspaceKey: generations };
      }
      const { [workspaceKey]: _removed, ...rest } = state.capabilitiesByWorkspaceKey;
      return { capabilitiesByWorkspaceKey: rest, generationByWorkspaceKey: generations };
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
        // Changed while a send was in flight: the deviation belongs to the next draft, so the
        // send's cleanup must not consume it.
        generationByWorkspaceKey: bumpGeneration(state.generationByWorkspaceKey, workspaceKey),
      };
    }),
  captureForSubmission: (workspaceKey) => {
    const state = get();
    const generation = selectDraftIncognitoGeneration(state, workspaceKey) + 1;
    set({
      generationByWorkspaceKey: { ...state.generationByWorkspaceKey, [workspaceKey]: generation },
    });
    const capabilities = state.capabilitiesByWorkspaceKey[workspaceKey];
    return capabilities ? { profile: buildIncognitoProfile(capabilities), generation } : undefined;
  },
  releaseAfterSend: (workspaceKey, generation) => {
    if (selectDraftIncognitoGeneration(get(), workspaceKey) !== generation) return;
    get().deactivate(workspaceKey);
  },
}));

export function selectDraftIncognito(
  state: DraftIncognitoIntentState,
  workspaceKey: string,
): IncognitoCapabilities | null {
  return state.capabilitiesByWorkspaceKey[workspaceKey] ?? null;
}

export function selectDraftIncognitoGeneration(
  state: DraftIncognitoIntentState,
  workspaceKey: string,
): number {
  return state.generationByWorkspaceKey[workspaceKey] ?? 0;
}
