/** Cross-window state broadcast wiring (extracted from store/index.ts to keep the main store module small). */
import type { IBroadcastService, BroadcastMessage } from "@zcode/services";
import type { StoreApi, UseBoundStore } from "zustand";
import {
  applyCodingPlanQuotaResetAutoPlayedBroadcast,
  parseCodingPlanQuotaResetAutoPlayedBroadcastMessage,
} from "@/store/codingPlanQuotaResetState.js";
import {
  applyFontPreferencesBroadcast,
  applyPersistedFontPreferences,
} from "@/store/fontPreferences.js";
import { applyUiFontSizePx } from "@/lib/uiFontSize.js";
import type { Theme } from "../useTheme.js";
import { applyTheme, isThemePalette, migrateThemeSelection } from "../useTheme.js";
import { normalizeInterfaceMode } from "@/lib/interfaceMode.js";
import type { ZCodeState } from "./index.js";

/** Broadcast channel name prefix. */
const STATE_CHANNEL_PREFIX = "state:";

const BROADCAST_FIELDS = new Set<string>([
  "theme",
  "palette",
  "locale",
  "uiFontSizePx",
  "interfaceMode",
  "uiFontFamily",
  "monoFontFamily",
  "notificationEnabled",
  "hideProjectDeviceNames",
]);

type BroadcastField =
  | "theme"
  | "palette"
  | "locale"
  | "uiFontSizePx"
  | "interfaceMode"
  | "uiFontFamily"
  | "monoFontFamily"
  | "notificationEnabled"
  | "hideProjectDeviceNames";

/** Subscribe to state changes and broadcast only the fields that actually need cross-window sync; this is clearer and avoids overload conflicts. */
export function wireStateBroadcast(
  useStore: UseBoundStore<StoreApi<ZCodeState>>,
  broadcastService: IBroadcastService,
  syncSystemThemeListener: (theme: Theme) => void,
): void {
  /** Marker for applying an update received from broadcast; prevents rebroadcast loops. */
  let applyingBroadcast = false;

  useStore.subscribe((state, prevState) => {
    if (applyingBroadcast) {
      return;
    }

    for (const field of BROADCAST_FIELDS as Set<BroadcastField>) {
      if (state[field] === prevState[field]) {
        continue;
      }

      broadcastService.send({
        channel: `${STATE_CHANNEL_PREFIX}${field}`,
        payload: state[field],
      });
    }
  });

  // Listen for broadcasts from other windows.
  broadcastService.onMessage((msg: BroadcastMessage) => {
    // Enforce "play once across windows" for automatic completion. After another window broadcasts a played used_at, this window merges
    // the played record and hides any prompt playing for the same used_at; local echoes were already ignored during parsing.
    const autoPlayed = parseCodingPlanQuotaResetAutoPlayedBroadcastMessage(msg);
    if (autoPlayed) {
      useStore.setState((state) => applyCodingPlanQuotaResetAutoPlayedBroadcast(state, autoPlayed));
      return;
    }

    if (!msg.channel.startsWith(STATE_CHANNEL_PREFIX)) return;

    const field = msg.channel.slice(STATE_CHANNEL_PREFIX.length) as BroadcastField;
    if (!BROADCAST_FIELDS.has(field)) return;

    applyingBroadcast = true;
    try {
      // Call the corresponding setter so side effects (localStorage, DOM) also run.
      const state = useStore.getState();
      if (field === "theme" && typeof msg.payload === "string") {
        // Normalize through the migration function to support legacy window-broadcast values such as zai-dark.
        state.setTheme(migrateThemeSelection(msg.payload, null).mode);
      } else if (field === "palette" && isThemePalette(msg.payload)) {
        state.setPalette(msg.payload);
      } else if (field === "locale" && typeof msg.payload === "string") {
        state.setLocale(msg.payload);
      } else if (
        field === "interfaceMode" &&
        (msg.payload === "office" || msg.payload === "coding")
      ) {
        state.setInterfaceMode(normalizeInterfaceMode(msg.payload));
      } else if (field === "uiFontSizePx" && typeof msg.payload === "number") {
        state.setUiFontSizePx(msg.payload);
      } else if (field === "notificationEnabled" && typeof msg.payload === "boolean") {
        state.setNotificationEnabled(msg.payload);
      } else if (field === "hideProjectDeviceNames" && typeof msg.payload === "boolean") {
        state.setHideProjectDeviceNames(msg.payload);
      } else if (applyFontPreferencesBroadcast(state, msg, field)) {
        // Handled by the font-preferences slice.
      }
    } finally {
      applyingBroadcast = false;
    }
  });

  syncSystemThemeListener(useStore.getState().theme);
  applyTheme(useStore.getState().theme, useStore.getState().palette);
  applyUiFontSizePx(useStore.getState().uiFontSizePx);
  applyPersistedFontPreferences(useStore.getState());
}
