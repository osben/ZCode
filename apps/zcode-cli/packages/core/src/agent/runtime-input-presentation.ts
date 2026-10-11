import { parseRuntimeInputPresentation } from "@zcode/contracts";
import type { RuntimeMessageMetadata } from "./message-history.js";

/** The new marker determines the real input identity; do not let the coordinator inherit real_user from a guide. */
export function runtimeInputMetadata(value: unknown): RuntimeMessageMetadata | undefined {
  const inputPresentation = parseRuntimeInputPresentation(value);
  if (!inputPresentation) return undefined;
  return {
    source: inputPresentation === "user_steer" ? "real_user" : "legacy_synthetic",
    inputPresentation,
  };
}
