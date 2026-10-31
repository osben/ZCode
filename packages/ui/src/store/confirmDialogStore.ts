import { create } from "zustand";
import { logger } from "@/logger.js";

export interface ConfirmDialogRequest {
  title: string;
  testId?: string;
  description?: string;
  /** Read-only code already redacted by the caller, shown in its own section beside the
   *   description. */
  codeBlock?: { code: string; language: string };
  /**
   * The description can be long (e.g. the running-task list before stopping a remote service):
   * the description area scrolls within a height cap and wraps long paths, keeping the title
   * and buttons visible. Applies only to the default confirm dialog; callers that do not
   * declare it are unaffected.
   */
  scrollableDescription?: boolean;
  /** Stable business semantics for E2E/accessibility; independent of localized title text. */
  intent?: string;
  /** Stable visual spec for specific business dialogs; the default confirm dialog is
   *   unaffected. */
  presentation?: "automation-confirmation" | "source-server-boundary" | "yolo-confirmation";
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: "default" | "destructive";
  showCloseButton?: boolean;
  /** Notice dialog requiring explicit user confirmation: hides cancel and ignores mask/Escape
   *   dismissal. */
  requiredAcknowledgement?: boolean;
  showKeyboardHints?: boolean;
  compact?: boolean;
  checkbox?: { label: string; onCheckedChange: (checked: boolean) => void };
}

export type ConfirmDialogChoice = "confirm" | "cancel" | "dismiss";

interface PendingConfirmDialogRequest extends ConfirmDialogRequest {
  resolve: (choice: ConfirmDialogChoice) => void;
}

interface ConfirmDialogState {
  pendingRequest?: PendingConfirmDialogRequest;
  requestConfirmation: (payload: ConfirmDialogRequest, signal?: AbortSignal) => Promise<boolean>;
  requestChoice: (
    payload: ConfirmDialogRequest,
    signal?: AbortSignal,
  ) => Promise<ConfirmDialogChoice>;
  settleConfirmation: (confirmed: boolean) => void;
  settleChoice: (choice: ConfirmDialogChoice) => void;
}

export const useConfirmDialogStore = create<ConfirmDialogState>((set, get) => ({
  pendingRequest: undefined,
  requestConfirmation: async (payload, signal) =>
    (await get().requestChoice(payload, signal)) === "confirm",
  requestChoice: (payload, signal) => {
    if (signal?.aborted) return Promise.resolve("dismiss");
    if (get().pendingRequest) {
      logger.warn("[ConfirmDialogStore] confirmation already in progress");
      return Promise.resolve("dismiss");
    }

    return new Promise<ConfirmDialogChoice>((resolve) => {
      const pendingRequest: PendingConfirmDialogRequest = {
        ...payload,
        resolve: (choice) => {
          signal?.removeEventListener("abort", abort);
          resolve(choice);
        },
      };
      // A stale target may only close its own request; it must not settle a different confirmation opened later.
      const abort = () => {
        if (get().pendingRequest === pendingRequest) get().settleChoice("dismiss");
      };
      signal?.addEventListener("abort", abort, { once: true });
      set({ pendingRequest });
    });
  },
  settleConfirmation: (confirmed) => get().settleChoice(confirmed ? "confirm" : "cancel"),
  settleChoice: (choice) => {
    const pendingRequest = get().pendingRequest;
    if (!pendingRequest) {
      return;
    }

    set({ pendingRequest: undefined });
    pendingRequest.resolve(choice);
  },
}));
