import type { AppSettings } from "@zcode/shared";
import type { InputRouting, SessionConfigState } from "@zcode/shared/zcode-protocol-v4";

export function resolveAppFollowupMode(
  settings: AppSettings | null | undefined,
): SessionConfigState["followupMode"] | null {
  if (!settings) return null;
  return settings.zcodeInteractionBehavior === "guide" ? "guide" : "queue";
}

export function resolveOppositeFollowupDelivery(
  mode: SessionConfigState["followupMode"],
): "startNow" | "queue" {
  // A modifier-key send in queue mode used to be interpreted as guide; "send immediately" is the queue's existing preemption behavior.
  return mode === "guide" ? "queue" : "startNow";
}

export function shouldEnableModifiedEnterSubmit({
  inputRoutingMode,
  isMobileTextInputViewport,
  isWebRemoteControl,
}: {
  inputRoutingMode: InputRouting["mode"];
  isMobileTextInputViewport: boolean;
  isWebRemoteControl: boolean;
}): boolean {
  // Bug cause: The old gate treated drafts and the generic mobile media query as “mobile,” so desktop new tasks and
  // narrow Windows windows/touch devices did not register Ctrl+Enter, and the event fell back to Lexical’s default newline behavior.
  // This behavior is for mobile Web remote control; viewport size or pointer capability must not change desktop continuous-link semantics.
  return inputRoutingMode !== "reject" && !(isWebRemoteControl && isMobileTextInputViewport);
}

export function shouldReverseFollowupDeliveryForPointer({
  enabled,
  metaKey = false,
  ctrlKey = false,
  isApplePlatform,
}: {
  enabled: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  isApplePlatform?: boolean;
}): boolean {
  return (
    enabled &&
    (isApplePlatform === undefined
      ? metaKey || ctrlKey
      : isPrimaryFollowupModifierPressed({ isApplePlatform, metaKey, ctrlKey }))
  );
}

export function isPrimaryFollowupModifierPressed({
  isApplePlatform,
  metaKey = false,
  ctrlKey = false,
}: {
  isApplePlatform: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}): boolean {
  return isApplePlatform ? metaKey : ctrlKey;
}

export interface FollowupModifierTooltip {
  delivery: "startNow" | "queue";
  shortcut: string;
  titleId: "chat.followup.sendNow" | "chat.followup.addToQueue";
}

export function resolveFollowupModifierTooltip({
  enabled,
  canSend,
  modifierPressed,
  followupMode,
  isApplePlatform,
}: {
  enabled: boolean;
  canSend: boolean;
  modifierPressed: boolean;
  followupMode: SessionConfigState["followupMode"] | undefined;
  isApplePlatform: boolean;
}): FollowupModifierTooltip | null {
  if (!enabled || !canSend || !modifierPressed || !followupMode) return null;
  const delivery = resolveOppositeFollowupDelivery(followupMode);
  return {
    delivery,
    shortcut: isApplePlatform ? "⌘ + Enter" : "Ctrl + Enter",
    titleId: delivery === "startNow" ? "chat.followup.sendNow" : "chat.followup.addToQueue",
  };
}
