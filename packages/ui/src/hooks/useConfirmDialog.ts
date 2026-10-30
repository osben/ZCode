import { useCallback, useLayoutEffect, useRef } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";

export function useConfirmDialog() {
  return useConfirmDialogStore((state) => state.requestConfirmation);
}

/** Only wrap explicit entry points; the scope must be stable and change when the original state owner's target changes. */
export function useYoloModeConfirmation(scope: unknown, currentMode: string | undefined) {
  const { intl } = useZCodeIntl();
  const requestConfirmation = useConfirmDialog();
  const pending = useRef<AbortController | null>(null);
  useLayoutEffect(
    () => () => {
      // Checking mounted only when the dialog closes is not enough: navigation may also happen between confirmation settlement and the microtask submission.
      pending.current?.abort();
      pending.current = null;
    },
    [scope, currentMode],
  );

  return useCallback(
    (nextMode: string, apply: () => void) => {
      if (
        pending.current ||
        useConfirmDialogStore.getState().pendingRequest?.presentation === "yolo-confirmation"
      )
        return;
      if (nextMode !== "yolo" || currentMode === "yolo") {
        apply();
        return;
      }
      const controller = new AbortController();
      pending.current = controller;
      void requestConfirmation(
        {
          title: intl.formatMessage({ id: "mode.yoloConfirmation.title" }),
          presentation: "yolo-confirmation",
        },
        controller.signal,
      ).then((confirmed) => {
        if (pending.current === controller) pending.current = null;
        if (confirmed && !controller.signal.aborted) apply();
      });
    },
    [currentMode, intl, requestConfirmation, scope],
  );
}
