import { create } from "zustand";
import type { EmbeddedBrowserPermissionPromptEvent } from "@zcode/shared";

/**
 * Embedded browser permission prompt queue: main pushes requests over IPC, and after the user acts a
 * component sends the decision back and dequeues. Main already deduplicates by origin+permission and
 * applies a 10s timeout; this only queues during rendering.
 */
interface EmbeddedBrowserPermissionState {
  prompts: EmbeddedBrowserPermissionPromptEvent[];
  receivePrompt: (event: EmbeddedBrowserPermissionPromptEvent) => void;
  /** Once main settles the same requestId by timeout, the renderer dequeues it in sync (the next push is unaffected). */
  dropPrompt: (requestId: string) => void;
}

export const useEmbeddedBrowserPermissionStore = create<EmbeddedBrowserPermissionState>((set) => ({
  prompts: [],
  // A push with the same requestId is a hot list update (Bluetooth scans / USB enumeration fire repeatedly); replace rather than append.
  receivePrompt: (event) =>
    set((state) => ({
      prompts: state.prompts.some((prompt) => prompt.requestId === event.requestId)
        ? state.prompts.map((prompt) => (prompt.requestId === event.requestId ? event : prompt))
        : [...state.prompts, event],
    })),
  dropPrompt: (requestId) =>
    set((state) => ({ prompts: state.prompts.filter((prompt) => prompt.requestId !== requestId) })),
}));
