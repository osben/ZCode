import type { ZCodeProviderAccountAccess } from "@zcode/shared";
import type { AiSdkAccountAccess } from "./runner-runtime.js";

/**
 * Read the zhipu account mode; ChatGPT plan (SIWC) account access carries no mode and no
 * zhipu-specific semantics, so it reports undefined everywhere a mode is inspected.
 */
export function zhipuAccountMode(
  access: AiSdkAccountAccess | undefined,
): ZCodeProviderAccountAccess["mode"] | undefined {
  return access?.type === "zhipu-account" ? access.mode : undefined;
}
